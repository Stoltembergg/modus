import { useMemo, useRef } from "react";
import { useGroupAgentEvents } from "./groupAgentEvents";
import { buildGroupLiveTurn, type GroupLiveTurnSnapshot } from "./groupLiveTurn";
import { listGroupWorkingSessionIds } from "./groupWorkingPhase";
import type { GroupMemberStatesById } from "./useWorkingGroups";

export type GroupMemberWorkingRow = {
  sessionId: string;
  mode: "running" | "queued";
  /** Activity and compact progress; public cards come from canonical group messages. */
  live: GroupLiveTurnSnapshot;
};

/**
 * Track when each session first appeared in the queue so progress can show
 * "Queued · Ns" with a stable age across activity snapshots.
 */
function syncQueuedSince(
  map: Map<string, number>,
  queuedSessionIds: readonly string[],
  nowMs: number,
): Map<string, number> {
  const next = new Map(map);
  const queued = new Set(queuedSessionIds);
  for (const sessionId of queued) {
    if (!next.has(sessionId)) next.set(sessionId, nowMs);
  }
  for (const sessionId of [...next.keys()]) {
    if (!queued.has(sessionId)) next.delete(sessionId);
  }
  return next;
}

export function useGroupMemberWorking(
  groupId: string,
  memberStates: GroupMemberStatesById,
): readonly GroupMemberWorkingRow[] {
  const entry = memberStates.get(groupId);
  const workingKey = JSON.stringify([
    entry?.runningSessionIds ?? [],
    entry?.queuedSessionIds ?? [],
  ]);
  const working = useMemo(() => {
    const [runningSessionIds, queuedSessionIds] = JSON.parse(workingKey) as [string[], string[]];
    return listGroupWorkingSessionIds({ runningSessionIds, queuedSessionIds });
  }, [workingKey]);
  const queuedSinceRef = useRef(new Map<string, number>());
  queuedSinceRef.current = syncQueuedSince(
    queuedSinceRef.current,
    working.filter((row) => row.mode === "queued").map((row) => row.sessionId),
    Date.now(),
  );
  const events = useGroupAgentEvents(
    groupId,
    working.filter((row) => row.mode === "running").map((row) => row.sessionId),
    "working",
  );
  return useMemo(
    () =>
      working.map((row) => {
        const queuedSinceMs =
          row.mode === "queued" ? queuedSinceRef.current.get(row.sessionId) : undefined;
        return {
          ...row,
          live: buildGroupLiveTurn(
            (events.get(row.sessionId) ?? []).map((item) => ({
              event: item.event,
              ...((item.updatedAt ?? item.createdAt)
                ? { createdAt: item.updatedAt ?? item.createdAt }
                : {}),
            })),
            row.mode,
            queuedSinceMs !== undefined ? { queuedSinceMs } : undefined,
          ),
        };
      }),
    [working, events],
  );
}
