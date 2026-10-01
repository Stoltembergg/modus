import type { SettingsSectionId } from "./settings-types";

export type SettingsNavGroupId = "interface" | "workspace" | "models";

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
  { id: "interface", title: "Interface" },
  { id: "workspace", title: "Workspace" },
  { id: "models", title: "Models" },
];

// Group membership lives only here: moving an item is a one-field change.
export const SETTINGS_NAV_ITEMS: readonly SettingsNavEntry[] = [
  { id: "general", label: "General", group: "interface" },
  { id: "appearance", label: "Appearance", group: "interface" },
  { id: "personalization", label: "Personalization", group: "interface" },
  { id: "integrations", label: "Integrations", group: "workspace" },
  { id: "mcp", label: "MCP", group: "workspace" },
  { id: "skills", label: "Skills", group: "workspace" },
  { id: "subagents", label: "Subagents", group: "workspace" },
  { id: "rules", label: "Rules", group: "workspace" },
  { id: "model-provider", label: "Model & Provider", group: "models" },
];

/** Hidden/removed sections resolve to General when opened through a stale route. */
export function normalizeSettingsSection(section: SettingsSectionId): SettingsSectionId {
  return SETTINGS_NAV_ITEMS.some((item) => item.id === section) ? section : "general";
}

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
