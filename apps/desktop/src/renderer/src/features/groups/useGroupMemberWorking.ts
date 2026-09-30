import { useEffect, useMemo, useState } from "react";
import type { AgentEventItem } from "../../../../shared/agent-events";
import type { AgentEvent } from "../../../../shared/contracts";
import {
  type GroupMemberWorkingPhase,
  groupMemberWorkingPhase,
  listGroupWorkingSessionIds,
} from "./groupWorkingPhase";
import type { GroupMemberStatesById } from "./useWorkingGroups";

export type GroupMemberWorkingRow = {
  sessionId: string;
  mode: "running" | "queued";
  phase: GroupMemberWorkingPhase;
};

/**
 * Live phase labels for members currently running or queued in this group.
 * Subscribes to `agent.onEvent` for running sessions (same pattern as
 * GroupMemberQuestions) so the room strip tracks Thinking / tools / Writing.
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

  const [eventsBySession, setEventsBySession] = useState<
    ReadonlyMap<string, Array<{ event: AgentEvent }>>
  >(() => new Map());

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
          return [sessionId, items.map((item) => ({ event: item.event }))] as const;
        } catch {
          const empty: Array<{ event: AgentEvent }> = [];
          return [sessionId, empty] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setEventsBySession(new Map(entries));
    });

    const unsubscribe = agent.onEvent((event: AgentEvent) => {
      if (!runningIds.includes(event.sessionId)) return;
      setEventsBySession((current) => {
        const next = new Map(current);
        const list = next.get(event.sessionId) ?? [];
        next.set(event.sessionId, [...list, { event }]);
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
        phase: groupMemberWorkingPhase(eventsBySession.get(row.sessionId) ?? [], row.mode),
      })),
    [working, eventsBySession],
  );
}
