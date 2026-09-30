import { IconCrown, IconCrownOff, IconPencil, IconUserMinus } from "@tabler/icons-react";
import { AgentAvatar } from "../../features/agents/AgentAvatar";
import type { GroupAgentRow } from "../../features/groups/groupSidebarModel";
import { MemberName } from "../../features/groups/MemberName";
import type { MemberLabel } from "../../features/groups/memberLabels";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { RowIconButton } from "./helpers";
import { SB_ACTION, SB_ACTION_STROKE, SB_RAIL, SB_ROW } from "./shared";

export function MemberRow({
  row,
  label,
  isActive,
  onSelect,
  onEdit,
  onToggleLead,
  onRemove,
}: {
  row: GroupAgentRow;
  label: MemberLabel;
  isActive: boolean;
  onSelect(): void;
  onEdit?: (() => void) | undefined;
  onToggleLead(): void;
  onRemove(): void;
}) {
  const { isLead, role } = row;
  return (
    <div
      className={cn(
        SB_ROW,
        "group",
        isActive ? "row-selected" : "text-fg-subtle hover:bg-hover hover:text-fg-muted",
        row.state === "archived" && "opacity-70",
      )}
      data-agent-id={row.agentId}
      data-state={row.state}
      data-testid="group-member-row"
    >
      <span className={SB_RAIL}>
        <AgentAvatar
          color={row.color}
          face={row.face}
          seed={row.agentId}
          size={16}
          state={row.state}
        />
      </span>
      <button
        className="flex min-w-0 flex-1 items-center gap-1 pr-1 text-left"
        onClick={onSelect}
        title="Open chat"
        type="button"
      >
        <span className="min-w-0 flex-1 truncate-fade">
          <MemberName label={label} />
        </span>
        {isLead ? (
          <span className="shrink-0 text-fg-faint" title="Lead">
            <IconCrown aria-hidden size={ICON.xs} stroke={ICON_STROKE.xs} />
            <span className="sr-only">Lead</span>
          </span>
        ) : null}
        {role ? (
          <span className="max-w-[45%] shrink-0 truncate text-2xs text-fg-faint">{role}</span>
        ) : null}
      </button>
      <span className="ml-0.5 hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
        {onEdit ? (
          <RowIconButton label="Edit agent" onClick={onEdit}>
            <IconPencil size={SB_ACTION} stroke={SB_ACTION_STROKE} />
          </RowIconButton>
        ) : null}
        <RowIconButton label={isLead ? "Remove as lead" : "Make lead"} onClick={onToggleLead}>
          {isLead ? (
            <IconCrownOff size={SB_ACTION} stroke={SB_ACTION_STROKE} />
          ) : (
            <IconCrown size={SB_ACTION} stroke={SB_ACTION_STROKE} />
          )}
        </RowIconButton>
        <RowIconButton label="Remove from group" onClick={onRemove}>
          <IconUserMinus size={SB_ACTION} stroke={SB_ACTION_STROKE} />
        </RowIconButton>
      </span>
    </div>
  );
}
