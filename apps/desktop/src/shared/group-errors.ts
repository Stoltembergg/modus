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
  "self-review",
  "ambiguous-member",
  // Member worktrees: the group has no Project, or its Project is not a Git repository.
  "no-git-project",
  // The member branch is checked out outside .modus/worktrees (e.g. the Project root).
  "branch-checked-out",
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
