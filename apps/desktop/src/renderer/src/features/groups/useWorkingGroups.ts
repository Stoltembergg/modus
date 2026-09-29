import { useEffect, useState } from "react";
import type { GroupRuntimeEvent } from "../../../../shared/contracts";

/** Next set of working group ids after a runtime event (same set when unchanged). */
export function applyGroupActivityEvent(
  working: ReadonlySet<string>,
  event: GroupRuntimeEvent,
): ReadonlySet<string> {
  if (event.type !== "group.activity") return working;
  const isWorking = event.runningSessionIds.length > 0 || event.queuedSessionIds.length > 0;
  if (isWorking === working.has(event.groupId)) return working;
  const next = new Set(working);
  if (isWorking) next.add(event.groupId);
  else next.delete(event.groupId);
  return next;
}

/**
 * Groups with a member turn running or queued, from the main-process
 * GroupRuntime (`group:working` snapshot, then `group:event` activity pushes).
 * Feeds the sidebar activity dot.
 */
export function useWorkingGroups(): ReadonlySet<string> {
  const [working, setWorking] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.modus.group.onEvent((event: GroupRuntimeEvent) => {
      setWorking((current) => applyGroupActivityEvent(current, event));
    });
    window.modus.group
      .workingGroupIds()
      .then((ids: string[]) => {
        if (!disposed) setWorking((current) => new Set([...current, ...ids]));
      })
      .catch((error: unknown) => console.warn("[groups] failed to load group activity", error));
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  return working;
}
