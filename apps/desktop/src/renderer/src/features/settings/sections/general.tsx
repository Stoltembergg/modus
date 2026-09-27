import type { WorkspaceInfo } from "../../../../../shared/contracts";
import { ApprovalModeSettings } from "../ApprovalModeSettings";
import { SettingsPageHeader } from "../settings-layout";

export function GeneralSettingsPanel({
  cwd,
  workspaces = [],
}: {
  cwd?: string | undefined;
  workspaces?: WorkspaceInfo[] | undefined;
}) {
  return (
    <>
      <SettingsPageHeader
        description="Choose when Modus asks before risky agent actions — globally or per project."
        title="General"
      />
      <ApprovalModeSettings {...(cwd ? { cwd } : {})} workspaces={workspaces} />
    </>
  );
}
