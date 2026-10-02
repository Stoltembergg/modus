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
      "--glass-filter",
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
    expect(css).toContain(':root[data-native-glass="true"] .dialog-scrim');
    expect(css).toContain(':root[data-native-glass="true"] .surface-glass');
    expect(css).toContain(':root[data-native-glass="true"] .app-context-sidebar');
    expect(css).toContain(':root[data-native-glass="true"] .surface-main');
    expect(css).toContain("--surface-glass: var(--surface-raised)");
    expect(css).toMatch(
      /:root\[data-native-glass="true"\] \.surface-main\s*\{[^}]*backdrop-filter: none/su,
    );
    expect(css).not.toContain(".chat-scroll-top-blur");
    const composerDock = css.match(/\.composer-dock-shell\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(composerDock).toContain("border: 1px solid var(--border-composer)");
    expect(composerDock).toContain("border-radius: var(--radius-composer)");
    expect(composerDock).toContain("background-color: var(--surface-raised)");
    expect(composerDock).toContain("box-shadow: var(--shadow-composer)");
  });

  it("adds only a light translucent tint to app surfaces", () => {
    expect(css).toMatch(
      /--surface-app:\s*color-mix\(in srgb, var\(--color-panel\) 97%, transparent\)/,
    );
    expect(css).toMatch(
      /--surface-sidebar:\s*color-mix\(in srgb, var\(--color-panel\) 94%, transparent\)/,
    );
    expect(css).toMatch(
      /--surface-main:\s*color-mix\(in srgb, var\(--color-canvas\) 98%, transparent\)/,
    );
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

  it("keeps the Groups empty state concise with beams confined to its background", () => {
    const emptyState = app.split('key="groups-empty"')[1]?.split(") : visibleGroup ?")[0] ?? "";

    expect(emptyState).toContain("AGENTIC TEAMS");
    expect(emptyState).not.toContain("Choose a group from the sidebar");
    expect(emptyState).toContain("group-empty-beams");
    expect(css).toContain(".group-empty-beams");
    expect(css).toContain("@keyframes group-empty-beam-sweep");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("removes the top overflow menu because Settings lives in the app rail", () => {
    const headerActions =
      app.split("function HeaderActions(")[1]?.split("function EnvironmentPopover(")[0] ?? "";

    expect(headerActions).not.toContain("<ChromeMoreMenu");
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
