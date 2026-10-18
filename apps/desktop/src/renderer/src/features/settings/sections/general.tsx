import type { WorkspaceInfo } from "../../../../../shared/contracts";
import { useSettingsText } from "../../../lib/settingsText";
import { ApprovalModeSettings } from "../ApprovalModeSettings";
import { AskMissingTargetSetting } from "../AskMissingTargetSetting";
import { LanguageSetting } from "../LanguageSetting";
import { SettingsList, SettingsPageHeader } from "../settings-layout";
import { ToolFilterSetting } from "../ToolFilterSetting";

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
      <LanguageSetting />
      <ApprovalModeSettings {...(cwd ? { cwd } : {})} workspaces={workspaces} />
      <SettingsList>
        <AskMissingTargetSetting />
        <ToolFilterSetting />
      </SettingsList>
    </>
  );
}
