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

/** In-transcript live snapshot for one running/queued group member (not persisted). */
export type GroupLiveTurnSnapshot = {
  phase: GroupMemberWorkingPhase;
  /** Latest thinking text (truncated for the room). */
  thoughtPreview: string;
  /** Recent tools (oldest → newest; capped) — Activity detail; room shows phase. */
  tools: readonly GroupLiveToolLine[];
  /** Latest assistant text being written (truncated). */
  writingPreview: string;
  /** Epoch ms of the last event that updated this snapshot (0 if none). */
  lastEventAt: number;
  /**
   * True after `run.completed` (or failed/cancelled/blocked): hide writing
   * previews so the fold collapses before the strip leaves the room.
   */
  collapsed: boolean;
  /** Semantic heartbeat (startedAt / lastProgressAt / activity). */
  presence: GroupSemanticPresence;
};

const PREVIEW_MAX = 160;
const TOOLS_MAX = 4;

/** After this silence while still `running`, the UI shows "Still working…". */
export const STILL_WORKING_AFTER_MS = 8_000;

function truncate(text: string, max = PREVIEW_MAX): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function toolLabel(name: string): string {
  return getToolUiMeta(name)?.activeVerb ?? getToolUiMeta(name)?.verb ?? name;
}

/**
 * Fold agent events into a compact live turn for the group room.
 * Semantic phase labels (N0) + collapse-on-complete (P0a).
 */
export function buildGroupLiveTurn(
  events: readonly { event: AgentEvent; createdAt?: string }[],
  mode: "running" | "queued",
): GroupLiveTurnSnapshot {
  const presence = buildGroupSemanticPresence(events, mode);
  if (mode === "queued") {
    return {
      phase: presence.label,
      thoughtPreview: "",
      tools: [],
      writingPreview: "",
      lastEventAt: 0,
      collapsed: false,
      presence,
    };
  }

  let thought = "";
  let writing = "";
  const tools = new Map<string, GroupLiveToolLine>();
  let lastEventAt = presence.lastProgressAt > 0 ? presence.lastProgressAt : 0;
  let collapsed = false;
  let terminalPhase: GroupMemberWorkingPhase | undefined;

  for (const item of events) {
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
      case "message.delta":
        writing += event.delta;
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
        const prev = tools.get(event.toolCallId);
        const name = event.toolName ?? prev?.name ?? "tool";
        tools.set(event.toolCallId, {
          id: event.toolCallId,
          name,
          label: toolLabel(name),
          done: true,
        });
        break;
      }
      case "run.started":
        thought = "";
        writing = "";
        tools.clear();
        collapsed = false;
        terminalPhase = undefined;
        break;
      case "run.completed":
        collapsed = true;
        terminalPhase = "Done";
        break;
      case "run.failed":
        collapsed = true;
        terminalPhase = "Failed";
        break;
      case "run.cancelled":
        collapsed = true;
        terminalPhase = "Stopped";
        break;
      case "run.blocked":
        collapsed = true;
        terminalPhase = "Waiting for you";
        break;
      default:
        break;
    }
  }

  const phase = terminalPhase ?? presence.label;
  const toolList = [...tools.values()];
  const recentTools = toolList.length > TOOLS_MAX ? toolList.slice(-TOOLS_MAX) : toolList;

  if (collapsed) {
    return {
      phase,
      thoughtPreview: "",
      tools: [],
      writingPreview: "",
      lastEventAt: lastEventAt || presence.lastProgressAt,
      collapsed: true,
      presence,
    };
  }

  return {
    phase,
    thoughtPreview: truncate(thought),
    tools: recentTools,
    writingPreview: truncate(writing),
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
