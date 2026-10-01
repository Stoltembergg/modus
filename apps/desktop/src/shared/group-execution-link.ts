/**
 * Agent Groups execution linking (goal item 4).
 *
 * An **execution** spans one user ask through completion: messages, tasks,
 * decisions, and turn results share the same id. We reuse the existing chain
 * root (`chainId` / opener message id) — it already spans ask → completion.
 * Per-member jobs (`turnId` / `group_jobs.id`) stay separate for resume (item 2).
 */

export type { GroupExecutionMode } from "./contracts";

/** Resolve the linking id for a room message (chain root). */
export function messageExecutionId(message: { id: string; chainId?: string | undefined }): string {
  return message.chainId ?? message.id;
}

/** Short chip label: optional title, else first 8 chars of the id. */
export function shortExecutionLabel(executionId: string, title?: string | undefined): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed.length > 40 ? `${trimmed.slice(0, 37)}…` : trimmed;
  return executionId.slice(0, 8);
}

/**
 * Newest-first scan for the active execution (latest user message chain).
 * Used by Complementar when the composer does not pass an explicit id.
 */
export function latestExecutionId(
  messages: readonly { id: string; authorKind: string; chainId?: string | undefined }[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.authorKind !== "user") continue;
    return messageExecutionId(message);
  }
  return undefined;
}

/** Keep messages that belong to `executionId` (chronological order preserved). */
export function filterMessagesByExecution<T extends { id: string; chainId?: string | undefined }>(
  messages: readonly T[],
  executionId: string | undefined,
): T[] {
  if (!executionId) return [...messages];
  return messages.filter((message) => messageExecutionId(message) === executionId);
}

/* ── Session bind (main process: wake ↔ tools) ─────────────────────────── */

const sessionExecutions = new Map<string, string>();

/** Bind the running member turn to its ask-spanning execution id. */
export function bindSessionExecution(sessionId: string, executionId: string): void {
  sessionExecutions.set(sessionId, executionId);
}

export function unbindSessionExecution(sessionId: string): void {
  sessionExecutions.delete(sessionId);
}

export function sessionExecutionId(sessionId: string): string | undefined {
  return sessionExecutions.get(sessionId);
}

/** Test / dispose helper. */
export function clearSessionExecutions(): void {
  sessionExecutions.clear();
}
