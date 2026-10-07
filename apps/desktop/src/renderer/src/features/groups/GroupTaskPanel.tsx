import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { GroupRuntimeEvent, GroupTask, GroupTaskStatus } from "../../../../shared/contracts";
import { GROUP_ROOM_TEXT_EN } from "../../../../shared/group-room-text";
import { TaskCheck } from "../../components/ui/TaskCheck";
import { cn } from "../../lib/cn";
import { GroupTaskDetails } from "./GroupTaskDetails";
import { describeGroupError } from "./groupErrors";
import { type GroupTextFn, useGroupText } from "./groupRoomI18n";
import { shouldRefreshGroupSidePanel } from "./groupSidePanelRefresh";
import { MemberName } from "./MemberName";
import type { MemberLabel } from "./memberLabels";

/** Second-click label of the two-step "Cancel task". */
export const CANCEL_TASK_CONFIRM_LABEL = GROUP_ROOM_TEXT_EN["tasks.confirmCancel"];

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

function statusBadge(status: GroupTaskStatus, t: GroupTextFn): string | undefined {
  if (status === "in_progress") return t("tasks.inProgress");
  if (status === "in_review") return t("tasks.inReview");
  if (status === "blocked") return t("tasks.blocked");
  if (status === "open") return t("tasks.open");
  return undefined;
}

/**
 * The group's tasks (`group:list-tasks`). Reloads on turn/activity and status
 * lines — not on every chat `group.message` (streaming would re-hit the DB).
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
      if (shouldRefreshGroupSidePanel(groupId, event)) void refresh();
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
    blocked: 2,
    open: 3,
    done: 4,
    cancelled: 5,
  };
  return [...tasks].sort((a, b) => {
    const byStatus = rank[a.status] - rank[b.status];
    if (byStatus !== 0) return byStatus;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Right-hand side panel of the room: the checklist leads when work exists,
 * followed by `top` (Activity sections / Decisions). Agents mark done; the user
 * can Cancel. TaskCheck is display-only. N2: shell is labeled Activity.
 */
export function GroupTaskPanel({
  groupId,
  tasks,
  labels,
  onCancelled,
  onTaskUpdated,
  onOpenSession,
  top,
  ariaLabel,
  testId = "group-activity-panel",
}: {
  groupId: string;
  tasks: readonly GroupTask[];
  labels: ReadonlyMap<string, MemberLabel>;
  onCancelled(task: GroupTask): void;
  onTaskUpdated?(task: GroupTask): void;
  onOpenSession?(sessionId: string, runId?: string): void;
  top?: ReactNode;
  ariaLabel?: string;
  testId?: string;
}) {
  const t = useGroupText();
  const [showCancelled, setShowCancelled] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const progress = checklistProgress(tasks);
  const visible = sortTasks(tasks.filter((task) => task.status !== "cancelled" || showCancelled));
  const cancelledCount = tasks.filter((task) => task.status === "cancelled").length;

  return (
    <aside
      aria-label={ariaLabel ?? t("activity.title")}
      className="surface-sidebar flex w-[min(300px,40%)] shrink-0 flex-col overflow-y-auto border-hairline border-l px-3 py-3"
      data-ui-surface="sidebar"
      data-testid={testId}
    >
      {tasks.length > 0 ? (
        <div className="group-activity-checklist-enter" data-testid="group-task-checklist-reveal">
          <div className="min-h-0 overflow-hidden">
            <div
              className="mb-2 flex items-baseline justify-between gap-2 px-1"
              data-testid="task-checklist-progress"
            >
              <h3 className="text-2xs text-fg-faint uppercase tracking-wide">
                {t("tasks.checklist")}
              </h3>
              <span className="tabular-nums text-2xs text-fg-muted">
                {t("tasks.progress", { done: progress.done, total: progress.total })}
              </span>
            </div>
            <ul className="flex flex-col gap-0.5" data-testid="task-checklist">
              {visible.map((task) => (
                <TaskCheckRow
                  key={task.id}
                  labels={labels}
                  onCancelled={onCancelled}
                  onShowDetails={() => setSelectedTaskId(task.id)}
                  task={task}
                />
              ))}
            </ul>
            {selectedTaskId ? (
              <GroupTaskDetails
                key={`${groupId}:${selectedTaskId}`}
                groupId={groupId}
                labels={labels}
                onClose={() => setSelectedTaskId(undefined)}
                {...(onOpenSession ? { onOpenSession } : {})}
                {...(onTaskUpdated ? { onTaskUpdated } : {})}
                taskId={selectedTaskId}
              />
            ) : null}
            {cancelledCount > 0 ? (
              <button
                aria-expanded={showCancelled}
                className="mt-2 px-1 text-left text-2xs text-fg-faint hover:text-fg-muted"
                onClick={() => setShowCancelled((value) => !value)}
                type="button"
              >
                {showCancelled
                  ? t("tasks.hideCancelled")
                  : t("tasks.showCancelled", { count: cancelledCount })}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {top}
    </aside>
  );
}

function TaskCheckRow({
  task,
  labels,
  onCancelled,
  onShowDetails,
}: {
  task: GroupTask;
  labels: ReadonlyMap<string, MemberLabel>;
  onCancelled(task: GroupTask): void;
  onShowDetails(): void;
}) {
  const t = useGroupText();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const done = task.status === "done";
  const cancelled = task.status === "cancelled";
  const badge = statusBadge(task.status, t);
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
      setError(describeGroupError(cause, t.locale));
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
        <TaskCheck
          aria-label={done ? t("tasks.done") : t("tasks.notDone")}
          checked={done}
          className="mt-0.5"
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
              <span>{t("tasks.unassigned")}</span>
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
          <button
            className="mt-1 text-2xs text-accent hover:underline"
            onClick={onShowDetails}
            type="button"
          >
            {t("taskDetails.details")}
          </button>
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
              {confirming ? t("tasks.confirmCancel") : t("tasks.cancel")}
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
