import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupMessage, GroupRuntimeEvent } from "../../../../shared/contracts";

/** Room page size (`group:list-messages`). */
export const GROUP_MESSAGE_PAGE = 50;

function compareMessages(a: GroupMessage, b: GroupMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Merge pages / live messages by id, in the store's (createdAt, id) order. */
export function mergeGroupMessages(
  current: readonly GroupMessage[],
  incoming: readonly GroupMessage[],
): GroupMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  let changed = false;
  for (const message of incoming) {
    if (byId.has(message.id)) continue;
    byId.set(message.id, message);
    changed = true;
  }
  if (!changed) return current as GroupMessage[];
  return [...byId.values()].sort(compareMessages);
}

export type GroupMessagesState = {
  messages: GroupMessage[];
  /** The first page arrived (the empty state waits for it). */
  loaded: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  error: string | undefined;
  loadOlder(): Promise<void>;
};

/**
 * The room's messages: the newest page first, older pages on demand (scroll to
 * top), live `group.message` pushes merged in without duplicates.
 */
export function useGroupMessages(groupId: string): GroupMessagesState {
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const loadingRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    setMessages([]);
    setLoaded(false);
    setHasOlder(false);
    setError(undefined);
    const unsubscribe = window.modus.group.onEvent((event: GroupRuntimeEvent) => {
      if (event.type !== "group.message" || event.groupId !== groupId) return;
      setMessages((current) => mergeGroupMessages(current, [event.message]));
    });
    window.modus.group
      .listMessages({ groupId, limit: GROUP_MESSAGE_PAGE })
      .then((page: GroupMessage[]) => {
        if (disposed) return;
        setMessages((current) => mergeGroupMessages(current, page));
        setHasOlder(page.length >= GROUP_MESSAGE_PAGE);
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoaded(true);
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [groupId]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const oldest = messagesRef.current[0];
    if (!oldest || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await window.modus.group.listMessages({
        groupId,
        before: { createdAt: oldest.createdAt, id: oldest.id },
        limit: GROUP_MESSAGE_PAGE,
      });
      setMessages((current) => mergeGroupMessages(current, page));
      setHasOlder(page.length >= GROUP_MESSAGE_PAGE);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [groupId]);

  return { messages, loaded, hasOlder, loadingOlder, error, loadOlder };
}
