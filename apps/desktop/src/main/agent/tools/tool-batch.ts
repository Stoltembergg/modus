/**
 * How many tool calls the latest assistant message of each session asked for.
 *
 * PI emits `message_end` for an assistant message (awaited, before
 * executeToolCalls runs its tool calls), so while any of those tools executes
 * this holds the size of its own batch. group_start_worktree reads it: PI only
 * honors a tool's `terminate` when EVERY call in the batch sets it, so the
 * tool must be called alone. Process-wide, keyed by Modus session id.
 */
const toolCallsBySession = new Map<string, number>();

/** Records an assistant `message_end` (PiSdkRuntime's session subscriber). */
export function noteAssistantMessageToolCalls(sessionId: string, message: unknown): void {
  if (!message || typeof message !== "object") return;
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "assistant") return;
  const count = Array.isArray(content)
    ? content.filter(
        (block) =>
          Boolean(block) &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "toolCall",
      ).length
    : 0;
  toolCallsBySession.set(sessionId, count);
}

/** Tool calls in the session's latest assistant message; undefined when none was recorded. */
export function lastAssistantToolCallCount(sessionId: string): number | undefined {
  return toolCallsBySession.get(sessionId);
}

/** Forget the session (its SDK session was disposed). */
export function clearAssistantToolCallCount(sessionId: string): void {
  toolCallsBySession.delete(sessionId);
}
