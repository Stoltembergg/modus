import { useMemo } from "react";
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
  const events = useGroupAgentEvents(
    groupId,
    working.filter((row) => row.mode === "running").map((row) => row.sessionId),
    "working",
  );
  return useMemo(
    () =>
      working.map((row) => ({
        ...row,
        live: buildGroupLiveTurn(
          (events.get(row.sessionId) ?? []).map((item) => ({
            event: item.event,
            ...((item.updatedAt ?? item.createdAt)
              ? { createdAt: item.updatedAt ?? item.createdAt }
              : {}),
          })),
          row.mode,
        ),
      })),
    [working, events],
  );
}
