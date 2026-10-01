import type { AgentEvent } from "../../../../shared/contracts";
import {
  buildGroupSemanticPresence,
  type GroupSemanticPresence,
} from "../../../../shared/group-semantic-presence";
import { getToolUiMeta } from "../../../../shared/tools";
import type { GroupMemberWorkingPhase } from "./groupWorkingPhase";

/** Compact tool row shown under a live group member turn. */
export type GroupLiveToolLine = {
  id: string;
  name: string;
  label: string;
  done: boolean;
};

/** Activity snapshot for one running/queued member; public transcript is persisted separately. */
export type GroupLiveTurnSnapshot = {
  phase: GroupMemberWorkingPhase;
  /** Latest thinking text (truncated for Activity). */
  thoughtPreview: string;
  /** Recent tool labels (oldest → newest; capped) for safe room progress and Activity. */
  tools: readonly GroupLiveToolLine[];
  /**
   * Latest assistant message preview, scoped by messageId.
   * Activity only; canonical GroupMessage records own the conversation cards.
   */
  streamText: string;
  /** @deprecated Alias of `streamText` for older call sites. */
  writingPreview: string;
  /** Epoch ms of the last event that updated this snapshot (0 if none). */
  lastEventAt: number;
  /**
   * True after `run.completed` (or failed/cancelled/blocked). Stream text is
   * kept until the room reconciles against the persisted GroupMessage.
   */
  collapsed: boolean;
  /** Semantic heartbeat (startedAt / lastProgressAt / activity). */
  presence: GroupSemanticPresence;
};

/** Thought stays short; stream text keeps a high safety cap (not a UX truncate). */
const THOUGHT_PREVIEW_MAX = 160;
const STREAM_TEXT_MAX = 200_000;
const TOOLS_MAX = 4;

/** After this silence while still `running`, the UI shows "Still working…". */
export const STILL_WORKING_AFTER_MS = 8_000;

function truncate(text: string, max: number, collapseWhitespace: boolean): string {
  const trimmed = collapseWhitespace ? text.replace(/\s+/g, " ").trim() : text.trimEnd();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function toolLabel(name: string): string {
  return getToolUiMeta(name)?.activeVerb ?? getToolUiMeta(name)?.verb ?? name;
}

/**
 * Fold agent events into a compact live turn for the group room.
 * `message.delta` updates the latest public message preview by identity.
 * Thinking / tools are ephemeral: cleared on terminal run events.
 */
export function buildGroupLiveTurn(
  events: readonly { event: AgentEvent; createdAt?: string }[],
  mode: "running" | "queued",
  options?: { nowMs?: number; queuedSinceMs?: number },
): GroupLiveTurnSnapshot {
  const roles = new Map<string, "assistant" | "user">();
  for (const { event } of events) {
    if (event.type === "message.started") roles.set(event.messageId, event.role);
  }
  const publicEvents = events.filter(
    ({ event }) =>
      !(
        "messageId" in event &&
        event.type.startsWith("message.") &&
        roles.get(event.messageId) === "user"
      ),
  );
  const presence = buildGroupSemanticPresence(
    publicEvents,
    mode,
    options?.nowMs ?? Date.now(),
    options?.queuedSinceMs,
  );
  if (mode === "queued") {
    return {
      phase: presence.label,
      thoughtPreview: "",
      tools: [],
      streamText: "",
      writingPreview: "",
      lastEventAt: 0,
      collapsed: false,
      presence,
    };
  }

  let thought = "";
  const writingById = new Map<string, string>();
  let writingMessageId: string | undefined;
  const tools = new Map<string, GroupLiveToolLine>();
  let lastEventAt = presence.lastProgressAt > 0 ? presence.lastProgressAt : 0;
  let collapsed = false;
  let terminalPhase: GroupMemberWorkingPhase | undefined;

  for (const item of publicEvents) {
    const { event } = item;
    if (item.createdAt) {
      const ms = Date.parse(item.createdAt);
      if (Number.isFinite(ms)) lastEventAt = Math.max(lastEventAt, ms);
    } else {
      lastEventAt = Math.max(lastEventAt, 1);
    }

    switch (event.type) {
      case "thinking.delta":
        thought += event.delta;
        break;
      case "thinking.completed":
        break;
      case "message.started":
        if (event.role === "assistant") {
          writingMessageId = event.messageId;
          if (!writingById.has(event.messageId)) writingById.set(event.messageId, "");
        }
        break;
      case "message.delta":
        if (!writingById.has(event.messageId)) writingMessageId = event.messageId;
        writingById.set(event.messageId, (writingById.get(event.messageId) ?? "") + event.delta);
        // Streaming the definitive message — drop finished tools from the room strip.
        for (const [id, tool] of [...tools]) {
          if (tool.done) tools.delete(id);
        }
        break;
      case "tool.started":
      case "tool.delta":
        tools.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          label: toolLabel(event.toolName),
          done: false,
        });
        break;
      case "tool.ended": {
        // Remove completed tools from the room immediately (Activity keeps history elsewhere).
        tools.delete(event.toolCallId);
        break;
      }
      case "run.started":
        thought = "";
        writingById.clear();
        writingMessageId = undefined;
        tools.clear();
        collapsed = false;
        terminalPhase = undefined;
        break;
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
      case "run.blocked":
        // Immediately dismantle every transient for this turn.
        thought = "";
        tools.clear();
        collapsed = true;
        terminalPhase =
          event.type === "run.completed"
            ? "Done"
            : event.type === "run.failed"
              ? "Failed"
              : event.type === "run.cancelled"
                ? "Stopped"
                : "Waiting for you";
        break;
      default:
        break;
    }
  }

  const phase = terminalPhase ?? presence.label;
  const toolList = [...tools.values()];
  const recentTools = toolList.length > TOOLS_MAX ? toolList.slice(-TOOLS_MAX) : toolList;
  const streamText = truncate(
    writingMessageId ? (writingById.get(writingMessageId) ?? "") : "",
    STREAM_TEXT_MAX,
    false,
  );

  if (collapsed) {
    return {
      phase,
      thoughtPreview: "",
      tools: [],
      // Keep streamed text until the room reconciles against persist.
      streamText,
      writingPreview: streamText,
      lastEventAt: lastEventAt || presence.lastProgressAt,
      collapsed: true,
      presence,
    };
  }

  return {
    phase,
    // Room never shows thoughtPreview — Activity panel only.
    thoughtPreview: truncate(thought, THOUGHT_PREVIEW_MAX, true),
    tools: recentTools,
    streamText,
    writingPreview: streamText,
    lastEventAt: lastEventAt || presence.lastProgressAt,
    collapsed: false,
    presence,
  };
}

/** True when a running turn has gone quiet long enough to show "Still working…". */
export function isStillWorking(
  mode: "running" | "queued",
  lastEventAt: number,
  nowMs: number,
  silenceMs = STILL_WORKING_AFTER_MS,
): boolean {
  if (mode !== "running" || lastEventAt <= 0) return false;
  return nowMs - lastEventAt >= silenceMs;
}
