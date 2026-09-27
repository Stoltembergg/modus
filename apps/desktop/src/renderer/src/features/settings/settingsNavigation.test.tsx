import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsSidebar } from "./sections/SettingsSidebar";
import type { SettingsSectionId } from "./settings-types";
import { filterSettingsNav, SETTINGS_NAV_ITEMS } from "./settingsNav";

const NAV_LABELS = [
  "General",
  "Model & Provider",
  "Appearance",
  "Personalization",
  "Project memory",
  "Harness Insights",
  "MCP",
  "Skills",
  "Subagents",
  "Rules",
  "Limits",
] as const;

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
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "HARNESS").map((item) => item.id)).toEqual([
      "harness-insights",
    ]);
  });

  it("trims surrounding whitespace from the query", () => {
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "  limits  ").map((item) => item.id)).toEqual([
      "limits",
    ]);
  });

  it("returns no items when nothing matches", () => {
    expect(filterSettingsNav(SETTINGS_NAV_ITEMS, "zzz")).toEqual([]);
  });
});

describe("Settings navigation search", () => {
  it("shows all eleven nav items when the query is empty", () => {
    const markup = renderSidebar({ query: "" });

    expect(navLabels(markup)).toEqual(NAV_LABELS);
    expect(markup).not.toContain("No settings match");
  });

  it("filters nav items by a partial, case-insensitive, trimmed query", () => {
    expect(navLabels(renderSidebar({ query: "mod" }))).toEqual(["Model & Provider"]);
    expect(navLabels(renderSidebar({ query: "PROJECT" }))).toEqual(["Project memory"]);

    const trimmed = renderSidebar({ query: "  skills " });
    expect(navLabels(trimmed)).toEqual(["Skills"]);
    expect(trimmed).toContain('value="  skills "');
  });

  it("shows an empty state when no nav item matches", () => {
    const markup = renderSidebar({ query: "no such setting" });

    expect(navLabels(markup)).toEqual([]);
    expect(markup).toContain("No settings match");
    expect(markup).toContain('value="no such setting"');
  });

  it("keeps the active section when it is filtered out of the nav", () => {
    const onSectionChange = vi.fn();
    const markup = renderSidebar({ activeSection: "limits", onSectionChange, query: "model" });

    expect(navLabels(markup)).toEqual(["Model & Provider"]);
    expect(activeNavLabel(markup)).toBeUndefined();
    expect(onSectionChange).not.toHaveBeenCalled();

    const cleared = renderSidebar({ activeSection: "limits", onSectionChange, query: "" });
    expect(navLabels(cleared)).toEqual(NAV_LABELS);
    expect(activeNavLabel(cleared)).toBe("Limits");
    expect(onSectionChange).not.toHaveBeenCalled();
  });
});
