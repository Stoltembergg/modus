/**
 * Natural Groups room transcript helpers.
 * Ops packets and typed collab lines stay parseable; the room shows conversation.
 */

import type { GroupCollabStatus } from "./group-collab-status";
import { parseGroupCollabStatusLine } from "./group-collab-status";

/** Rigid handoff-packet keys moved out of the main timeline into Activity/Details. */
export const HANDOFF_PACKET_KEYS = [
  "Owner",
  "Objective",
  "Inputs",
  "Deliverable",
  "Constraints",
  "Approval",
] as const;

export type HandoffPacketKey = (typeof HANDOFF_PACKET_KEYS)[number];

export type HandoffPacketField = { key: HandoffPacketKey; value: string };

const PACKET_LINE_RE = /^(Owner|Objective|Inputs|Deliverable|Constraints|Approval)\s*:\s*(.*)$/i;

const PACKET_KEY_BY_LOWER: Record<string, HandoffPacketKey> = {
  owner: "Owner",
  objective: "Objective",
  inputs: "Inputs",
  deliverable: "Deliverable",
  constraints: "Constraints",
  approval: "Approval",
};

/** True when a line is a handoff-packet field (Owner / Objective / …). */
export function isHandoffPacketLine(line: string): boolean {
  return PACKET_LINE_RE.test(line.trim());
}

/** Parse one handoff-packet line, or undefined. */
export function parseHandoffPacketLine(line: string): HandoffPacketField | undefined {
  const match = PACKET_LINE_RE.exec(line.trim());
  if (!match) return undefined;
  const rawKey = (match[1] ?? "").toLocaleLowerCase();
  const key = PACKET_KEY_BY_LOWER[rawKey];
  if (!key) return undefined;
  return { key, value: (match[2] ?? "").trim() };
}

/**
 * Split a room message body into conversational prose, trailing collab
 * statuses, and ops packet fields (hidden from the main timeline).
 */
export function splitRoomMessageBody(body: string): {
  prose: string;
  statuses: GroupCollabStatus[];
  details: HandoffPacketField[];
} {
  const lines = body.split("\n");
  const statuses: GroupCollabStatus[] = [];
  while (lines.length > 0) {
    const parsed = parseGroupCollabStatusLine(lines[lines.length - 1] ?? "");
    if (!parsed) break;
    statuses.unshift(parsed);
    lines.pop();
  }

  const details: HandoffPacketField[] = [];
  const proseLines: string[] = [];
  for (const line of lines) {
    const field = parseHandoffPacketLine(line);
    if (field) {
      details.push(field);
      continue;
    }
    proseLines.push(line);
  }

  return {
    prose: proseLines.join("\n").replace(/^\s+|\s+$/gu, ""),
    statuses,
    details,
  };
}

/** Collect ops packet fields from many messages (oldest → newest). */
export function collectRoomMessageDetails(
  messages: readonly { body: string }[],
): HandoffPacketField[] {
  const found: HandoffPacketField[] = [];
  for (const message of messages) {
    found.push(...splitRoomMessageBody(message.body).details);
  }
  return found;
}

/**
 * Natural handoff / agree phrases for the room (hide typed prefixes and IDs).
 * Structured lines remain in the body for parsers; this is display-only.
 */
export function formatNaturalCollabStatus(status: GroupCollabStatus): string {
  switch (status.kind) {
    case "handoff": {
      const objective = status.objective.trim();
      if (objective) return `@${status.targetName}, ${objective}`;
      return `@${status.targetName}, please take this from here.`;
    }
    case "blocked":
      return status.reason.trim() ? `Blocked — ${status.reason.trim()}` : "Blocked";
    case "proposed":
      return status.summary.trim() ? `Proposed — ${status.summary.trim()}` : "Proposed";
    case "agreed":
      return status.note.trim() ? `Agreed — ${status.note.trim()}` : "Agreed";
    case "ready":
      return "Ready for you";
  }
}

/** Visual tone for light differentiation (no heavy cards). */
export type RoomMessageTone = "normal" | "temporary" | "ask" | "block";

export function collabStatusTone(status: GroupCollabStatus): RoomMessageTone {
  switch (status.kind) {
    case "blocked":
      return "block";
    case "ready":
      return "ask";
    case "handoff":
    case "proposed":
    case "agreed":
      return "normal";
  }
}

/**
 * Living inline status inside an in-flight agent message.
 * Replaced by streamed writing as soon as tokens arrive.
 */
export function inlineLiveStatusLabel(input: {
  phase: string;
  presenceState?: string;
  activity?: string | undefined;
  waitingFor?: string | undefined;
  stillWorking?: boolean;
}): string {
  if (input.stillWorking) return "Still working…";

  const waitingFor = input.waitingFor?.trim();
  if (input.presenceState === "waiting_for_agent" || /^waiting$/i.test(input.phase)) {
    if (waitingFor) {
      const name = waitingFor.replace(/^@/, "");
      return `Waiting for @${name}…`;
    }
    return "Waiting…";
  }

  const activity = (input.activity ?? "").toLocaleLowerCase();
  if (/test|vitest|jest|pytest|spec/.test(activity) || /test/i.test(input.phase)) {
    return "Running tests…";
  }
  if (input.presenceState === "exploring" || /^explor/i.test(input.phase)) {
    return "Exploring…";
  }
  if (input.presenceState === "reviewing" || /^review/i.test(input.phase)) {
    return "Reviewing…";
  }
  if (
    input.presenceState === "running_tool" ||
    /^implement/i.test(input.phase) ||
    /^working$/i.test(input.phase)
  ) {
    if (/read|search|list|find|grep|glob/.test(activity)) return "Exploring…";
    if (/edit|writ|patch|bash|run|implement/.test(activity)) return "Implementing…";
    return activity ? `${capitalizeVerb(activity)}…` : "Working…";
  }
  if (input.presenceState === "writing" || /^writ/i.test(input.phase)) {
    return "Writing…";
  }
  if (input.presenceState === "queued" || /^queued$/i.test(input.phase)) {
    return "Queued…";
  }
  if (input.presenceState === "blocked" || /waiting for you/i.test(input.phase)) {
    return "Waiting for you…";
  }

  const phase = input.phase.trim();
  if (!phase) return "Thinking…";
  return /…$|\.\.\.$/.test(phase) ? phase : `${phase}…`;
}

function capitalizeVerb(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "Working";
  return trimmed.charAt(0).toLocaleUpperCase() + trimmed.slice(1);
}

/** Auto-follow only when the user is already near the bottom. */
export const ROOM_SCROLL_NEAR_BOTTOM_PX = 48;

export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  thresholdPx = ROOM_SCROLL_NEAR_BOTTOM_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < thresholdPx;
}

type ReconcileMessage = {
  authorKind: string;
  authorSessionId?: string | null | undefined;
  kind: string;
  body: string;
};

/**
 * True when a persisted agent message already covers this in-flight stream
 * (exact match, persist extends stream, or stream was a prefix of persist).
 * Used to drop the live GroupMessageRow without a duplicate flash.
 */
export function isLiveStreamReconciled(
  sessionId: string,
  streamText: string,
  messages: readonly ReconcileMessage[],
): boolean {
  const text = streamText.trim();
  if (!text) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.authorKind !== "agent" || message.kind !== "message") continue;
    if (message.authorSessionId !== sessionId) continue;
    const { prose } = splitRoomMessageBody(message.body);
    const persisted = prose.trim();
    if (!persisted) continue;
    if (persisted === text || persisted.startsWith(text) || text.startsWith(persisted)) {
      return true;
    }
    // Newest agent message from this member is a different turn — keep streaming.
    return false;
  }
  return false;
}

/**
 * Whether an in-flight row should stay on the timeline.
 * Status-only rows hide once the member leaves working; streamed rows linger
 * until persist reconcile (or collapse with empty text).
 */
export function shouldShowInFlightRow(input: {
  sessionId: string;
  streamText: string;
  collapsed: boolean;
  stillWorking: boolean;
  messages: readonly ReconcileMessage[];
}): boolean {
  const text = input.streamText.trim();
  if (isLiveStreamReconciled(input.sessionId, text, input.messages)) return false;
  if (input.stillWorking) return true;
  // Linger streamed text after the run ends until persist reconcile.
  void input.collapsed;
  return Boolean(text);
}
