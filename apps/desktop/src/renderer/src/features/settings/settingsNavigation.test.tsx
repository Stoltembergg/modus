import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsSidebar } from "./sections/SettingsSidebar";
import type { SettingsSectionId } from "./settings-types";
import {
  filterSettingsNav,
  groupSettingsNav,
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
} from "./settingsNav";

const NAV_LABELS = [
  "General",
  "Model & Provider",
  "Appearance",
  "Personalization",
  "MCP & Integrations",
  "Skills",
  "Subagents",
  "Rules",
] as const;

const GROUPED_NAV = {
  Workspace: ["MCP & Integrations", "Skills", "Subagents", "Rules"],
  Models: ["Model & Provider"],
  Interface: ["General", "Appearance", "Personalization"],
} as const;

const RENDERED_NAV_LABELS = Object.values(GROUPED_NAV).flat();

function renderSidebar({
  activeSection = "general",
  onSectionChange = () => {},
  query,
}: {
  activeSection?: SettingsSectionId;
  onSectionChange?: (section: SettingsSectionId) => void;
  query: string;
}): string {
  return renderToStaticMarkup(
    <SettingsSidebar
      activeSection={activeSection}
      onBack={() => {}}
      onQueryChange={() => {}}
      onSectionChange={onSectionChange}
      query={query}
    />,
  );
}

function activeNavLabel(markup: string): string | undefined {
  const activeButton = markup.split("<button").find((chunk) => chunk.includes("bg-active"));
  return activeButton ? navLabels(activeButton)[0] : undefined;
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

describe("filterSettingsNav", () => {
  it("returns every nav item in order for an empty or whitespace-only query", () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.label)).toEqual(NAV_LABELS);
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "")).toEqual(SETTINGS_NAV_ITEMS);
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "   ")).toEqual(SETTINGS_NAV_ITEMS);
  });

  it("keeps Model & Provider as the single entry point for new provider disclosures", () => {
    // Command Code pricing-unknown text lives under "Model & Provider". A
    // partial-query reachability check guards against accidentally splitting
    // provider UX across multiple nav items.
    const matchByProvider = filterSettingsNav(SETTINGS_NAV_ITEMS, "model");
    expect(matchByProvider.map((item) => item.id)).toEqual(["model-provider"]);
    const matchByName = filterSettingsNav(SETTINGS_NAV_ITEMS, "commandcode");
    expect(matchByName).toEqual([]);
  });

  it("matches partial labels as a substring", () => {
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "en").map((item) => item.label)).toEqual([
      "General",
      "Subagents",
    ]);
  });

  it("matches case-insensitively", () => {
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "mcp").map((item) => item.id)).toEqual(["mcp"]);
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "HARNESS")).toEqual([]);
  });

  it("keeps Composio setup inside MCP rather than exposing a separate Integrations tab", () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.id)).not.toContain("integrations");
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "mcp").map((item) => item.id)).toEqual(["mcp"]);
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "composio").map((item) => item.id)).toEqual([]);
  });

  it("does not expose internal memory, harness controls, failure blacklist, or Limits", () => {
    const hiddenIds = ["project-memory", "harness-insights", "failure-blacklist", "limits"];
    const hiddenLabels = ["Project memory", "Harness Insights", "Failure blacklist", "Limits"];

    for (const id of hiddenIds) {
      expect(SETTINGS_NAV_ITEMS.map((item) => item.id)).not.toContain(id);
    }
    for (const label of hiddenLabels) {
      expect(SETTINGS_NAV_ITEMS.map((item) => item.label)).not.toContain(label);
      expect(navLabels(renderSidebar({ query: label }))).toEqual([]);
    }
  });

  it("trims surrounding whitespace from the query", () => {
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "  limits  ")).toEqual([]);
  });

  it("returns no items when nothing matches", () => {
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "zzz")).toEqual([]);
  });
});

describe("groupSettingsNav", () => {
  it("assigns every nav item to Workspace, Models, or Interface in display order", () => {
    expect(SETTINGS_NAV_GROUPS.map((group) => group.title)).toEqual(Object.keys(GROUPED_NAV));
    expect(
      groupSettingsNav(SETTINGS_NAV_ITEMS).map(({ group, items }) => [
        group.title,
        items.map((item) => item.label),
      ]),
    ).toEqual(Object.entries(GROUPED_NAV));
  });
});

describe("Settings navigation search", () => {
  it("shows only user-facing nav items when the query is empty", () => {
    const markup = renderSidebar({ query: "" });

    expect(navLabels(markup)).toEqual(RENDERED_NAV_LABELS);
    expect(groupHeadings(markup)).toEqual(Object.keys(GROUPED_NAV));
    expect(markup).not.toContain("No settings match");
  });

  it("filters nav items by a partial, case-insensitive, trimmed query", () => {
    expect(navLabels(renderSidebar({ query: "mod" }))).toEqual(["Model & Provider"]);
    expect(navLabels(renderSidebar({ query: "PROJECT" }))).toEqual([]);

    const trimmed = renderSidebar({ query: "  skills " });
    expect(navLabels(trimmed)).toEqual(["Skills"]);
    expect(trimmed).toContain('value="  skills "');
  });

  it("hides a group together with its heading when none of its items match", () => {
    const appear = renderSidebar({ query: "appear" });
    expect(groupHeadings(appear)).toEqual(["Interface"]);
    expect(navLabels(appear)).toEqual(["Appearance"]);

    const limit = renderSidebar({ query: "limit" });
    expect(groupHeadings(limit)).toEqual([]);
    expect(navLabels(limit)).toEqual([]);
    expect(limit).toContain("No settings match");
  });

  it("keeps the heading of every group that still has a partial match", () => {
    const markup = renderSidebar({ query: "li" });

    expect(groupHeadings(markup)).toEqual(["Interface"]);
    expect(navLabels(markup)).toEqual(["Personalization"]);

    const acrossAll = renderSidebar({ query: "en" });
    expect(groupHeadings(acrossAll)).toEqual(["Workspace", "Interface"]);
    expect(navLabels(acrossAll)).toEqual(["Subagents", "General"]);
  });

  it("shows an empty state when no nav item matches", () => {
    const markup = renderSidebar({ query: "no such setting" });

    expect(navLabels(markup)).toEqual([]);
    expect(groupHeadings(markup)).toEqual([]);
    expect(markup).toContain("No settings match");
    expect(markup).toContain('value="no such setting"');
  });

  it("keeps the active section when it is filtered out of the nav", () => {
    const onSectionChange = vi.fn();
    const markup = renderSidebar({ activeSection: "subagents", onSectionChange, query: "model" });

    expect(navLabels(markup)).toEqual(["Model & Provider"]);
    expect(activeNavLabel(markup)).toBeUndefined();
    expect(onSectionChange).not.toHaveBeenCalled();

    const cleared = renderSidebar({ activeSection: "subagents", onSectionChange, query: "" });
    expect(navLabels(cleared)).toEqual(RENDERED_NAV_LABELS);
    expect(activeNavLabel(cleared)).toBe("Subagents");
    expect(onSectionChange).not.toHaveBeenCalled();
  });
});
