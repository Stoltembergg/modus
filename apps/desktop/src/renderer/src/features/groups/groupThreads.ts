import type { GroupMessage } from "../../../../shared/contracts";

/** One root message plus its direct replies (secondary discussion / review). */
export type GroupThread = {
  root: GroupMessage;
  replies: GroupMessage[];
};

/**
 * Compatibility shape for callers that previously grouped replies. Each public
 * message keeps its canonical position; reply links are rendered as quotes.
 */
export function buildGroupThreads(messages: readonly GroupMessage[]): GroupThread[] {
  return messages.map((root) => ({ root, replies: [] }));
}

/** Preview line for the composer reply chip. */
export function replyPreview(body: string, max = 72): string {
  const trimmed = body.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
