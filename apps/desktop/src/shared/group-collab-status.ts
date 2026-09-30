/**
 * Typed collaboration status lines for group rooms (P0b).
 * Stable English prefixes on message/status bodies — no schema change required.
 *
 *   Handoff → @Name · <objective>
 *   Blocked · <reason>
 *   Proposed · <summary>
 *   Agreed  |  Agreed · <note>
 *   Ready for you
 */

export type GroupCollabStatusKind = "handoff" | "blocked" | "proposed" | "agreed" | "ready";

export type GroupCollabStatus =
  | { kind: "handoff"; targetName: string; objective: string }
  | { kind: "blocked"; reason: string }
  | { kind: "proposed"; summary: string }
  | { kind: "agreed"; note: string }
  | { kind: "ready" };

/** Stage chip labels shown in the room header. */
export type GroupCollabStage = "Handoff" | "Review" | "Agree" | "Ready";

export const GROUP_COLLAB_NO_NEXT_OWNER = "No next owner — @mention someone or propose agreement";

const HANDOFF_RE = /^Handoff\s*→\s*@([^\s·]+)(?:\s*·\s*(.*))?$/i;
const BLOCKED_RE = /^Blocked\s*·\s*(.+)$/i;
const PROPOSED_RE = /^Proposed\s*·\s*(.+)$/i;
const AGREED_RE = /^Agreed(?:\s*·\s*(.*))?$/i;
const READY_RE = /^Ready for you\.?$/i;

/** Format a collab status as the canonical room line. */
export function formatGroupCollabStatus(status: GroupCollabStatus): string {
  switch (status.kind) {
    case "handoff": {
      const objective = status.objective.trim();
      return objective
        ? `Handoff → @${status.targetName} · ${objective}`
        : `Handoff → @${status.targetName}`;
    }
    case "blocked":
      return `Blocked · ${status.reason.trim()}`;
    case "proposed":
      return `Proposed · ${status.summary.trim()}`;
    case "agreed":
      return status.note.trim() ? `Agreed · ${status.note.trim()}` : "Agreed";
    case "ready":
      return "Ready for you";
  }
}

/** Parse one line as a collab status, or undefined if it is not one. */
export function parseGroupCollabStatusLine(line: string): GroupCollabStatus | undefined {
  const text = line.trim();
  if (!text) return undefined;

  const handoff = HANDOFF_RE.exec(text);
  if (handoff) {
    return {
      kind: "handoff",
      targetName: handoff[1] ?? "",
      objective: (handoff[2] ?? "").trim(),
    };
  }
  const blocked = BLOCKED_RE.exec(text);
  if (blocked) return { kind: "blocked", reason: (blocked[1] ?? "").trim() };
  const proposed = PROPOSED_RE.exec(text);
  if (proposed) return { kind: "proposed", summary: (proposed[1] ?? "").trim() };
  const agreed = AGREED_RE.exec(text);
  if (agreed) return { kind: "agreed", note: (agreed[1] ?? "").trim() };
  if (READY_RE.test(text)) return { kind: "ready" };
  return undefined;
}

/** Every collab status line found in a multi-line body (top → bottom). */
export function findGroupCollabStatuses(body: string): GroupCollabStatus[] {
  const found: GroupCollabStatus[] = [];
  for (const line of body.split("\n")) {
    const status = parseGroupCollabStatusLine(line);
    if (status) found.push(status);
  }
  return found;
}

/** Last collab status in the body, if any. */
export function lastGroupCollabStatus(body: string): GroupCollabStatus | undefined {
  const all = findGroupCollabStatuses(body);
  return all.at(-1);
}

/**
 * True when a successful agent reply woke nobody and did not close the loop
 * (Agreed / Blocked / Proposed / Ready). Handoff without a parseable @ still nudges
 * if mentionCount is 0.
 */
export function needsNextOwnerNudge(body: string, mentionCount: number): boolean {
  if (mentionCount > 0) return false;
  const last = lastGroupCollabStatus(body);
  if (!last) return true;
  return last.kind === "handoff";
}

export function stageFromCollabStatus(status: GroupCollabStatus): GroupCollabStage {
  switch (status.kind) {
    case "handoff":
      return "Handoff";
    case "proposed":
    case "blocked":
      return "Review";
    case "agreed":
      return "Agree";
    case "ready":
      return "Ready";
  }
}

export type GroupCollabStageSnapshot = {
  stage: GroupCollabStage;
  /** Session id of the current owner when known. */
  ownerSessionId?: string;
  /** Display name of the handoff target when owner session is unresolved. */
  ownerName?: string;
};

type StageMessage = {
  body: string;
  authorSessionId?: string | undefined;
  mentions?: readonly string[] | undefined;
};

/**
 * Derive the header stage chip from recent room messages (newest last).
 * Prefers the latest collab status line; falls back to Handoff when a member is running.
 */
export function deriveGroupCollabStage(
  messages: readonly StageMessage[],
  options?: {
    runningSessionIds?: readonly string[];
    /** Map member display title → sessionId (case-insensitive). */
    titleToSessionId?: ReadonlyMap<string, string>;
  },
): GroupCollabStageSnapshot | undefined {
  const running = options?.runningSessionIds ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    const status = lastGroupCollabStatus(message.body);
    if (!status) continue;
    const stage = stageFromCollabStatus(status);
    if (status.kind === "handoff") {
      const byTitle = options?.titleToSessionId?.get(status.targetName.toLocaleLowerCase());
      const mentioned = message.mentions?.[0];
      const ownerSessionId = byTitle ?? mentioned;
      return {
        stage,
        ...(ownerSessionId ? { ownerSessionId } : {}),
        ownerName: status.targetName,
      };
    }
    return {
      stage,
      ...(message.authorSessionId ? { ownerSessionId: message.authorSessionId } : {}),
    };
  }
  if (running[0]) {
    return { stage: "Handoff", ownerSessionId: running[0] };
  }
  return undefined;
}

/** Lines added to every group wake prompt (handoff packet + status protocol). */
export const GROUP_COLLAB_WAKE_PROTOCOL = [
  "Collaboration protocol — end your turn with one of these lines (English, exact prefixes):",
  "- Handoff → @Name · <short objective>  (must @mention the next owner)",
  "- Proposed · <summary of what you composed>",
  "- Blocked · <what is blocking>",
  "- Agreed  or  Agreed · <note>",
  "- Ready for you  (human approval before external actions / PRs)",
  "When handing off, include this packet for Activity/Details (the room hides it from the main chat):",
  "Owner: @Name",
  "Objective: …",
  "Inputs: …",
  "Deliverable: …",
  "Constraints: …",
  "Approval: …",
  "Speak naturally in the main reply; keep IDs and task ids out of the conversation.",
  'Do not introduce yourself (avatar, name, and role already identify you — never say "Here is @Name" / "Aqui é o @Name").',
  "Prefer short natural replies. Stay silent (empty reply) when you have nothing useful to add.",
  "Do not explore the workspace, run tools, or start work just to stay busy — only act on a real objective, pending task, handoff, review, or blockage.",
  "If you finish with no @mention and no Agreed/Blocked/Proposed/Ready line, the room will nudge you.",
].join("\n");
