import { IconChevronRight, IconGitBranch } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import type { GroupRuntimeEvent, GroupTask, GroupTaskStatus } from "../../../../shared/contracts";
import { CopyButton } from "../../components/ui/CopyButton";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { describeGroupError } from "./groupErrors";

/** Panel sections in order; Cancelled starts collapsed. */
export const TASK_SECTIONS: ReadonlyArray<{ status: GroupTaskStatus; label: string }> = [
  { status: "open", label: "Open" },
  { status: "in_progress", label: "In progress" },
  { status: "in_review", label: "In review" },
  { status: "done", label: "Done" },
  { status: "cancelled", label: "Cancelled" },
];

/** Second-click label of the two-step "Cancel task". */
export const CANCEL_TASK_CONFIRM_LABEL = "Click again to cancel";

/** Tasks still in play (the panel button's counter). */
export function activeTaskCount(tasks: readonly GroupTask[]): number {
  return tasks.filter((task) => task.status !== "done" && task.status !== "cancelled").length;
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

/** Right-hand task panel of the room. The only user action is "Cancel task". */
export function GroupTaskPanel({
  tasks,
  titles,
  onCancelled,
}: {
  tasks: readonly GroupTask[];
  titles: ReadonlyMap<string, string>;
  onCancelled(task: GroupTask): void;
}) {
  const [cancelledOpen, setCancelledOpen] = useState(false);
  return (
    <aside
      aria-label="Tasks"
      className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-hairline border-l px-3 py-3"
      data-testid="group-task-panel"
    >
      {tasks.length === 0 ? (
        <div className="px-1 py-6 text-center text-fg-faint text-xs">
          No tasks yet. Members create them as they work.
        </div>
      ) : null}
      {TASK_SECTIONS.map(({ status, label }) => {
        const items = tasks.filter((task) => task.status === status);
        if (items.length === 0) return null;
        const collapsible = status === "cancelled";
        const open = !collapsible || cancelledOpen;
        return (
          <section className="mb-3" data-status={status} data-testid="task-section" key={status}>
            {collapsible ? (
              <button
                aria-expanded={open}
                className="mb-1 flex w-full items-center gap-1 px-1 text-2xs text-fg-faint uppercase tracking-wide hover:text-fg-muted"
                onClick={() => setCancelledOpen((value) => !value)}
                type="button"
              >
                <IconChevronRight
                  className={cn("transition-transform", open && "rotate-90")}
                  size={ICON.xs}
                  stroke={ICON_STROKE.xs}
                />
                {label} <span className="tabular-nums">{items.length}</span>
              </button>
            ) : (
              <h3 className="mb-1 px-1 text-2xs text-fg-faint uppercase tracking-wide">
                {label} <span className="tabular-nums">{items.length}</span>
              </h3>
            )}
            {open
              ? items.map((task) => (
                  <TaskCard key={task.id} onCancelled={onCancelled} task={task} titles={titles} />
                ))
              : null}
          </section>
        );
      })}
    </aside>
  );
}

function TaskCard({
  task,
  titles,
  onCancelled,
}: {
  task: GroupTask;
  titles: ReadonlyMap<string, string>;
  onCancelled(task: GroupTask): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const name = (id: string | undefined, none: string) =>
    id ? (titles.get(id) ?? id) : <span className="text-fg-faint">{none}</span>;
  const cancellable = task.status !== "done" && task.status !== "cancelled";

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
    <div
      className="mb-1.5 rounded-md border border-hairline bg-elevated px-2.5 py-2 text-xs"
      data-testid="group-task"
    >
      <div className="mb-1 font-medium text-fg">{task.title}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-fg-muted">
        <dt className="text-fg-faint">Owner</dt>
        <dd className="min-w-0 truncate">{name(task.ownerSessionId, "Unassigned")}</dd>
        <dt className="text-fg-faint">Reviewer</dt>
        <dd className="min-w-0 truncate">{name(task.reviewerSessionId, "None")}</dd>
        {task.branch ? (
          <>
            <dt className="text-fg-faint">Branch</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <IconGitBranch className="shrink-0" size={ICON.xs} stroke={ICON_STROKE.xs} />
              <span className="min-w-0 truncate font-mono text-2xs">{task.branch}</span>
              <CopyButton className="-my-1 size-5" label="Copy branch" text={task.branch} />
            </dd>
          </>
        ) : null}
      </dl>
      {error ? <div className="mt-1 text-danger">{error}</div> : null}
      {cancellable ? (
        <button
          className={cn(
            "mt-1.5 rounded-md px-1.5 py-0.5 text-2xs transition-colors",
            confirming ? "bg-danger/10 text-danger" : "text-fg-faint hover:bg-hover hover:text-fg",
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
  );
}
