import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_PRIMARY_BUTTON,
  SettingsList,
  SettingsNotice,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "./settings-layout";

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const DIVIDER =
  /\b(?:border-[btlrxy]?(?:\s|")|border-hairline|divide-[xy]|last:border|first:border|h-px)/;

describe("minimal settings layout", () => {
  it("page header is only a title (and actions), never a subtitle", () => {
    const html = renderToStaticMarkup(<SettingsPageHeader title="Appearance" />);
    expect(html).toContain("Appearance");
    expect(html).not.toContain("<p");
  });

  it("rows render the label and the control, with no help line", () => {
    const html = renderToStaticMarkup(
      <SettingsRow title="Color scheme" control={<button type="button">Dark</button>} />,
    );
    expect(html).toContain("Color scheme");
    expect(html).not.toContain("<p");
    expect(html).not.toContain("data-settings-notice");
  });

  it("keeps an essential notice visible and complete, with its tone", () => {
    const notice = "No secure OS storage was found, so you will sign in again after restarting.";
    const html = renderToStaticMarkup(
      <SettingsRow
        title="Remember me"
        notice={notice}
        noticeTone="warning"
        control={<span>This session only</span>}
      />,
    );
    expect(html).toContain(notice);
    expect(html).toContain('data-settings-notice="warning"');
    expect(html).not.toContain("truncate");
    expect(renderToStaticMarkup(<SettingsNotice tone="danger">Failed</SettingsNotice>)).toContain(
      'role="alert"',
    );
  });

  it("has no divider or border classes on lists, rows or sections", () => {
    const html = renderToStaticMarkup(
      <SettingsSection title="Theme">
        <SettingsList>
          <SettingsRow title="A" control={null} />
          <SettingsRow title="B" control={null} />
        </SettingsList>
      </SettingsSection>,
    );
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(classes.length).toBeGreaterThan(3);
    for (const name of classes) expect(`${name} `).not.toMatch(DIVIDER);
    expect(html).toContain("settings-group");
    expect(source("./settings-layout.tsx")).not.toMatch(DIVIDER);
  });

  it("glass group CSS has no border and uses the radius scale", () => {
    const css = source("../../styles/app.css");
    const rule = css.match(/\n\.settings-group \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("border-radius: var(--radius-lg)");
    expect(rule).toContain("backdrop-filter: var(--glass-filter)");
    expect(rule).not.toMatch(/\bborder(?!-radius)/);
  });

  it("primary buttons use the accent fill, not fg", () => {
    expect(SETTINGS_PRIMARY_BUTTON).toMatch(/\bbg-accent\b/);
    expect(SETTINGS_PRIMARY_BUTTON).toMatch(/\btext-on-accent\b/);
    expect(SETTINGS_PRIMARY_BUTTON).toMatch(/ring-focus-ring/);
  });

  it("sections and rows animate in with the motion tokens (reduced = fade)", () => {
    const layout = source("./settings-layout.tsx");
    expect(layout).toContain('motionPreset("fadeUp"');
    expect(layout).toContain("reducedFade");
    expect(layout).toContain('tween("base")');
    expect(layout).not.toMatch(/duration:\s*\d/);
  });
});

describe("Settings pages carry no dividers", () => {
  const pages = [
    "./ApprovalModeSettings.tsx",
    "./sections/general.tsx",
    "./sections/appearance.tsx",
    "./sections/account.tsx",
    "./sections/model-provider.tsx",
    "./sections/mcp.tsx",
    "./sections/integrations.tsx",
    "./sections/skills.tsx",
    "./sections/rules.tsx",
    "./sections/personalization.tsx",
  ];
  it.each(pages)("%s has no row/section divider classes", (page) => {
    const text = source(page);
    expect(text).not.toMatch(/border-hairline(?:-soft)? border-[bt]\b|border-[bt] border-hairline/);
    expect(text).not.toMatch(/divide-y|last:border-b-0|h-px flex-1 bg-hairline/);
  });
});
