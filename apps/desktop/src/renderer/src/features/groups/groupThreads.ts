import type { GroupMessage } from "../../../../shared/contracts";

/** One root message plus its direct replies (secondary discussion / review). */
export type GroupThread = {
  root: GroupMessage;
  replies: GroupMessage[];
};

/**
 * Fold a chronological message list into roots + nested replies.
 * Only direct `replyToMessageId` edges are nested; deeper replies flatten
 * under the same root so the main timeline stays shallow.
 */
export function buildGroupThreads(messages: readonly GroupMessage[]): GroupThread[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const children = new Map<string, GroupMessage[]>();
  const roots: GroupMessage[] = [];

  for (const message of messages) {
    const parentId = message.replyToMessageId;
    if (parentId && byId.has(parentId)) {
      const list = children.get(parentId) ?? [];
      list.push(message);
      children.set(parentId, list);
    } else {
      roots.push(message);
    }
  }

  return roots.map((root) => ({
    root,
    replies: collectReplies(root.id, children),
  }));
}

function collectReplies(
  rootId: string,
  children: ReadonlyMap<string, GroupMessage[]>,
): GroupMessage[] {
  const out: GroupMessage[] = [];
  const queue = [...(children.get(rootId) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    out.push(next);
    const nested = children.get(next.id);
    if (nested) queue.push(...nested);
  }
  return out;
}

/** Preview line for the composer reply chip. */
export function replyPreview(body: string, max = 72): string {
  const trimmed = body.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
