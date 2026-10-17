import type { SettingsTextKey } from "../../../../shared/settings-text";
import type { SettingsSectionId } from "./settings-types";

export type SettingsNavGroupId = "workspace" | "models" | "interface";

export type SettingsNavGroupDef = {
  id: SettingsNavGroupId;
  title: string;
  titleKey: SettingsTextKey;
};

export type SettingsNavEntry = {
  id: SettingsSectionId;
  label: string;
  labelKey: SettingsTextKey;
  group: SettingsNavGroupId;
};

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroupDef[] = [
  { id: "workspace", title: "Workspace", titleKey: "settings.window.navGroupWorkspace" },
  { id: "models", title: "Models", titleKey: "settings.window.navGroupModels" },
  { id: "interface", title: "Interface", titleKey: "settings.window.navGroupInterface" },
];

// Group membership lives only here: moving an item is a one-field change.
export const SETTINGS_NAV_ITEMS: readonly SettingsNavEntry[] = [
  { id: "general", label: "General", labelKey: "settings.window.navGeneral", group: "interface" },
  { id: "account", label: "Account", labelKey: "settings.window.navAccount", group: "interface" },
  {
    id: "model-provider",
    label: "Model & Provider",
    labelKey: "settings.window.navModelProvider",
    group: "models",
  },
  {
    id: "appearance",
    label: "Appearance",
    labelKey: "settings.window.navAppearance",
    group: "interface",
  },
  {
    id: "personalization",
    label: "Personalization",
    labelKey: "settings.window.navPersonalization",
    group: "interface",
  },
  {
    id: "mcp",
    label: "MCP & Integrations",
    labelKey: "settings.window.navMcp",
    group: "workspace",
  },
  { id: "skills", label: "Skills", labelKey: "settings.window.navSkills", group: "workspace" },
  { id: "rules", label: "Rules", labelKey: "settings.window.navRules", group: "workspace" },
];

export function filterSettingsNav<T extends { label: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...items];
  }
  const needleFolded = needle.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return items.filter((item) => {
    const labelLower = item.label.toLowerCase();
    if (labelLower.includes(needle)) {
      return true;
    }
    return labelLower
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .includes(needleFolded);
  });
}

export function groupSettingsNav<T extends { group: SettingsNavGroupId }>(
  items: readonly T[],
  groups: readonly SettingsNavGroupDef[] = SETTINGS_NAV_GROUPS,
): { group: SettingsNavGroupDef; items: T[] }[] {
  return groups.map((group) => ({
    group,
    items: items.filter((item) => item.group === group.id),
  }));
}
