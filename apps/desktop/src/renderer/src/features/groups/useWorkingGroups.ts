import { useEffect, useState } from "react";
import type { GroupMemberStates, GroupRuntimeEvent } from "../../../../shared/contracts";

/** Per group: running / queued / waiting-for-you members (only groups with any). */
export type GroupMemberStatesById = ReadonlyMap<string, GroupMemberStates>;

/** Room chip / sidebar row state: waiting for you beats working. */
export type GroupActivityState = "waiting" | "working" | "idle";

function isEmpty(states: GroupMemberStates): boolean {
  return (
    states.runningSessionIds.length === 0 &&
    states.queuedSessionIds.length === 0 &&
    states.waitingSessionIds.length === 0
  );
}

/** Next member states after a runtime event (same map when unchanged). */
export function applyGroupActivityEvent(
  states: GroupMemberStatesById,
  event: GroupRuntimeEvent,
): GroupMemberStatesById {
  if (event.type !== "group.activity") return states;
  // Incomplete activity payloads (tests / non-state pings) must not crash.
  if (
    !Array.isArray(event.runningSessionIds) ||
    !Array.isArray(event.queuedSessionIds) ||
    !Array.isArray(event.waitingSessionIds)
  ) {
    return states;
  }
  const previous = states.get(event.groupId);
  const sameIds = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((id, index) => id === right[index]);
  if (
    previous &&
    sameIds(previous.runningSessionIds, event.runningSessionIds) &&
    sameIds(previous.queuedSessionIds, event.queuedSessionIds) &&
    sameIds(previous.waitingSessionIds, event.waitingSessionIds)
  )
    return states;
  const next = new Map(states);
  const entry: GroupMemberStates = {
    groupId: event.groupId,
    runningSessionIds: event.runningSessionIds,
    queuedSessionIds: event.queuedSessionIds,
    waitingSessionIds: event.waitingSessionIds,
  };
  if (isEmpty(entry)) {
    if (!states.has(event.groupId)) return states;
    next.delete(event.groupId);
  } else next.set(event.groupId, entry);
  return next;
}

/** The whole group: amber when a member waits for the user, else working, else idle. */
export function groupActivityState(
  states: GroupMemberStatesById,
  groupId: string,
): GroupActivityState {
  const entry = states.get(groupId);
  if (!entry) return "idle";
  if (entry.waitingSessionIds.length > 0) return "waiting";
  return entry.runningSessionIds.length > 0 || entry.queuedSessionIds.length > 0
    ? "working"
    : "idle";
}

/** One member of a group (a queued wake is not "working" yet). */
export function memberActivityState(
  states: GroupMemberStatesById,
  groupId: string,
  sessionId: string,
): GroupActivityState {
  const entry = states.get(groupId);
  if (entry?.waitingSessionIds.includes(sessionId)) return "waiting";
  if (entry?.runningSessionIds.includes(sessionId)) return "working";
  return "idle";
}

/** True while the group has work or a user wait that Stop can cancel. */
export function isGroupRunning(states: GroupMemberStatesById, groupId: string): boolean {
  const entry = states.get(groupId);
  return Boolean(entry && !isEmpty(entry));
}

/** Session ids currently waiting for the user in this group (empty when idle). */
export function waitingSessionIdsOf(
  states: GroupMemberStatesById,
  groupId: string,
): readonly string[] {
  return states.get(groupId)?.waitingSessionIds ?? [];
}

/**
 * Member states of every group from the main-process GroupRuntime
 * (`group:member-states` snapshot, then `group:event` activity pushes, which
 * win over the snapshot). Feeds the sidebar dot and the room chips.
 */
export function useGroupMemberStates(): GroupMemberStatesById {
  const [states, setStates] = useState<GroupMemberStatesById>(() => new Map());
  useEffect(() => {
    let disposed = false;
    const pushed = new Set<string>();
    const onEvent = window.modus.group.onEvent?.bind(window.modus.group);
    const unsubscribe =
      onEvent?.((event: GroupRuntimeEvent) => {
        if (
          event.type === "group.activity" &&
          Array.isArray(event.runningSessionIds) &&
          Array.isArray(event.queuedSessionIds) &&
          Array.isArray(event.waitingSessionIds)
        ) {
          pushed.add(event.groupId);
        }
        setStates((current) => applyGroupActivityEvent(current, event));
      }) ?? (() => undefined);
    const load = window.modus.group.memberStates?.();
    if (load) {
      load
        .then((snapshot: GroupMemberStates[]) => {
          if (disposed) return;
          setStates((current) => {
            const fresh = snapshot.filter((entry) => !pushed.has(entry.groupId));
            if (fresh.length === 0) return current;
            const next = new Map(current);
            for (const entry of fresh) {
              if (
                !Array.isArray(entry.runningSessionIds) ||
                !Array.isArray(entry.queuedSessionIds) ||
                !Array.isArray(entry.waitingSessionIds) ||
                isEmpty(entry)
              )
                continue;
              next.set(entry.groupId, entry);
            }
            return next;
          });
        })
        .catch((error: unknown) => console.warn("[groups] failed to load group activity", error));
    }
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  return states;
}
