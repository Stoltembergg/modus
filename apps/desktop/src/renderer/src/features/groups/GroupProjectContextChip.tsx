import type {
  GroupProjectContextSnapshot,
  GroupProjectContextStatus,
} from "../../../../shared/contracts";
import { formatGroupProjectContextLabel } from "../../../../shared/group-project";
import { useGroupText } from "./groupRoomI18n";

/** Compact room chip: Mapping… / Project context · Ready|Updating|Needs refresh. */
export function GroupProjectContextChip({
  status,
}: {
  status: GroupProjectContextStatus | undefined;
}) {
  const t = useGroupText();
  if (!status) return null;
  return (
    <span
      className="shrink-0 rounded-sm border border-hairline px-1.5 py-px text-2xs text-fg-muted"
      data-status={status}
      data-testid="group-project-context-chip"
      title={t("project.contextTitle")}
    >
      {formatGroupProjectContextLabel(status, t.locale)}
    </span>
  );
}

export function projectSetupEventToSnapshot(
  event: Extract<
    import("../../../../shared/contracts").GroupRuntimeEvent,
    { type: "group.project-setup" }
  >,
): GroupProjectContextSnapshot {
  const snapshot: GroupProjectContextSnapshot = {
    workspaceId: event.workspaceId,
    status: event.status,
    fingerprint: event.fingerprint,
    edgeCount: event.edgeCount,
    updatedAt: event.updatedAt,
  };
  if (event.codegraphState) snapshot.codegraphState = event.codegraphState;
  if (event.detail) snapshot.detail = event.detail;
  return snapshot;
}
