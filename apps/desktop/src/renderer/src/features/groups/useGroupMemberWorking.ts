import { useEffect, useMemo, useState } from "react";
import type { AgentEventItem } from "../../../../shared/agent-events";
import type { AgentEvent } from "../../../../shared/contracts";
import { buildGroupLiveTurn, type GroupLiveTurnSnapshot } from "./groupLiveTurn";
import { listGroupWorkingSessionIds } from "./groupWorkingPhase";
import type { GroupMemberStatesById } from "./useWorkingGroups";

type TimedEvent = { event: AgentEvent; createdAt?: string };

export type GroupMemberWorkingRow = {
  sessionId: string;
  mode: "running" | "queued";
  /** Live turn snapshot (phase + thought/tools/writing previews). */
  live: GroupLiveTurnSnapshot;
};

function toTimedEvents(items: AgentEventItem[]): TimedEvent[] {
  return items.map((item) => ({
    event: item.event,
    ...(item.createdAt || item.updatedAt ? { createdAt: item.updatedAt ?? item.createdAt } : {}),
  }));
}

/** Bytes of assistant `message.delta` text — used to avoid wiping a richer live stream. */
function assistantStreamBytes(events: readonly TimedEvent[]): number {
  let total = 0;
  for (const { event } of events) {
    if (event.type === "message.delta") total += event.delta.length;
  }
  return total;
}

/**
 * Prefer the event list that already carries more streamed assistant text.
 * A slow `listEvents` seed must never replace an in-flight delta buffer with a
 * stale/empty snapshot (that produced the "Escrevendo…" then final paste bug).
 */
export function preferRicherLiveEvents(
  seeded: readonly TimedEvent[],
  live: readonly TimedEvent[],
): TimedEvent[] {
  return assistantStreamBytes(live) > assistantStreamBytes(seeded) ? [...live] : [...seeded];
}

/**
 * Live turn snapshots for members currently running or queued in this group.
 * Subscribes to `agent.onEvent` for running sessions so the room can stream
 * Thinking / tools / Writing (same event source as ChatPane, compact fold).
 */
export function useGroupMemberWorking(
  groupId: string,
  memberStates: GroupMemberStatesById,
): readonly GroupMemberWorkingRow[] {
  const entry = memberStates.get(groupId);
  // Stable key: activity pings rebuild the entry object with the same ids.
  const workingKey = entry
    ? `r:${entry.runningSessionIds.join(",")}|q:${entry.queuedSessionIds.join(",")}`
    : "";
  const working = useMemo((): Array<{ sessionId: string; mode: "running" | "queued" }> => {
    if (!workingKey) return [];
    const [runningPart = "", queuedPart = ""] = workingKey.split("|q:");
    const runningSessionIds = runningPart.replace(/^r:/, "").split(",").filter(Boolean);
    const queuedSessionIds = queuedPart.split(",").filter(Boolean);
    return listGroupWorkingSessionIds({ runningSessionIds, queuedSessionIds });
  }, [workingKey]);

  const [eventsBySession, setEventsBySession] = useState<ReadonlyMap<string, TimedEvent[]>>(
    () => new Map(),
  );

  useEffect(() => {
    const runningIds = working.filter((row) => row.mode === "running").map((row) => row.sessionId);
    if (runningIds.length === 0) {
      setEventsBySession(new Map());
      return;
    }
    let cancelled = false;
    const agent = window.modus.agent;
    if (!agent?.listEvents || !agent.onEvent) {
      setEventsBySession(new Map());
      return;
    }

    // Subscribe first so mid-seed deltas are never missed (same order as ChatPane).
    const unsubscribe = agent.onEvent((event: AgentEvent) => {
      if (!runningIds.includes(event.sessionId)) return;
      const createdAt = new Date().toISOString();
      setEventsBySession((current) => {
        const next = new Map(current);
        const list = next.get(event.sessionId) ?? [];
        next.set(event.sessionId, [...list, { event, createdAt }]);
        return next;
      });
    });

    // Seed from the store. Never clobber a richer in-flight delta buffer with a
    // stale/empty snapshot (ChatPane re-fetches; we keep the richer stream).
    void Promise.all(
      runningIds.map(async (sessionId) => {
        try {
          const items = (await agent.listEvents(sessionId)) as AgentEventItem[];
          return [sessionId, toTimedEvents(items)] as const;
        } catch {
          const empty: TimedEvent[] = [];
          return [sessionId, empty] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setEventsBySession((current) => {
        const next = new Map<string, TimedEvent[]>();
        for (const [sessionId, seeded] of entries) {
          next.set(sessionId, preferRicherLiveEvents(seeded, current.get(sessionId) ?? []));
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [working]);

  return useMemo(
    () =>
      working.map((row) => ({
        ...row,
        live: buildGroupLiveTurn(eventsBySession.get(row.sessionId) ?? [], row.mode),
      })),
    [working, eventsBySession],
  );
}
