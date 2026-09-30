/**
 * Natural-groups semantic presence (N0).
 * Maps agent-run events into stable work states the room can show without
 * exposing tool spam or a stuck generic "Thinking" label.
 */

import type { AgentEvent } from "./contracts";
import { getToolUiMeta } from "./tools";

/** Canonical semantic states for a group member's live work. */
export type GroupSemanticState =
  | "queued"
  | "thinking"
  | "exploring"
  | "running_tool"
  | "waiting_for_agent"
  | "reviewing"
  | "writing"
  | "blocked"
  | "done";

/** Natural labels shown in the primary room (English, like other statuses). */
export const GROUP_SEMANTIC_LABEL: Record<GroupSemanticState, string> = {
  queued: "Queued",
  thinking: "Thinking",
  exploring: "Exploring",
  running_tool: "Working",
  waiting_for_agent: "Waiting",
  reviewing: "Reviewing",
  writing: "Writing",
  blocked: "Waiting for you",
  done: "Done",
};

/** Heartbeat / progress snapshot for one member turn (overlay; not a GroupMessage). */
export type GroupSemanticPresence = {
  state: GroupSemanticState;
  /** Room-facing label (Exploring / Implementing / …). */
  label: string;
  /** Epoch ms when this state (or the run) started. */
  startedAt: number;
  /** Epoch ms of the last event that counted as progress. */
  lastProgressAt: number;
  /** Session id or display name the member is waiting on, when known. */
  waitingFor?: string;
  /** Short activity line (tool verb, file hint) — Activity panel detail. */
  activity?: string;
};

const EXPLORE_TOOLS = /^(read|grep|glob|search|list|find|web_search|semantic)/i;
const REVIEW_TOOLS = /^(review|diff|git_diff|blame)/i;
const IMPLEMENT_TOOLS = /^(edit|write|bash|apply|patch|create|delete|mv|cp)/i;

function classifyTool(toolName: string): GroupSemanticState {
  if (REVIEW_TOOLS.test(toolName)) return "reviewing";
  if (EXPLORE_TOOLS.test(toolName)) return "exploring";
  if (IMPLEMENT_TOOLS.test(toolName)) return "running_tool";
  return "running_tool";
}

function toolActivity(toolName: string): string {
  return getToolUiMeta(toolName)?.activeVerb ?? getToolUiMeta(toolName)?.verb ?? toolName;
}

function eventTimeMs(item: { createdAt?: string }, fallback: number): number {
  if (item.createdAt) {
    const ms = Date.parse(item.createdAt);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

/**
 * Fold timed agent events into a semantic presence snapshot.
 * `mode` comes from group.activity (running vs queued).
 */
export function buildGroupSemanticPresence(
  events: readonly { event: AgentEvent; createdAt?: string }[],
  mode: "running" | "queued",
  nowMs = Date.now(),
): GroupSemanticPresence {
  if (mode === "queued") {
    return {
      state: "queued",
      label: GROUP_SEMANTIC_LABEL.queued,
      startedAt: nowMs,
      lastProgressAt: nowMs,
    };
  }

  let state: GroupSemanticState = "thinking";
  let startedAt = 0;
  let lastProgressAt = 0;
  let activity: string | undefined;
  let waitingFor: string | undefined;
  const openTools = new Set<string>();

  for (const item of events) {
    const { event } = item;
    const at = eventTimeMs(item, lastProgressAt || nowMs);
    if (startedAt === 0) startedAt = at;
    lastProgressAt = Math.max(lastProgressAt, at);

    switch (event.type) {
      case "run.started":
        openTools.clear();
        state = "thinking";
        startedAt = at;
        activity = undefined;
        waitingFor = undefined;
        break;
      case "thinking.delta":
        if (openTools.size === 0 && state !== "writing") state = "thinking";
        break;
      case "thinking.completed":
        break;
      case "message.delta":
      case "message.started":
        if (event.type === "message.started" && event.role !== "assistant") break;
        state = "writing";
        activity = "Writing";
        break;
      case "tool.started":
      case "tool.delta": {
        openTools.add(event.toolCallId);
        state = classifyTool(event.toolName);
        activity = toolActivity(event.toolName);
        // Implementing reads as Working/Exploring in the label map; refine label below.
        break;
      }
      case "tool.ended":
        openTools.delete(event.toolCallId);
        if (openTools.size === 0 && state !== "writing") state = "thinking";
        break;
      case "run.blocked":
        state = "blocked";
        activity = "Waiting for you";
        break;
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
        openTools.clear();
        state = "done";
        activity = undefined;
        break;
      default:
        break;
    }
  }

  if (startedAt === 0) startedAt = nowMs;
  if (lastProgressAt === 0) lastProgressAt = startedAt;

  // Natural label: exploring/implementing/reviewing over generic Working.
  let label = GROUP_SEMANTIC_LABEL[state];
  if (state === "running_tool" && activity) {
    const lower = activity.toLowerCase();
    if (/read|search|list|find|explor/.test(lower)) label = "Exploring";
    else if (/edit|writ|patch|bash|run|implement/.test(lower)) label = "Implementing";
    else label = activity;
  }

  return {
    state,
    label,
    startedAt,
    lastProgressAt,
    ...(waitingFor ? { waitingFor } : {}),
    ...(activity ? { activity } : {}),
  };
}

/** True when the room should show "Still working…" instead of repeating the phase. */
export function shouldShowStillWorking(
  presence: GroupSemanticPresence,
  nowMs: number,
  silenceMs: number,
): boolean {
  if (presence.state === "queued" || presence.state === "done" || presence.state === "blocked") {
    return false;
  }
  return nowMs - presence.lastProgressAt >= silenceMs;
}
