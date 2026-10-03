import type { SettingsSectionId } from "./settings-types";

export type SettingsNavGroupId = "workspace" | "models" | "interface";

export type SettingsNavGroupDef = {
  id: SettingsNavGroupId;
  title: string;
};

export type SettingsNavEntry = {
  id: SettingsSectionId;
  label: string;
  group: SettingsNavGroupId;
};

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroupDef[] = [
  { id: "workspace", title: "Workspace" },
  { id: "models", title: "Models" },
  { id: "interface", title: "Interface" },
];

// Group membership lives only here: moving an item is a one-field change.
export const SETTINGS_NAV_ITEMS: readonly SettingsNavEntry[] = [
  { id: "general", label: "General", group: "interface" },
  { id: "account", label: "Account", group: "interface" },
  { id: "model-provider", label: "Model & Provider", group: "models" },
  { id: "appearance", label: "Appearance", group: "interface" },
  { id: "personalization", label: "Personalization", group: "interface" },
  { id: "mcp", label: "MCP & Integrations", group: "workspace" },
  { id: "skills", label: "Skills", group: "workspace" },
  { id: "subagents", label: "Subagents", group: "workspace" },
  { id: "rules", label: "Rules", group: "workspace" },
];

export function filterSettingsNav<T extends { label: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...items];
  }
  return items.filter((item) => item.label.toLowerCase().includes(needle));
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
