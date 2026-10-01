import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupMessage, GroupRuntimeEvent } from "../../../../shared/contracts";

export const GROUP_MESSAGE_PAGE = 50;

function compareMessages(a: GroupMessage, b: GroupMessage): number {
  if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence)
    return a.sequence - b.sequence;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Upsert canonical cards by identity, ignoring older revisions and retaining placement. */
export function mergeGroupMessages(
  current: readonly GroupMessage[],
  incoming: readonly GroupMessage[],
): GroupMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  let changed = false;
  for (const message of incoming) {
    const previous = byId.get(message.id);
    if (previous) {
      const previousRevision = previous.updatedAt ?? previous.createdAt;
      const nextRevision = message.updatedAt ?? message.createdAt;
      if (
        nextRevision < previousRevision ||
        (previous.updatedAt !== undefined && nextRevision === previousRevision)
      )
        continue;
      const update = {
        ...message,
        createdAt: previous.createdAt,
        ...(previous.sequence !== undefined ? { sequence: previous.sequence } : {}),
      };
      if (JSON.stringify(update) === JSON.stringify(previous)) continue;
      byId.set(message.id, update);
    } else byId.set(message.id, message);
    changed = true;
  }
  if (!changed) return current as GroupMessage[];
  return [...byId.values()].sort(compareMessages);
}

export type GroupMessagesState = {
  messages: GroupMessage[];
  loaded: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  error: string | undefined;
  loadOlder(): Promise<void>;
};

export function useGroupMessages(groupId: string): GroupMessagesState {
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const generation = useRef(0);
  const loadingRef = useRef(false);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    const active = () => generation.current === requestGeneration;
    loadingRef.current = false;
    messagesRef.current = [];
    setMessages([]);
    setLoaded(false);
    setHasOlder(false);
    setLoadingOlder(false);
    setError(undefined);
    const belongs = (message: GroupMessage) => message.groupId === groupId;
    const queued = new Map<string, GroupMessage>();
    let frame: number | undefined;
    const takeQueued = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      const incoming = [...queued.values()];
      queued.clear();
      return incoming;
    };
    const unsubscribe = window.modus.group.onEvent((event: GroupRuntimeEvent) => {
      if (
        !active() ||
        event.type !== "group.message" ||
        event.groupId !== groupId ||
        !belongs(event.message)
      )
        return;
      const previous = queued.get(event.message.id);
      if (
        !previous ||
        (event.message.updatedAt ?? event.message.createdAt) >
          (previous.updatedAt ?? previous.createdAt)
      )
        queued.set(event.message.id, event.message);
      if (frame === undefined)
        frame = requestAnimationFrame(() => {
          const incoming = takeQueued();
          if (active()) setMessages((current) => mergeGroupMessages(current, incoming));
        });
    });
    void window.modus.group
      .listMessages({ groupId, limit: GROUP_MESSAGE_PAGE })
      .then((page: GroupMessage[]) => {
        if (!active()) return;
        const ownPage = page.filter(belongs);
        const live = takeQueued();
        setMessages((current) => mergeGroupMessages(mergeGroupMessages(current, ownPage), live));
        setHasOlder(ownPage.length >= GROUP_MESSAGE_PAGE);
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (!active()) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoaded(true);
      });
    return () => {
      generation.current++;
      takeQueued();
      unsubscribe();
    };
  }, [groupId]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const oldest = messagesRef.current[0];
    if (!oldest || oldest.groupId !== groupId || loadingRef.current) return;
    const requestGeneration = generation.current;
    const active = () => generation.current === requestGeneration;
    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await window.modus.group.listMessages({
        groupId,
        before: { createdAt: oldest.createdAt, id: oldest.id },
        limit: GROUP_MESSAGE_PAGE,
      });
      if (!active()) return;
      const ownPage = page.filter((message: GroupMessage) => message.groupId === groupId);
      setMessages((current) => mergeGroupMessages(current, ownPage));
      setHasOlder(ownPage.length >= GROUP_MESSAGE_PAGE);
    } catch (cause) {
      if (active()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (active()) {
        loadingRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [groupId]);

  return { messages, loaded, hasOlder, loadingOlder, error, loadOlder };
}
