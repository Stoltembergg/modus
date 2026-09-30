import type { AgentGroupMode, GroupTask } from "../../../../shared/contracts";
import type { GroupCollabStageSnapshot } from "../../../../shared/group-collab-status";
import { cn } from "../../lib/cn";
import { GroupDecisionsSection } from "./GroupDecisions";
import { GroupStageChip } from "./GroupRoomHeader";
import { activeTaskCount, GroupTaskPanel } from "./GroupTaskPanel";
import { MemberName } from "./MemberName";
import type { MemberLabel } from "./memberLabels";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";

/**
 * Secondary room panel (N2): live tool detail, coordination, decisions, and
 * checklist — kept out of the primary chat surface.
 */
export function GroupActivityPanel({
  groupId,
  tasks,
  labels,
  workingRows,
  stage,
  coordinating,
  hasLead,
  onCancelled,
  onSetMode,
}: {
  groupId: string;
  tasks: readonly GroupTask[];
  labels: ReadonlyMap<string, MemberLabel>;
  workingRows: readonly GroupMemberWorkingRow[];
  stage: GroupCollabStageSnapshot | undefined;
  coordinating: boolean;
  hasLead: boolean;
  onCancelled(task: GroupTask): void;
  onSetMode?: ((mode: AgentGroupMode) => void) | undefined;
}) {
  return (
    <GroupTaskPanel
      ariaLabel="Activity"
      labels={labels}
      onCancelled={onCancelled}
      tasks={tasks}
      testId="group-activity-panel"
      top={
        <>
          <ActivityLiveSection labels={labels} rows={workingRows} />
          <ActivityCoordinationSection
            coordinating={coordinating}
            hasLead={hasLead}
            labels={labels}
            onSetMode={onSetMode}
            stage={stage}
          />
          <GroupDecisionsSection groupId={groupId} labels={labels} />
        </>
      }
    />
  );
}

/** Header toggle label + open-task count for the Activity button. */
export function activityButtonMeta(tasks: readonly GroupTask[]): {
  openCount: number;
  label: string;
} {
  const openCount = activeTaskCount(tasks);
  return { openCount, label: `Activity (${openCount} active)` };
}

function ActivityLiveSection({
  rows,
  labels,
}: {
  rows: readonly GroupMemberWorkingRow[];
  labels: ReadonlyMap<string, MemberLabel>;
}) {
  const detailed = rows.filter(
    (row) =>
      row.mode === "running" &&
      !row.live.collapsed &&
      (row.live.tools.length > 0 || row.live.thoughtPreview || row.live.presence.activity),
  );
  if (detailed.length === 0) return null;

  return (
    <section className="mb-3" data-testid="group-activity-live">
      <h3 className="mb-1.5 px-1 text-2xs text-fg-faint uppercase tracking-wide">Live</h3>
      <ul className="flex flex-col gap-2">
        {detailed.map((row) => {
          const label = labels.get(row.sessionId) ?? { title: row.sessionId };
          return (
            <li
              className="rounded-md px-1.5 py-1.5 text-xs"
              data-testid="group-activity-live-row"
              key={row.sessionId}
            >
              <div className="font-medium text-fg-muted">
                <MemberName label={label} />
                <span className="ml-1.5 font-normal text-fg-faint">{row.live.phase}</span>
              </div>
              {row.live.presence.activity ? (
                <div className="mt-0.5 text-2xs text-fg-faint">{row.live.presence.activity}</div>
              ) : null}
              {row.live.tools.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-0.5 text-2xs text-fg-faint">
                  {row.live.tools.map((tool) => (
                    <li data-done={tool.done || undefined} key={tool.id}>
                      {tool.done ? "✓" : "·"} {tool.label}
                    </li>
                  ))}
                </ul>
              ) : null}
              {row.live.thoughtPreview ? (
                <p className="mt-1 line-clamp-3 text-2xs text-fg-faint">
                  {row.live.thoughtPreview}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ActivityCoordinationSection({
  stage,
  labels,
  coordinating,
  hasLead,
  onSetMode,
}: {
  stage: GroupCollabStageSnapshot | undefined;
  labels: ReadonlyMap<string, MemberLabel>;
  coordinating: boolean;
  hasLead: boolean;
  onSetMode?: ((mode: AgentGroupMode) => void) | undefined;
}) {
  return (
    <section className="mb-3" data-testid="group-activity-coordination">
      <h3 className="mb-1.5 px-1 text-2xs text-fg-faint uppercase tracking-wide">Coordination</h3>
      <div className="flex flex-col gap-1.5 px-1">
        {stage ? (
          <GroupStageChip labels={labels} stage={stage} />
        ) : (
          <span className="text-2xs text-fg-faint">No active handoff</span>
        )}
        <div className="flex items-center justify-between gap-2 text-2xs text-fg-muted">
          <span data-testid="group-activity-coordinator-status">
            {coordinating ? "Coordinator on" : "Free collaboration"}
          </span>
          {onSetMode ? (
            <button
              className={cn(
                "rounded-md border border-hairline px-1.5 py-0.5 transition-colors hover:bg-hover",
                !hasLead && "cursor-not-allowed opacity-50",
              )}
              disabled={!hasLead}
              onClick={() => onSetMode(coordinating ? "free" : "coordinator")}
              title={
                hasLead
                  ? coordinating
                    ? "Turn off Coordinator mode"
                    : "Lead coordinates untargeted messages"
                  : "Add a Lead to enable Coordinator mode"
              }
              type="button"
            >
              {coordinating ? "Disable" : "Enable"}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
