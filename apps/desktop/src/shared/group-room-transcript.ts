/**
 * Natural Groups room transcript helpers.
 * Ops packets and typed collab lines stay parseable; the room shows conversation.
 */

import type { GroupCollabStatus } from "./group-collab-status";
import { parseGroupCollabStatusLine } from "./group-collab-status";
import { formatGroupProgressLabel } from "./group-progress-label";
import { groupRoomLabel, groupText } from "./group-room-locale";

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
 * `ready` is ephemeral (avatar / composer) — not a transcript line.
 */
export function formatNaturalCollabStatus(
  status: GroupCollabStatus,
  locale?: string | null,
): string {
  switch (status.kind) {
    case "handoff": {
      const objective = status.objective.trim();
      if (objective) return `@${status.targetName}, ${objective}`;
      return groupText("collab.handoffDefault", locale, { name: status.targetName });
    }
    case "blocked":
      return status.reason.trim()
        ? groupText("collab.blockedWith", locale, { text: status.reason.trim() })
        : groupText("collab.blocked", locale);
    case "proposed":
      return status.summary.trim()
        ? groupText("collab.proposedWith", locale, { text: status.summary.trim() })
        : groupText("collab.proposed", locale);
    case "agreed":
      return status.note.trim()
        ? groupText("collab.agreedWith", locale, { text: status.note.trim() })
        : groupText("collab.agreed", locale);
    case "ready":
      return groupRoomLabel("ready", locale);
  }
}

/**
 * Collab lines shown on the user-facing room transcript.
 *
 * Rule (kind / protocol markers — not string heuristics):
 * - `handoff` → Activity / Group Runtime / peer wake only (orchestration).
 * - `ready` → ephemeral chip / composer — never a lasting transcript row.
 * - `blocked` / `proposed` → remain visible as actionable user-facing states.
 * - `agreed` → hide the protocol summary from the conversational transcript.
 */
export function shouldPersistCollabStatusInTranscript(status: GroupCollabStatus): boolean {
  return status.kind !== "ready" && status.kind !== "handoff" && status.kind !== "agreed";
}

/**
 * True when a room message is orchestration-only (structured handoff) and
 * should not render in the main transcript. Persist/emit for Activity & wake.
 */
export function isOrchestrationOnlyRoomMessage(input: { kind: string; body: string }): boolean {
  if (input.kind === "status") {
    const status = parseGroupCollabStatusLine(input.body);
    return status?.kind === "handoff";
  }
  if (input.kind !== "message" && input.kind !== "") return false;
  const { prose, statuses } = splitRoomMessageBody(input.body);
  if (prose.trim()) return false;
  if (!statuses.some((status) => status.kind === "handoff")) return false;
  return statuses.every((status) => status.kind === "handoff" || status.kind === "ready");
}

/**
 * Strip redundant self-intros ("Aqui é o @Planner", "Here is @Builder…") —
 * avatar, name, and role already identify the speaker.
 */
export function stripAgentSelfIntro(prose: string): string {
  const text = prose.replace(/^\s+|\s+$/gu, "");
  if (!text) return text;
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const intro =
    /^(?:aqui\s+(?:é|e)\s+o|here(?:'s|\s+is)|i(?:'m|\s+am)|this\s+is)\s+@?[^\s,:.!?—–-]+(?:\s*[—–,:!.-]+\s*|\s+)/iu;
  if (!intro.test(first.trim())) return text;
  const restFirst = first.trim().replace(intro, "").trim();
  const next = [restFirst, ...lines.slice(1)].filter((line, index) => Boolean(line) || index > 0);
  return next.join("\n").replace(/^\s+|\s+$/gu, "");
}

/** Extract http(s) URLs that are useful as Prompt Kit Source chips on the final reply. */
export function extractUsefulSources(prose: string): { href: string; label: string }[] {
  const found: { href: string; label: string }[] = [];
  const seen = new Set<string>();
  const re = /\bhttps?:\/\/[^\s)\]>'"]+/gi;
  for (const match of prose.matchAll(re)) {
    let href = match[0] ?? "";
    href = href.replace(/[.,;:!?)]+$/u, "");
    if (!href || seen.has(href)) continue;
    // Skip internal / localhost noise — only user-useful references.
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0|file:\/\//i.test(href)) continue;
    seen.add(href);
    let label = href;
    try {
      label = new URL(href).hostname.replace(/^www\./, "");
    } catch {
      // keep raw
    }
    found.push({ href, label });
    if (found.length >= 5) break;
  }
  return found;
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
 * Living inline Thinking State under the agent name.
 * Ephemeral — replaced by streamed writing as soon as tokens arrive.
 * Labels follow the current app/renderer locale; queued rows include age.
 */
export function inlineLiveStatusLabel(input: {
  phase: string;
  presenceState?: string;
  activity?: string | undefined;
  waitingFor?: string | undefined;
  stillWorking?: boolean;
  startedAt?: number | undefined;
  nowMs?: number | undefined;
  locale?: string | null;
}): string {
  return formatGroupProgressLabel(input);
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
