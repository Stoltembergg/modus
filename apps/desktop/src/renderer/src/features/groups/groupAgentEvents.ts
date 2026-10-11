import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentEventItem,
  type AgentEventPage,
  foldAgentEvents,
} from "../../../../shared/agent-events";
import type { AgentEvent } from "../../../../shared/contracts";

/** During hydration retain a bounded suffix; a new snapshot covers discarded cursors. */
const HYDRATION_BUFFER_MAX = 512;
const TURN_PARTS_MAX = 512;
const PREVIEW_TEXT_MAX = 200_000;

type EventKind = "working" | "questions";
type SessionEvents = {
  items: AgentEventItem[];
  buffer: AgentEventItem[];
  hydrated: boolean;
  cursor: number;
  request: number;
};
type Subscription = {
  scope: string;
  kind: EventKind;
  sessions: Map<string, SessionEvents>;
  publish(): void;
  seed(sessionId: string, state: SessionEvents): void;
};

function cursorOf(item: AgentEventItem): number {
  return item.event.eventCursor ?? 0;
}
function maxCursor(items: readonly AgentEventItem[]): number {
  return items.reduce((cursor, item) => Math.max(cursor, cursorOf(item)), 0);
}
function relevant(event: AgentEvent, kind: EventKind): boolean {
  if (kind === "questions")
    return event.type === "question.requested" || event.type === "question.resolved";
  return (
    event.type.startsWith("run.") ||
    event.type.startsWith("message.") ||
    event.type.startsWith("thinking.") ||
    event.type === "tool.started" ||
    event.type === "tool.delta" ||
    event.type === "tool.ended"
  );
}

/** Compact by stream/request identity, retaining only the active run for activity. */
export function compactGroupAgentEvents(
  items: AgentEventItem[],
  kind: EventKind,
): AgentEventItem[] {
  if (kind === "questions") {
    const latest = new Map<string, AgentEventItem>();
    for (const item of items) {
      const event = item.event;
      if (event.type !== "question.requested" && event.type !== "question.resolved") continue;
      const id = event.type === "question.requested" ? event.request.id : event.requestId;
      latest.delete(id);
      latest.set(id, item);
    }
    return [...latest.values()].slice(-TURN_PARTS_MAX);
  }
  let start = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.event.type === "run.started") {
      start = i;
      break;
    }
  }
  const folded = foldAgentEvents(items.slice(start).filter((item) => relevant(item.event, kind)));
  // The first item holds the run boundary even when very long runs exceed the activity budget.
  const retained =
    folded.length > TURN_PARTS_MAX
      ? [...folded.slice(0, 1), ...folded.slice(-(TURN_PARTS_MAX - 1))]
      : folded;
  return retained.map((item) => {
    const event = item.event;
    if (
      (event.type === "message.delta" || event.type === "thinking.delta") &&
      event.delta.length > PREVIEW_TEXT_MAX
    ) {
      return { ...item, event: { ...event, delta: event.delta.slice(-PREVIEW_TEXT_MAX) } };
    }
    return item;
  });
}

/** Snapshot cursor is authoritative; retain only the live suffix after that boundary. */
export function mergeGroupAgentSeed(
  seed: AgentEventItem[],
  buffer: AgentEventItem[],
  kind: EventKind,
  snapshotCursor?: number,
): AgentEventItem[] {
  const cursor = snapshotCursor ?? maxCursor(seed);
  const suffix = buffer.filter((item) => cursorOf(item) === 0 || cursorOf(item) > cursor);
  return compactGroupAgentEvents([...seed, ...suffix], kind);
}

/** One listener per room, with independent per-session hydration lifetimes. */
export function useGroupAgentEvents(
  scope: string,
  sessionIds: readonly string[],
  kind: EventKind,
): ReadonlyMap<string, AgentEventItem[]> {
  const idsKey = JSON.stringify([...new Set(sessionIds)].sort());
  const subscription = useRef<Subscription | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    items: ReadonlyMap<string, { state: SessionEvents; items: AgentEventItem[] }>;
  }>({ scope, items: new Map() });

  useEffect(() => {
    let disposed = false;
    let frame: number | undefined;
    let localId = 0;
    const agent = window.modus.agent;
    const current: Subscription = {
      scope,
      kind,
      sessions: new Map(),
      publish() {
        if (disposed || frame !== undefined) return;
        frame = requestAnimationFrame(() => {
          frame = undefined;
          if (!disposed)
            setSnapshot({
              scope,
              items: new Map(
                [...current.sessions].map(([id, state]) => [id, { state, items: state.items }]),
              ),
            });
        });
      },
      seed(sessionId, state) {
        const request = ++state.request;
        // On overflow all events already received are durable; a new snapshot covers them.
        state.buffer = [];
        const active = () =>
          !disposed && current.sessions.get(sessionId) === state && state.request === request;
        void agent
          .listEventPage(sessionId, {
            direction: "backward",
            includeSummary: kind === "questions",
            includeActivity: kind === "working",
            limit: 1,
          })
          .then((page: AgentEventPage) => {
            if (!active()) return;
            const source = kind === "questions" ? page.summaryEvents : page.activityEvents;
            const seed = source.filter(
              (item: AgentEventItem) => item.event.sessionId === sessionId,
            );
            state.items = mergeGroupAgentSeed(seed, state.buffer, kind, page.snapshotCursor);
            state.cursor = Math.max(page.snapshotCursor, maxCursor(state.buffer));
            state.buffer = [];
            state.hydrated = true;
            current.publish();
          })
          .catch(() => {
            if (!active()) return;
            state.buffer = [];
            state.hydrated = true;
            current.publish();
          });
      },
    };
    subscription.current = current;
    setSnapshot({ scope, items: new Map() });
    const unsubscribe =
      agent?.listEventPage && agent.onEvent
        ? agent.onEvent((event: AgentEvent) => {
            const state = current.sessions.get(event.sessionId);
            if (!state) return;
            const eventCursor = event.eventCursor ?? 0;
            if (state.hydrated && eventCursor > 0 && eventCursor <= state.cursor) return;
            state.cursor = Math.max(state.cursor, eventCursor);
            // Unrelated events still advance the session cursor for duplicate protection.
            if (!relevant(event, kind)) return;
            const item: AgentEventItem = {
              id: `group-live:${++localId}`,
              event,
              createdAt: new Date().toISOString(),
            };
            if (!state.hydrated) state.buffer.push(item);
            state.items = compactGroupAgentEvents([...state.items, item], kind);
            if (state.buffer.length > HYDRATION_BUFFER_MAX) current.seed(event.sessionId, state);
            current.publish();
          })
        : () => undefined;
    return () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (subscription.current === current) subscription.current = undefined;
      unsubscribe();
    };
  }, [scope, kind]);

  useEffect(() => {
    const current = subscription.current;
    if (!current || current.scope !== scope || current.kind !== kind) return;
    const ids = new Set<string>(JSON.parse(idsKey));
    for (const id of current.sessions.keys()) if (!ids.has(id)) current.sessions.delete(id);
    const agent = window.modus.agent;
    for (const id of ids) {
      if (current.sessions.has(id)) continue;
      const state: SessionEvents = {
        items: [],
        buffer: [],
        hydrated: false,
        cursor: 0,
        request: 0,
      };
      current.sessions.set(id, state);
      if (agent?.listEventPage && agent.onEvent) current.seed(id, state);
    }
    current.publish();
  }, [scope, idsKey, kind]);

  return useMemo(() => {
    const current = subscription.current;
    if (snapshot.scope !== scope || current?.scope !== scope)
      return new Map<string, AgentEventItem[]>();
    const ids = new Set<string>(JSON.parse(idsKey));
    return new Map(
      [...snapshot.items]
        .filter(([id, entry]) => ids.has(id) && current.sessions.get(id) === entry.state)
        .map(([id, entry]) => [id, entry.items]),
    );
  }, [snapshot, scope, idsKey]);
}
