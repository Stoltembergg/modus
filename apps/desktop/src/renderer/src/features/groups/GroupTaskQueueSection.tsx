import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupRuntimeEvent } from "../../../../shared/contracts";
import type { GroupTaskQueueItem } from "../../../../shared/group-work-state";
import { describeGroupError } from "./groupErrors";
import { useGroupText } from "./groupRoomI18n";

function refreshesTaskQueue(groupId: string, event: GroupRuntimeEvent): boolean {
  return (
    "groupId" in event &&
    event.groupId === groupId &&
    (event.type === "group.activity" ||
      event.type === "group.task-changed" ||
      event.type === "group.suggestion-changed" ||
      event.type === "group.proactivity-mode-changed" ||
      event.type === "group.chain-ended")
  );
}

function stateLabel(item: GroupTaskQueueItem): string {
  if (item.state === "running") return "Running";
  if (item.state === "queued") return `Queued #${item.position ?? "–"}`;
  switch (item.backlogReason) {
    case "awaiting-capacity":
      return "Ready · waiting for queue capacity";
    case "routing-unavailable":
      return "Ready · needs routing";
    default:
      return "Ready · needs suggestion";
  }
}

/** Read-only view over Group Runtime's persisted FIFO and ready-task backlog. */
export function GroupTaskQueueSection({ groupId }: { groupId: string }) {
  const t = useGroupText();
  const [items, setItems] = useState<GroupTaskQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const snapshot = await window.modus.group.getTaskQueueSnapshot(groupId);
      if (generation !== requestGeneration.current) return;
      setItems(snapshot);
      setError(undefined);
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      setError(describeGroupError(cause, t.locale));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [groupId, t.locale]);

  useEffect(() => {
    setItems([]);
    setError(undefined);
    setLoading(true);
    void refresh();
    const unsubscribe = window.modus.group.onEvent((event: GroupRuntimeEvent) => {
      if (refreshesTaskQueue(groupId, event)) void refresh();
    });
    return () => {
      requestGeneration.current += 1;
      unsubscribe();
    };
  }, [groupId, refresh]);

  const queued = items.filter((item) => item.state !== "backlog");
  const backlog = items.filter((item) => item.state === "backlog");

  return (
    <section className="mb-3 px-1" data-testid="group-task-queue-section">
      <h3 className="mb-1.5 text-2xs text-fg-faint uppercase tracking-wide">Task queue</h3>
      {error ? (
        <p className="text-2xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? <p className="text-2xs text-fg-faint">Loading task queue…</p> : null}
      {!loading && queued.length === 0 && backlog.length === 0 ? (
        <p className="text-2xs text-fg-faint">No queued or ready tasks.</p>
      ) : null}
      {queued.length > 0 ? (
        <ul aria-label="Dispatched tasks" className="flex flex-col gap-1">
          {queued.map((item) => (
            <li
              className="rounded-md border border-hairline bg-elevated px-2 py-1.5 text-xs"
              data-testid="group-task-queue-item"
              key={`${item.taskId}:${item.jobId ?? item.state}`}
            >
              <div className="font-medium text-fg">{item.taskTitle}</div>
              <div className="mt-0.5 text-2xs text-fg-faint">
                {item.memberName ?? item.sessionId ?? "Group member"} · {stateLabel(item)}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {backlog.length > 0 ? (
        <div className="mt-2" data-testid="group-task-backlog">
          <h4 className="mb-1 text-2xs text-fg-faint">Ready backlog</h4>
          <ul className="flex flex-col gap-1">
            {backlog.map((item) => (
              <li
                className="rounded-md px-2 py-1 text-xs"
                data-testid="group-task-backlog-item"
                key={item.taskId}
              >
                <div className="font-medium text-fg-muted">{item.taskTitle}</div>
                <div className="text-2xs text-fg-faint">{stateLabel(item)}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
