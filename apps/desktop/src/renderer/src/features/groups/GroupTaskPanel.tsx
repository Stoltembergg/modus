import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { GroupRuntimeEvent, GroupTask, GroupTaskStatus } from "../../../../shared/contracts";
import { SpringCheck } from "../../components/ui/SpringCheck";
import { cn } from "../../lib/cn";
import { describeGroupError } from "./groupErrors";
import { MemberName } from "./MemberName";
import type { MemberLabel } from "./memberLabels";

/** Second-click label of the two-step "Cancel task". */
export const CANCEL_TASK_CONFIRM_LABEL = "Click again to cancel";

/** Tasks still in play (the panel button's counter). */
export function activeTaskCount(tasks: readonly GroupTask[]): number {
  return tasks.filter((task) => task.status !== "done" && task.status !== "cancelled").length;
}

/** Done vs total for the checklist header (excludes cancelled). */
export function checklistProgress(tasks: readonly GroupTask[]): { done: number; total: number } {
  const counted = tasks.filter((task) => task.status !== "cancelled");
  return {
    done: counted.filter((task) => task.status === "done").length,
    total: counted.length,
  };
}

function statusBadge(status: GroupTaskStatus): string | undefined {
  if (status === "in_progress") return "In progress";
  if (status === "in_review") return "In review";
  if (status === "open") return "Open";
  return undefined;
}

/**
 * The group's tasks (`group:list-tasks`), refetched when the room changes
 * (a member posts or a turn starts / ends: task tools run inside turns).
 */
export function useGroupTasks(groupId: string) {
  const [tasks, setTasks] = useState<GroupTask[]>([]);
  const refresh = useCallback(async () => {
    try {
      setTasks(await window.modus.group.listTasks(groupId));
    } catch (error) {
      console.warn("[groups] failed to load tasks", error);
    }
  }, [groupId]);
  useEffect(() => {
    setTasks([]);
    void refresh();
    return window.modus.group.onEvent((event: GroupRuntimeEvent) => {
      if (event.groupId !== groupId) return;
      if (event.type === "group.message" || event.type === "group.activity") void refresh();
    });
  }, [groupId, refresh]);
  const replace = useCallback((task: GroupTask) => {
    setTasks((current) => current.map((item) => (item.id === task.id ? task : item)));
  }, []);
  return { tasks, replace };
}

function sortTasks(tasks: readonly GroupTask[]): GroupTask[] {
  const rank: Record<GroupTaskStatus, number> = {
    in_progress: 0,
    in_review: 1,
    open: 2,
    done: 3,
    cancelled: 4,
  };
  return [...tasks].sort((a, b) => {
    const byStatus = rank[a.status] - rank[b.status];
    if (byStatus !== 0) return byStatus;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Right-hand side panel of the room: `top` (Activity sections / Decisions)
 * above the checklist. Agents mark done; the user can Cancel. Spring Check is
 * display-only. N2: shell is labeled Activity; checklist stays infrastructure.
 */
export function GroupTaskPanel({
  tasks,
  labels,
  onCancelled,
  top,
  ariaLabel = "Activity",
  testId = "group-activity-panel",
}: {
  tasks: readonly GroupTask[];
  labels: ReadonlyMap<string, MemberLabel>;
  onCancelled(task: GroupTask): void;
  top?: ReactNode;
  ariaLabel?: string;
  testId?: string;
}) {
  const [showCancelled, setShowCancelled] = useState(false);
  const progress = checklistProgress(tasks);
  const visible = sortTasks(tasks.filter((task) => task.status !== "cancelled" || showCancelled));
  const cancelledCount = tasks.filter((task) => task.status === "cancelled").length;

  return (
    <aside
      aria-label={ariaLabel}
      className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-hairline border-l px-3 py-3"
      data-testid={testId}
    >
      {top}
      {tasks.length === 0 ? (
        <div className="px-1 py-6 text-center text-fg-faint text-xs">
          No tasks yet. Members create them as they work.
        </div>
      ) : (
        <>
          <div
            className="mb-2 flex items-baseline justify-between gap-2 px-1"
            data-testid="task-checklist-progress"
          >
            <h3 className="text-2xs text-fg-faint uppercase tracking-wide">Checklist</h3>
            <span className="tabular-nums text-2xs text-fg-muted">
              {progress.done}/{progress.total} done
            </span>
          </div>
          <ul className="flex flex-col gap-0.5" data-testid="task-checklist">
            {visible.map((task) => (
              <TaskCheckRow key={task.id} labels={labels} onCancelled={onCancelled} task={task} />
            ))}
          </ul>
          {cancelledCount > 0 ? (
            <button
              aria-expanded={showCancelled}
              className="mt-2 px-1 text-left text-2xs text-fg-faint hover:text-fg-muted"
              onClick={() => setShowCancelled((value) => !value)}
              type="button"
            >
              {showCancelled ? "Hide cancelled" : `Show cancelled (${cancelledCount})`}
            </button>
          ) : null}
        </>
      )}
    </aside>
  );
}

function TaskCheckRow({
  task,
  labels,
  onCancelled,
}: {
  task: GroupTask;
  labels: ReadonlyMap<string, MemberLabel>;
  onCancelled(task: GroupTask): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const done = task.status === "done";
  const cancelled = task.status === "cancelled";
  const badge = statusBadge(task.status);
  const owner = task.ownerSessionId
    ? (labels.get(task.ownerSessionId) ?? { title: task.ownerSessionId })
    : undefined;
  const cancellable = !done && !cancelled;

  async function cancel(): Promise<void> {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      onCancelled(await window.modus.group.cancelTask(task.id));
    } catch (cause) {
      setError(describeGroupError(cause));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <li
      className={cn("rounded-md px-1.5 py-1.5 text-xs", cancelled && "opacity-50")}
      data-status={task.status}
      data-testid="group-task"
    >
      <div className="flex items-start gap-2">
        <SpringCheck
          aria-label={done ? "Done" : "Not done"}
          checked={done}
          className="mt-0.5"
          disabled
        />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "font-medium text-fg leading-snug",
              done && "text-fg-muted line-through",
              cancelled && "text-fg-faint line-through",
            )}
          >
            {task.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-faint">
            {badge ? (
              <span className="text-fg-muted" data-testid="task-status-badge">
                {badge}
              </span>
            ) : null}
            {owner ? (
              <span className="min-w-0 truncate">
                <MemberName label={owner} />
              </span>
            ) : (
              <span>Unassigned</span>
            )}
            {task.branch ? (
              <span
                className="min-w-0 truncate font-mono"
                data-testid="task-branch"
                title={task.branch}
              >
                {task.branch}
              </span>
            ) : null}
          </div>
          {error ? <div className="mt-1 text-danger">{error}</div> : null}
          {cancellable ? (
            <button
              className={cn(
                "mt-1 rounded-md px-1.5 py-0.5 text-2xs transition-colors",
                confirming
                  ? "bg-danger/10 text-danger"
                  : "text-fg-faint hover:bg-hover hover:text-fg",
              )}
              disabled={busy}
              onBlur={() => setConfirming(false)}
              onClick={() => void cancel()}
              type="button"
            >
              {confirming ? CANCEL_TASK_CONFIRM_LABEL : "Cancel task"}
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
