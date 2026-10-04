import { randomUUID } from "node:crypto";
import type { AgentEvent, GroupMessage, GroupMessageStatus } from "../../shared/contracts";
import type { PromptTurnResult } from "../agent/runtime";
import type { Wake } from "./group-runtime-lib";
import {
  appendGroupMessage,
  getGroupMessage,
  listGroupTurnMessages,
  updateGroupMessage,
} from "./group-store";

/** One canonical public transcript; raw thoughts and user prompt text stay private. */
export class GroupTurnTranscript {
  private readonly text = new Map<string, string>();
  private readonly segments = new Map<string, { prefix: string; messages: Map<string, string> }>();
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly emit: (message: GroupMessage) => void) {}

  create(wake: Wake): void {
    wake.id ??= randomUUID();
    wake.messageId ??= randomUUID();
    wake.publicMessageIds = new Map();
    this.emit(
      appendGroupMessage({
        id: wake.messageId,
        groupId: wake.groupId,
        authorKind: "agent",
        authorSessionId: wake.sessionId,
        replyToMessageId: wake.triggerMessageId,
        chainId: wake.chainId,
        turnId: wake.id,
        body: "",
        status: "queued",
      }),
    );
  }

  observe(wake: Wake, event: AgentEvent): void {
    if (!wake.id || !wake.messageId || wake.cancelled) return;
    if (event.type === "run.started") {
      wake.runId = event.runId;
      this.patch(wake.messageId, { runId: event.runId, status: "running" });
    } else if (event.type === "message.started" && event.role === "assistant") {
      if (!wake.assistantMessageIds) wake.assistantMessageIds = new Set();
      wake.assistantMessageIds.add(event.messageId);
    } else if (event.type === "message.delta") {
      if (!event.delta || !wake.assistantMessageIds?.has(event.messageId)) return;
      if (!wake.publicMessageIds) wake.publicMessageIds = new Map();
      const ids = wake.publicMessageIds;
      // A resumed job from an older version can already have several cards.
      // Append to its last record so the history projection keeps A, B, then C.
      const id =
        ids.values().next().value ?? listGroupTurnMessages(wake.id).at(-1)?.id ?? wake.messageId;
      if (!ids.has(event.messageId)) {
        if (ids.size === 0)
          this.patch(id, {
            sdkMessageId: event.messageId,
            status: "writing",
            ...(wake.runId ? { runId: wake.runId } : {}),
          });
        ids.set(event.messageId, id);
      }
      let segments = this.segments.get(id);
      if (!segments) {
        segments = { prefix: getGroupMessage(id)?.body ?? "", messages: new Map() };
        this.segments.set(id, segments);
      }
      segments.messages.set(
        event.messageId,
        (segments.messages.get(event.messageId) ?? "") + event.delta,
      );
      this.text.set(id, this.compose(segments));
      this.pending.add(id);
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), 50);
        this.timer.unref?.();
      }
    } else if (event.type === "message.completed") {
      const id = wake.publicMessageIds?.get(event.messageId);
      // SDK messages also end before tool calls and harness continuations.
      // The card stays active until the whole group turn settles.
      if (id) this.flush();
    }
  }

  setState(wake: Wake, status: GroupMessageStatus, error?: string): void {
    this.flush();
    if (!wake.id) return;
    const messages = listGroupTurnMessages(wake.id);
    for (const message of messages) {
      // Keep delivered legacy cards; a resumed turn updates its canonical card
      // even when an older app version persisted extra SDK message cards.
      if (
        message.status === "completed" &&
        message !== messages.at(-1) &&
        message.id !== wake.messageId
      )
        continue;
      const errorPatch =
        error !== undefined
          ? { error }
          : status === "failed" || status === "interrupted"
            ? {}
            : { error: null };
      this.patch(message.id, { status, ...errorPatch });
    }
    if (["completed", "failed", "cancelled", "interrupted"].includes(status)) {
      for (const message of messages) {
        this.text.delete(message.id);
        this.segments.delete(message.id);
      }
    }
  }

  finish(wake: Wake, result: PromptTurnResult): GroupMessage[] {
    this.flush();
    if (!wake.id || !wake.messageId) return [];
    const messages = listGroupTurnMessages(wake.id);
    const card = messages.find(
      (message) =>
        message.id === (wake.publicMessageIds?.values().next().value ?? messages.at(-1)?.id),
    );
    if (result.finalText?.trim() && card && !wake.cancelled) {
      const finalText = result.finalText.trim();
      const segments = this.segments.get(card.id);
      const lastSegmentId = segments ? [...segments.messages.keys()].at(-1) : undefined;
      if (segments && lastSegmentId) {
        // The runtime returns the last SDK message, not the entire turn.
        // Reconcile that segment without dropping earlier public progress.
        if (segments.messages.get(lastSegmentId)?.trim() !== finalText)
          segments.messages.set(lastSegmentId, finalText);
        this.patch(card.id, { body: this.compose(segments) });
      } else {
        // A resumed execution may already have durable partial output.
        const prefix = card.body.trimEnd();
        this.patch(card.id, {
          body: prefix && prefix.trim() !== finalText ? `${prefix}\n\n${finalText}` : finalText,
        });
      }
    }
    const status =
      result.outcome === "ok"
        ? "completed"
        : result.outcome === "blocked"
          ? "awaiting_user"
          : result.outcome === "aborted"
            ? "cancelled"
            : "failed";
    this.setState(wake, status, result.error);
    for (const message of messages) {
      if (result.outcome !== "blocked") {
        this.text.delete(message.id);
        this.segments.delete(message.id);
      }
      this.pending.delete(message.id);
    }
    return listGroupTurnMessages(wake.id);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const id of this.pending)
      this.patch(id, { body: this.text.get(id) ?? "", status: "writing" });
    this.pending.clear();
  }

  dispose(): void {
    this.flush();
    this.text.clear();
    this.segments.clear();
  }

  private compose(segments: { prefix: string; messages: Map<string, string> }): string {
    return [segments.prefix, ...segments.messages.values()].filter(Boolean).join("\n\n");
  }

  private patch(id: string, patch: Parameters<typeof updateGroupMessage>[1]): void {
    const updated = updateGroupMessage(id, patch);
    if (updated) this.emit(updated);
  }
}
