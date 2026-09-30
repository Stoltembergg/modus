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
  const working = useMemo(
    () =>
      entry
        ? listGroupWorkingSessionIds(entry)
        : ([] as Array<{ sessionId: string; mode: "running" | "queued" }>),
    [entry],
  );

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

    void Promise.all(
      runningIds.map(async (sessionId) => {
        try {
          const items = (await agent.listEvents(sessionId)) as AgentEventItem[];
          return [
            sessionId,
            items.map((item) => ({
              event: item.event,
              ...(item.createdAt || item.updatedAt
                ? { createdAt: item.updatedAt ?? item.createdAt }
                : {}),
            })),
          ] as const;
        } catch {
          const empty: TimedEvent[] = [];
          return [sessionId, empty] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setEventsBySession(new Map(entries));
    });

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
