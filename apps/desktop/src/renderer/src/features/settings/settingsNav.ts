import type { SettingsSectionId } from "./settings-types";

export type SettingsNavItem = {
  id: SettingsSectionId;
  label: string;
};

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  { id: "general", label: "General" },
  { id: "model-provider", label: "Model & Provider" },
  { id: "appearance", label: "Appearance" },
  { id: "personalization", label: "Personalization" },
  { id: "project-memory", label: "Project memory" },
  { id: "harness-insights", label: "Harness Insights" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "subagents", label: "Subagents" },
  { id: "rules", label: "Rules" },
  { id: "limits", label: "Limits" },
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
