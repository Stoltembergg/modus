import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsSidebar } from "./sections/SettingsSidebar";

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

describe("Settings navigation search", () => {
  it("keeps all eleven nav items visible while the sidebar query is non-empty", () => {
    const markup = renderToStaticMarkup(
      <SettingsSidebar
        activeSection="general"
        onBack={() => {}}
        onQueryChange={() => {}}
        onSectionChange={() => {}}
        query="model"
      />,
    );

    for (const label of NAV_LABELS) {
      const htmlLabel = label.includes("&") ? label.replaceAll("&", "&amp;") : label;
      expect(markup).toContain(htmlLabel);
    }
    expect(markup).toContain('value="model"');
  });
});
