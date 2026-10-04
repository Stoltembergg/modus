/**
 * Agent Groups error codes and their wire format across IPC.
 *
 * Electron only carries `message` from an error thrown in an `ipcMain.handle`
 * listener (custom properties such as `code` are dropped), so the group IPC
 * layer serializes the code as a `[group-error:<code>]` prefix in the message
 * and the renderer parses it back. Shared so both sides agree on the format.
 */

export const GROUP_ERROR_CODES = [
  "group-not-found",
  "workspace-not-found",
  "session-not-found",
  "message-not-found",
  "task-not-found",
  "decision-not-found",
  "workspace-mismatch",
  "already-in-group",
  "subagent-session",
  "archived-session",
  "not-a-member",
  "invalid-value",
  // Member task tools (transition rules enforced by the store).
  "not-owner",
  "not-reviewer",
  "task-taken",
  "invalid-transition",
  "verification-required",
  "stale-task",
  "dependency-cycle",
  "invalid-dependency",
  "stale-evidence",
  "self-review",
  "ambiguous-member",
  // Member worktrees: the group has no Project, or its Project is not a Git repository.
  "no-git-project",
  // The member branch is checked out outside .modus/worktrees (e.g. the Project root).
  "branch-checked-out",
  // group_start_worktree was not the only tool call of its message.
  "call-alone",
  // group_record_decision: text empty after trim or over 500 characters.
  "invalid-text",
  // group_record_decision: the group already has 100 decisions.
  "limit-reached",
  // group_assign_task (coordinator mode): the caller is not the group's Lead.
  "not-coordinator",
  // group_assign_task: coordinator mode is off, or the group has no Lead.
  "coordinator-off",
  // Agents store: no agent with that id / another agent already has that name.
  "agent-not-found",
  "agent-name-taken",
  "agent-avatar-shape-taken",
  // The group has no Project (null or the Chats inbox): creating/moving it there, or
  // sending / waking / assigning in it until a folder is chosen (see groupNeedsProject).
  "group-project-required",
  // group_assign_task: the assignee's agent is archived (it stays a member, never woken).
  "member-archived",
  // A group has 2..10 member agents (shared/group-blocked.ts): fewer than 2 on create
  // or removal, and while blocked with one member; more than 10 on create or add.
  "group-min-members",
  "group-max-members",
  // agents:create / agents:update without a template: a model is required and must
  // belong to a configured provider.
  "agent-model-required",
  "agent-model-unavailable",
] as const;

export type GroupErrorCode = (typeof GROUP_ERROR_CODES)[number];

const PREFIX = /\[group-error:([a-z-]+)\]\s*/;

export function isGroupErrorCode(value: unknown): value is GroupErrorCode {
  return typeof value === "string" && (GROUP_ERROR_CODES as readonly string[]).includes(value);
}

/** Message sent over IPC: `[group-error:<code>] <message>`. */
export function encodeGroupErrorMessage(code: GroupErrorCode, message: string): string {
  return `[group-error:${code}] ${message}`;
}

/**
 * Recovers `{ code, message }` from an error or message that crossed IPC
 * (tolerates Electron's "Error invoking remote method 'x': Error: " prefix).
 * `code` is undefined when the text carries no known group error code.
 */
export function decodeGroupErrorMessage(input: unknown): {
  code: GroupErrorCode | undefined;
  message: string;
} {
  const text = input instanceof Error ? input.message : String(input);
  const match = PREFIX.exec(text);
  const code = match && isGroupErrorCode(match[1]) ? match[1] : undefined;
  const message = (match ? text.slice((match.index ?? 0) + match[0].length) : text).replace(
    /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
    "",
  );
  return { code, message };
}
