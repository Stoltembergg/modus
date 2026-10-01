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

  it("does not render custom caption controls in the application chrome", () => {
    expect(app).not.toContain("WindowControls");
    expect(app).not.toContain("CaptionButton");
  });

  it("uses the same semantic surface aliases in dark, light, and dark-plus themes", () => {
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain(':root[data-theme="dark-plus"]');
    expect(css).toMatch(/--surface-app:\s*var\(--color-panel\)/);
    expect(css).toMatch(/--surface-sidebar:\s*var\(--color-panel\)/);
    expect(css).toMatch(/--surface-raised:\s*var\(--color-elevated\)/);
  });
});
