import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");

describe("Modus semantic design tokens", () => {
  it("defines the shared semantic visual contract in one place", () => {
    for (const token of [
      "--surface-app",
      "--surface-sidebar",
      "--surface-main",
      "--surface-glass-window",
      "--surface-raised",
      "--surface-glass",
      "--text-primary",
      "--text-secondary",
      "--text-muted",
      "--border-subtle",
      "--border-default",
      "--border-composer",
      "--status-success",
      "--status-danger",
      "--state-drop-border",
      "--state-drop-surface",
      "--shadow-composer",
      "--space-rail-width",
      "--space-rail-gap",
      "--space-rail-padding-top",
      "--space-rail-padding-inline",
      "--space-rail-padding-bottom",
      "--space-rail-item-height",
      "--space-native-titlebar",
      "--space-sidebar-width",
      "--space-row-height",
      "--type-ui",
      "--type-body",
      "--radius-control",
      "--radius-surface",
      "--radius-composer",
      "--motion-fast",
      "--motion-ui",
      "--motion-overlay",
      "--glass-alpha-chrome",
      "--glass-alpha-overlay",
      "--glass-blur",
      "--glass-saturate",
      "--glass-filter",
      "--glass-scrim-blur",
      "--glass-scrim-filter",
      "--overlay-scrim-color",
      "--overlay-shadow",
      "--scrollbar-thumb",
    ]) {
      expect(css, `${token} is declared`).toContain(token);
    }
  });

  it("keeps glass and backdrop blur on the elevated surface only", () => {
    const glassSurface = css.match(/(?:^|\n)\.surface-glass\s*\{([^}]+)\}/)?.[1] ?? "";
    const mainSurface = css.match(/(?:^|\n)\.surface-main\s*\{([^}]+)\}/)?.[1] ?? "";
    const sidebarSurface = css.match(/(?:^|\n)\.surface-sidebar\s*\{([^}]+)\}/)?.[1] ?? "";
    const popup = css.match(/(?:^|\n)\.popup-chrome\s*\{([^}]+)\}/)?.[1] ?? "";
    const scrim = css.match(/(?:^|\n)\.dialog-scrim\s*\{([^}]+)\}/)?.[1] ?? "";

    expect(glassSurface).not.toContain("backdrop-filter");
    expect(glassSurface).toContain("background-color: var(--surface-glass)");
    expect(mainSurface).not.toContain("backdrop-filter");
    expect(sidebarSurface).not.toContain("backdrop-filter");
    expect(popup).toContain("background: var(--surface-glass)");
    expect(popup).not.toContain("backdrop-filter");
    expect(popup).toContain("border-radius: var(--radius-overlay)");
    expect(popup).not.toMatch(/blur\(\d/);
    expect(scrim).not.toContain("backdrop-filter");
    // D2: canvas / overlay glass only in Transparency "full"; the left chrome in both modes.
    expect(css).toContain(
      ':root[data-native-glass="true"][data-transparency="full"] .dialog-scrim',
    );
    expect(css).toContain(
      ':root[data-native-glass="true"][data-transparency="full"] .surface-glass',
    );
    expect(css).toContain(':root[data-native-glass="true"] .app-context-sidebar');
    expect(css).toContain(
      ':root[data-native-glass="true"][data-transparency="full"] .app-layout-row .surface-main',
    );
    expect(css).toContain("--surface-glass: var(--surface-raised)");
    // Uniform glass: the canvas joins the window layer in Full, with no blur of its own.
    expect(css).toMatch(
      /:root\[data-native-glass="true"\]\[data-transparency="full"\] \.app-layout-row \.surface-main,[^{]*\{[^}]*background-color: transparent;[^}]*backdrop-filter: none/su,
    );
    expect(css).not.toContain(".chat-scroll-top-blur");
    const composerDock = css.match(/\.composer-dock-shell\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(composerDock).toContain("border: 1px solid var(--border-composer)");
    expect(composerDock).toContain("border-radius: var(--radius-composer)");
    expect(composerDock).toContain("background-color: var(--surface-raised)");
    expect(composerDock).toContain("box-shadow: var(--shadow-composer)");
  });

  it("the dialog surface only reshapes .popup-chrome (radius + shadow), never its own glass", () => {
    const dialog = css.match(/(?:^|\n)\.surface-dialog\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(dialog).toContain("border-radius: var(--radius-xl)");
    expect(dialog).toContain("box-shadow: var(--dialog-shadow)");
    // Fill and blur stay with .popup-chrome (glass in Full, solid otherwise and in fallbacks).
    expect(dialog).not.toMatch(/background|backdrop-filter/);
    expect(css).not.toMatch(/\.surface-dialog[^{]*\{[^}]*backdrop-filter/);
    // Declared after .popup-chrome so the shared specificity resolves to the dialog shape.
    expect(css.indexOf("\n.surface-dialog {")).toBeGreaterThan(css.indexOf("\n.popup-chrome {"));
    // Each theme has its own dialog shadow (the light one is soft, not the dark 0.68 black).
    const light = css.match(/:root\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(light).toMatch(/--dialog-shadow:/);
  });

  it("adds only a light translucent tint to app surfaces", () => {
    expect(css).toMatch(
      /--surface-app:\s*color-mix\(in srgb, var\(--color-panel\) 97%, transparent\)/,
    );
    expect(css).toMatch(
      /--surface-sidebar:\s*color-mix\(in srgb, var\(--color-panel\) 94%, transparent\)/,
    );
    expect(css).toMatch(/--surface-main:\s*var\(--color-canvas\)/);
    // One window-level tint (uniform glass) replaces the per-canvas tier.
    expect(css).toMatch(
      /--surface-glass-window:\s*color-mix\(\s*in srgb,\s*var\(--color-panel\) var\(--glass-alpha-chrome\),\s*transparent\s*\)/,
    );
    expect(css).not.toContain("--glass-alpha-canvas");
    expect(css).not.toContain("--surface-main-glass");
    const mainSurface = css.match(/(?:^|\n)\.surface-main\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(mainSurface).not.toContain("backdrop-filter");
  });

  it("keeps the Groups prompt bar focus treatment neutral and its toolbar integrated", () => {
    const focusState = css.match(/\.group-prompt-bar:focus-within\s*\{([^}]+)\}/)?.[1] ?? "";

    expect(focusState).toContain("border-color: var(--border-strong)");
    expect(focusState).toContain("box-shadow: var(--shadow-composer)");
    expect(focusState).not.toContain("--color-focus-ring");
    expect(focusState).not.toContain("shadow-composer-focus");
    expect(css).toContain(".group-composer-toolbar");
  });

  it("does not render custom caption controls in the application chrome", () => {
    expect(app).not.toContain("WindowControls");
    expect(app).not.toContain("CaptionButton");
  });

  it("has no Groups empty state (Groups were retired in PR 4)", () => {
    expect(app).not.toContain('key="groups-empty"');
    expect(app).not.toContain("AGENTIC TEAMS");
  });

  it("removes the top overflow menu because Settings lives in the app rail", () => {
    const headerActions = readFileSync(
      new URL("../features/agent/SessionHeaderActions.tsx", import.meta.url),
      "utf8",
    ).split("export function HeaderActions(")[1];

    expect(headerActions).toBeDefined();
    expect(headerActions).not.toContain("<ChromeMoreMenu");
    expect(app).not.toContain("<ChromeMoreMenu");
  });

  it("keeps the rail aligned with the top chrome across routes and platforms", () => {
    expect(css).toContain("--space-rail-padding-top");
    expect(css).toMatch(
      /\.app-rail-top-chrome-clearance\s*\{[^}]*padding-top: calc\(var\(--space-native-titlebar\) \+ var\(--space-rail-padding-top\)\)/su,
    );
    expect(css).toMatch(
      /\.app-rail::after\s*\{[^}]*border-right: 1px solid var\(--border-subtle\)/su,
    );
    expect(css).toMatch(
      /\.app-rail-top-chrome-clearance::after\s*\{[^}]*top: var\(--space-native-titlebar\)/su,
    );
    expect(css).toMatch(/\.menu-bar\s*\{[^}]*height: var\(--space-native-titlebar\)/su);
    expect(css).toMatch(/\.toolbar-row\s*\{[^}]*height: var\(--space-native-titlebar\)/su);
    expect(app).toContain("topChromeClearance={!settingsOpen}");
  });

  it("keeps the Direct Messages folder selector out of its composer footer", () => {
    const heroTray =
      app.split("function HeroEnvironmentTray(")[1]?.split("function WorkspaceMenu(")[0] ?? "";

    expect(heroTray).not.toContain("<WorkspaceMenu");
    expect(app.match(/<WorkspaceMenu\b/g) ?? []).toHaveLength(1);
  });

  it("uses the same semantic surface aliases in dark, light, and dark-plus themes", () => {
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain(':root[data-theme="dark-plus"]');
    expect(css).toMatch(
      /--surface-app:\s*color-mix\(in srgb, var\(--color-panel\) 97%, transparent\)/,
    );
    expect(css).toMatch(
      /--surface-sidebar:\s*color-mix\(in srgb, var\(--color-panel\) 94%, transparent\)/,
    );
    expect(css).toMatch(/--surface-raised:\s*var\(--color-elevated\)/);
  });
});
