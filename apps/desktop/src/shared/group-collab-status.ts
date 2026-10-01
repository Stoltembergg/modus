/**
 * Legacy collaboration status lines for group room presentation.
 * These prefixes do not authorize delegation; member tools route explicit IDs.
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

const HANDOFF_RE = /^Handoff\s*→\s*@([^·]+?)(?:\s*·\s*(.*))?$/i;
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
    const targetName = (handoff[1] ?? "").trim();
    if (!targetName) return undefined;
    return {
      kind: "handoff",
      targetName,
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
 * Compatibility for older runtime callers. Successful public replies never
 * require a next-owner nudge: task tools decide whether work is delegated.
 */
export function needsNextOwnerNudge(_body: string, _mentionCount: number): boolean {
  return false;
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

export type StageMessage = {
  body: string;
  id?: string | undefined;
  authorKind?: "user" | "agent" | "system" | undefined;
  kind?: "message" | "status" | undefined;
  chainId?: string | undefined;
  status?: string | undefined;
  authorSessionId?: string | undefined;
  mentions?: readonly string[] | undefined;
};

/**
 * Derive the header stage from the current task (newest user message onward).
 * Live member/message state takes precedence over legacy display markers.
 * Older messages without metadata remain readable as legacy status lines.
 */
export function deriveGroupCollabStage(
  messages: readonly StageMessage[],
  options?: {
    runningSessionIds?: readonly string[];
    queuedSessionIds?: readonly string[];
    waitingSessionIds?: readonly string[];
    /** Map member display title → sessionId (case-insensitive). */
    titleToSessionId?: ReadonlyMap<string, string>;
  },
): GroupCollabStageSnapshot | undefined {
  const activeOwner = options?.runningSessionIds?.[0] ?? options?.queuedSessionIds?.[0];
  if (activeOwner) return { stage: "Handoff", ownerSessionId: activeOwner };
  const waitingOwner = options?.waitingSessionIds?.[0];
  if (waitingOwner) return { stage: "Review", ownerSessionId: waitingOwner };

  const taskIndex = messages.findLastIndex((message) => message.authorKind === "user");
  const task = messages[taskIndex];
  const currentChainId = task?.chainId ?? task?.id;
  const currentMessages = messages
    .slice(taskIndex + 1)
    .filter((message) => !currentChainId || !message.chainId || message.chainId === currentChainId);

  for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
    const message = currentMessages[i];
    if (!message || message.authorKind === "system") continue;
    const active =
      message.status === "queued" || message.status === "running" || message.status === "writing";
    if (active || message.status === "awaiting_user") {
      return {
        stage: active ? "Handoff" : "Review",
        ...(message.authorSessionId ? { ownerSessionId: message.authorSessionId } : {}),
      };
    }
  }

  for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
    const message = currentMessages[i];
    if (!message || ["failed", "cancelled", "interrupted"].includes(message.status ?? "")) continue;
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
  return undefined;
}

/** Instructions added to every group wake prompt. */
export const GROUP_COLLAB_WAKE_PROTOCOL = [
  "Collaboration protocol:",
  "Delegate through group_handoff(memberId=<session ID>, objective=<concrete work>) or, as coordinator, group_assign_task(taskId=<task ID>, memberId=<session ID>).",
  "Use group_request_review(id=<task ID>, reviewer=<session ID>) for task review; use group_propose_agreement, group_agree, or group_block to record an agreement or blocker.",
  "Resolve task IDs with group_list_tasks and use member session IDs for unambiguous delegation. Public @mentions are visual references and do not wake peers.",
  "A completed turn can finish naturally in the user's language. No English status marker or next-owner line is required.",
  "Publish concise results, decisions, real blockers, questions, and material progress the user can act on. Keep internal reasoning, self narration, tool logs, and routine status chatter out of public messages.",
  "When you (Lead/Coordinator) finish a task, post one final result card with these lines: Outcome: … / Validations: … / Changed files: … / Open items: … (use bullet lists when there are several).",
  "Include concrete inputs, deliverables, and constraints in task tool arguments. Keep IDs and task IDs in tools rather than repeating them in the conversation.",
  'Do not introduce yourself (avatar, name, and role already identify you — never say "Here is @Name" / "Aqui é o @Name").',
  "Prefer short natural replies. Stay silent (empty reply) when you have nothing useful to add.",
  "Do not explore the workspace, run tools, or start work just to stay busy — only act on a real objective, pending task, handoff, review, or blockage.",
  "Consult the shared project map (project_context / Project Model / CodeGraph via fast_codebase) before broad search; open extra files only on real uncertainty or stale context.",
].join("\n");
