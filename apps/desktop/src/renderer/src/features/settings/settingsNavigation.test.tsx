import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsSidebar } from "./sections/SettingsSidebar";
import type { SettingsSectionId } from "./settings-types";
import {
  filterSettingsNav,
  groupSettingsNav,
  normalizeSettingsSection,
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
} from "./settingsNav";

const NAV_LABELS = [
  "General",
  "Appearance",
  "Personalization",
  "Integrations",
  "MCP",
  "Skills",
  "Subagents",
  "Rules",
  "Model & Provider",
] as const;

const GROUPED_NAV = {
  Interface: ["General", "Appearance", "Personalization"],
  Workspace: ["Integrations", "MCP", "Skills", "Subagents", "Rules"],
  Models: ["Model & Provider"],
} as const;

const RENDERED_NAV_LABELS = Object.values(GROUPED_NAV).flat();

function renderSidebar({
  activeSection = "general",
  query,
}: {
  activeSection?: SettingsSectionId;
  query: string;
}): string {
  return renderToStaticMarkup(
    <SettingsSidebar
      activeSection={activeSection}
      onBack={() => {}}
      onQueryChange={() => {}}
      onSectionChange={() => {}}
      query={query}
    />,
  );
}

function groupHeadings(markup: string): string[] {
  return [...markup.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((match) =>
    (match[1] ?? "").replaceAll("&amp;", "&"),
  );
}

function navLabels(markup: string): string[] {
  return [...markup.matchAll(/<span class="truncate">([^<]*)<\/span>/g)].map((match) =>
    (match[1] ?? "").replaceAll("&amp;", "&"),
  );
}

describe("Settings navigation", () => {
  it("puts General first and hides Limits and the selected workspace sections", () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.label)).toEqual(NAV_LABELS);
    expect(SETTINGS_NAV_ITEMS[0]?.id).toBe("general");
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "limits")).toEqual([]);
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "harness")).toEqual([]);
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "project memory")).toEqual([]);
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "blacklist")).toEqual([]);
  });

  it("keeps Composio integrations separate from generic MCP settings", () => {
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "integration").map((item) => item.id)).toEqual([
      "integrations",
    ]);
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "mcp").map((item) => item.id)).toEqual(["mcp"]);
  });

  it("groups General first, then workspace tools and models", () => {
    expect(SETTINGS_NAV_GROUPS.map((group) => group.title)).toEqual(Object.keys(GROUPED_NAV));
    expect(
      groupSettingsNav(SETTINGS_NAV_ITEMS).map(({ group, items }) => [
        group.title,
        items.map((item) => item.label),
      ]),
    ).toEqual(Object.entries(GROUPED_NAV));
  });

  it("renders only supported navigation entries and hides empty group headings", () => {
    const markup = renderSidebar({ query: "" });

    expect(navLabels(markup)).toEqual(RENDERED_NAV_LABELS);
    expect(groupHeadings(markup)).toEqual(Object.keys(GROUPED_NAV));
    expect(markup).not.toContain("No settings match");
    expect(markup).not.toContain("Harness Insights");
    expect(markup).not.toContain("Project memory");
    expect(markup).not.toContain("Failure blacklist");
    expect(markup).not.toContain("Limits");
  });

  it("falls back to General for sections removed from navigation", () => {
    expect(normalizeSettingsSection("limits")).toBe("general");
    expect(normalizeSettingsSection("harness-insights")).toBe("general");
    expect(normalizeSettingsSection("project-memory")).toBe("general");
    expect(normalizeSettingsSection("failure-blacklist")).toBe("general");
    expect(normalizeSettingsSection("model-provider")).toBe("model-provider");
  });

  it("filters visible settings by a partial case-insensitive query", () => {
    const markup = renderSidebar({ query: "  skills " });
    expect(navLabels(markup)).toEqual(["Skills"]);
    expect(groupHeadings(markup)).toEqual(["Workspace"]);
    expect(markup).toContain('value="  skills "');
  });

  it("keeps model-provider search reachable while removing Limits search", () => {
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "model").map((item) => item.id)).toEqual([
      "model-provider",
    ]);
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "  limits  ")).toEqual([]);
  });
});
