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
      let id = ids.get(event.messageId);
      if (!id) {
        id = ids.size === 0 ? wake.messageId : randomUUID();
        ids.set(event.messageId, id);
        if (id !== wake.messageId)
          this.emit(
            appendGroupMessage({
              id,
              groupId: wake.groupId,
              authorKind: "agent",
              authorSessionId: wake.sessionId,
              replyToMessageId: wake.triggerMessageId,
              chainId: wake.chainId,
              turnId: wake.id,
              ...(wake.runId ? { runId: wake.runId } : {}),
              sdkMessageId: event.messageId,
              body: "",
              status: "writing",
            }),
          );
        else this.patch(id, { sdkMessageId: event.messageId, status: "writing" });
      }
      this.text.set(id, (this.text.get(id) ?? getGroupMessage(id)?.body ?? "") + event.delta);
      this.pending.add(id);
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), 50);
        this.timer.unref?.();
      }
    } else if (event.type === "message.completed") {
      const id = wake.publicMessageIds?.get(event.messageId);
      if (id) {
        this.flush();
        this.patch(id, { status: "completed" });
      }
    }
  }

  setState(wake: Wake, status: GroupMessageStatus, error?: string): void {
    this.flush();
    if (!wake.id) return;
    const messages = listGroupTurnMessages(wake.id);
    for (const message of messages) {
      // Earlier public messages remain delivered; the last card carries turn outcome.
      if (message.status === "completed" && message !== messages.at(-1)) continue;
      this.patch(message.id, { status, ...(error ? { error } : {}) });
    }
    if (["completed", "failed", "cancelled", "interrupted", "awaiting_user"].includes(status)) {
      for (const message of messages) this.text.delete(message.id);
    }
  }

  finish(wake: Wake, result: PromptTurnResult): GroupMessage[] {
    this.flush();
    if (!wake.id || !wake.messageId) return [];
    const messages = listGroupTurnMessages(wake.id);
    const last = messages.at(-1);
    if (result.finalText?.trim() && last && !wake.cancelled)
      this.patch(last.id, { body: result.finalText.trim() });
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
      this.text.delete(message.id);
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
  }

  private patch(id: string, patch: Parameters<typeof updateGroupMessage>[1]): void {
    const updated = updateGroupMessage(id, patch);
    if (updated) this.emit(updated);
  }
}
