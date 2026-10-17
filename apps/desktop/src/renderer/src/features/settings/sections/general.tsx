import type { WorkspaceInfo } from "../../../../../shared/contracts";
import { useSettingsText } from "../../../lib/settingsText";
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
  const t = useSettingsText();
  return (
    <>
      <SettingsPageHeader title={t("settings.general.title")} />
      <ApprovalModeSettings {...(cwd ? { cwd } : {})} workspaces={workspaces} />
      <AskMissingTargetSetting />
    </>
  );
}
