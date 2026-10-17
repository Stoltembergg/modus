import type { WorkspaceInfo } from "../../../../../shared/contracts";
import { ApprovalModeSettings } from "../ApprovalModeSettings";
import { AskMissingTargetSetting } from "../AskMissingTargetSetting";
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
      <SettingsPageHeader title="General" />
      <ApprovalModeSettings {...(cwd ? { cwd } : {})} workspaces={workspaces} />
      <AskMissingTargetSetting />
    </>
  );
}
