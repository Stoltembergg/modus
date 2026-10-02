import type {
  AgentGroupMode,
  GroupMessage,
  GroupProjectContextSnapshot,
  GroupTask,
} from "../../../../shared/contracts";
import type { GroupCollabStageSnapshot } from "../../../../shared/group-collab-status";
import { estimateTokensByExecution } from "../../../../shared/group-conversation-minors";
import { formatGroupProjectContextDetails } from "../../../../shared/group-project";
import {
  collectRoomMessageDetails,
  type HandoffPacketField,
} from "../../../../shared/group-room-transcript";
import { cn } from "../../lib/cn";
import { formatTokenCount } from "../../lib/tokenUsage";
import { GroupDecisionsSection } from "./GroupDecisions";
import { GroupProjectContextChip } from "./GroupProjectContextChip";
import { GroupStageChip } from "./GroupRoomHeader";
import { activeTaskCount, GroupTaskPanel } from "./GroupTaskPanel";
import { MemberName } from "./MemberName";
import type { MemberLabel } from "./memberLabels";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";

/**
 * Secondary room panel (N2): live tool detail, coordination, decisions,
 * handoff Details, and checklist — kept out of the primary chat surface.
 */
export function GroupActivityPanel({
  groupId,
  tasks,
  labels,
  workingRows,
  stage,
  coordinating,
  hasLead,
  messages = [],
  projectContext,
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
  /** Room transcript — ops packets surface under Details. */
  messages?: readonly GroupMessage[];
  /** Project Setup diagnostics (fingerprint, CodeGraph, edges). */
  projectContext?: GroupProjectContextSnapshot | undefined;
  onCancelled(task: GroupTask): void;
  onSetMode?: ((mode: AgentGroupMode) => void) | undefined;
}) {
  const details = collectRoomMessageDetails(messages).slice(-12);
  const executionTokens = estimateTokensByExecution(messages);
  const allTokenRows = [...executionTokens.entries()].filter(([, total]) => total > 0);
  const tokenGrand = allTokenRows.reduce((sum, [, total]) => sum + total, 0);
  const tokenRows = allTokenRows.slice(-8).reverse();
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
          <ActivityProjectContextSection snapshot={projectContext} />
          <ActivityTokenSection
            executionCount={allTokenRows.length}
            grand={tokenGrand}
            rows={tokenRows}
          />
          <ActivityDetailsSection fields={details} />
          <GroupDecisionsSection groupId={groupId} labels={labels} />
        </>
      }
    />
  );
}

function ActivityTokenSection({
  rows,
  grand,
  executionCount,
}: {
  rows: readonly [string, number][];
  grand: number;
  executionCount: number;
}) {
  if (executionCount === 0) return null;
  return (
    <section className="mb-3 px-1" data-testid="group-activity-tokens">
      <h3 className="mb-1.5 text-2xs text-fg-faint uppercase tracking-wide">Tokens</h3>
      <p className="mb-1.5 text-2xs text-fg-faint">
        Estimated · ~{formatTokenCount(grand)} across {executionCount}{" "}
        {executionCount === 1 ? "execution" : "executions"}
      </p>
      <ul className="space-y-1">
        {rows.map(([executionId, total]) => (
          <li
            className="flex items-center justify-between gap-2 text-2xs text-fg-muted"
            key={executionId}
          >
            <span className="min-w-0 truncate font-mono" title={executionId}>
              {executionId.slice(0, 8)}
            </span>
            <span className="shrink-0 tabular-nums">~{formatTokenCount(total)}</span>
          </li>
        ))}
      </ul>
    </section>
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

function ActivityDetailsSection({ fields }: { fields: readonly HandoffPacketField[] }) {
  if (fields.length === 0) return null;
  return (
    <section className="mb-3" data-testid="group-activity-details">
      <h3 className="mb-1.5 px-1 text-2xs text-fg-faint uppercase tracking-wide">Details</h3>
      <dl className="flex flex-col gap-1 px-1 text-2xs">
        {fields.map((field, index) => (
          <div
            className="flex gap-2"
            // biome-ignore lint/suspicious/noArrayIndexKey: packet fields can repeat keys
            key={`${field.key}-${index}`}
          >
            <dt className="w-20 shrink-0 text-fg-faint">{field.key}</dt>
            <dd className="min-w-0 flex-1 text-fg-muted">{field.value || "—"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ActivityProjectContextSection({
  snapshot,
}: {
  snapshot: GroupProjectContextSnapshot | undefined;
}) {
  if (!snapshot) return null;
  const lines = formatGroupProjectContextDetails(snapshot);
  return (
    <section className="mb-3" data-testid="group-activity-project-context">
      <div className="mb-1.5 px-1">
        <GroupProjectContextChip status={snapshot.status} />
      </div>
      <ul className="flex flex-col gap-0.5 px-1 text-2xs text-fg-muted">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
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
