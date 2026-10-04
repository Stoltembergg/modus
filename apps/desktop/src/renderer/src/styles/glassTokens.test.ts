import { readFileSync } from "node:fs";
import { optimize } from "@tailwindcss/node";
import { describe, expect, it } from "vitest";
import {
  resolveAppearance,
  SOLID_WINDOW_BACKGROUND,
  WINDOW_SYMBOL_COLOR,
} from "../../../shared/appearance";
import { resolveWindowAppearance } from "../../../shared/window-appearance";

/**
 * D1 glass tokens. (a) pins the token table (a value change is a deliberate
 * edit here), (b) gates text contrast on every native-glass tier with a
 * pessimistic model (surface composited over a white / mid-grey / black
 * backdrop, no blur, no OS material tint), (c) proves the solid fallback for
 * reduced transparency / more contrast / forced colors / no backdrop-filter
 * wins by source order and specificity.
 */
const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");

type Rgb = [number, number, number];
type Theme = "dark" | "dark-plus" | "light";

/** Body of the first `{…}` block that starts at `selector` (brace-balanced). */
function block(selector: string, from = 0): { body: string; start: number; end: number } {
  const start = css.indexOf(selector, from);
  if (start === -1) throw new Error(`${selector} not found`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: css.slice(open + 1, i), start, end: i };
    }
  }
  throw new Error(`${selector} not terminated`);
}

function decl(body: string, name: string): string | undefined {
  return body.match(new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;]+);`))?.[1]?.trim();
}

const themeBlock = block("@theme {").body;
const semanticRoot = block(":root {\n  --surface-app").body;
const overrides: Record<Theme, string> = {
  dark: "",
  "dark-plus": block(':root[data-theme="dark-plus"] {').body,
  light: block(':root[data-theme="light"] {').body,
};

function color(theme: Theme, name: string, depth = 0): Rgb {
  if (depth > 4) throw new Error(`${name}: alias loop`);
  const raw = decl(overrides[theme], name) ?? decl(themeBlock, name);
  if (!raw) throw new Error(`${name} not declared for ${theme}`);
  const alias = raw.match(/^var\((--[\w-]+)\)$/);
  if (alias?.[1]) return color(theme, alias[1], depth + 1);
  const hex = raw.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) throw new Error(`${name} for ${theme} is not a hex colour: ${raw}`);
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function alpha(token: string): number {
  const raw = decl(semanticRoot, token);
  const pct = raw?.match(/^(\d+(?:\.\d+)?)%$/)?.[1];
  if (!pct) throw new Error(`${token} is not a percentage: ${raw}`);
  return Number(pct) / 100;
}

const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const over = (a: number, top: Rgb, bottom: Rgb): Rgb =>
  top.map((c, i) => a * c + (1 - a) * (bottom[i] ?? 0)) as Rgb;

const WHITE: Rgb = [255, 255, 255];
const GREY: Rgb = [128, 128, 128];
const BLACK: Rgb = [0, 0, 0];
const THEMES: Theme[] = ["dark", "dark-plus", "light"];
/** Glass tier → the base colour it tints. */
const TIERS = {
  "--glass-alpha-chrome": "--color-panel",
  "--glass-alpha-overlay": "--color-elevated",
} as const;

/** Smallest contrast of a text tier on a glass tier over the given backdrops. */
function worst(theme: Theme, tier: keyof typeof TIERS, text: string, backdrops: Rgb[], a?: number) {
  const surface = color(theme, TIERS[tier]);
  const ink = color(theme, text);
  return Math.min(...backdrops.map((bg) => contrast(ink, over(a ?? alpha(tier), surface, bg))));
}

describe("glass tokens (D1)", () => {
  it("(a) pins the token table: current values, one set for every theme", () => {
    const tokens = Object.fromEntries(
      [
        "--glass-alpha-chrome",
        "--glass-alpha-overlay",
        "--glass-blur",
        "--glass-saturate",
        "--glass-filter",
        "--glass-scrim-blur",
        "--glass-scrim-filter",
        "--surface-glass-sidebar",
        "--surface-glass-elevated",
        "--surface-glass-window",
      ].map((name) => [
        name,
        decl(semanticRoot, name)?.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")"),
      ]),
    );
    expect(tokens).toEqual({
      "--glass-alpha-chrome": "78%",
      "--glass-alpha-overlay": "82%",
      "--glass-blur": "18px",
      "--glass-saturate": "1.12",
      "--glass-filter": "blur(var(--glass-blur)) saturate(var(--glass-saturate))",
      "--glass-scrim-blur": "2px",
      "--glass-scrim-filter": "blur(var(--glass-scrim-blur))",
      "--surface-glass-sidebar":
        "color-mix(in srgb, var(--color-panel) var(--glass-alpha-chrome), transparent)",
      "--surface-glass-elevated":
        "color-mix(in srgb, var(--color-elevated) var(--glass-alpha-overlay), transparent)",
      "--surface-glass-window":
        "color-mix(in srgb, var(--color-panel) var(--glass-alpha-chrome), transparent)",
    });
    for (const theme of ["dark-plus", "light"] as const) {
      expect(overrides[theme], `${theme} must not override glass tokens`).not.toMatch(/--glass-/);
    }
  });

  it("(b) text on every glass tier meets the contrast gate in dark, dark-plus and light", () => {
    for (const theme of THEMES) {
      // The OS backdrop most likely behind this theme (a dark app on a dark desktop).
      const likely = theme === "light" ? WHITE : BLACK;
      for (const tier of Object.keys(TIERS) as (keyof typeof TIERS)[]) {
        const at = `${theme} ${tier}`;
        expect(
          worst(theme, tier, "--color-fg", [WHITE, GREY, BLACK]),
          `${at} fg`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          worst(theme, tier, "--color-fg-muted", [GREY, likely]),
          `${at} muted`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          worst(theme, tier, "--color-fg-subtle", [GREY]),
          `${at} subtle`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("(b) the gate rejects the thinner chrome tier the redesign brief floated (72%)", () => {
    // dark-plus fg over a white desktop drops to ~4.2:1 at 72%.
    expect(worst("dark-plus", "--glass-alpha-chrome", "--color-fg", [WHITE], 0.72)).toBeLessThan(
      4.5,
    );
  });

  it("(c) the solid fallback is last, zeroes every tier and wins order and specificity", () => {
    const media = block(
      "@media (prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active) {",
    );
    const supports = block(
      "@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {",
    );
    for (const fallback of [media, supports]) {
      const root = block(":root {", fallback.start).body;
      for (const tier of Object.keys(TIERS)) expect(decl(root, tier)).toBe("100%");
      expect(decl(root, "--glass-filter")).toBe("none");
      expect(decl(root, "--glass-scrim-filter")).toBe("none");
      expect(fallback.body).toMatch(
        /:root\[data-native-glass="true"\] body,\s*:root\[data-native-glass="true"\] #root \{\s*background-color: var\(--color-canvas\);/,
      );
      expect(fallback.body).toMatch(
        /:root\[data-native-glass="true"\] \.app-shell \{\s*background-color: var\(--color-panel\);/,
      );
    }

    // Order: after every theme override and after the native-glass rules whose
    // selectors it repeats.
    const lastTheme = css.lastIndexOf(":root[data-theme=");
    expect(media.start).toBeGreaterThan(lastTheme);
    expect(media.start).toBeGreaterThan(
      css.lastIndexOf(':root[data-native-glass="true"]', media.start),
    );
    expect(supports.start).toBeGreaterThan(media.end);
    expect(css.slice(supports.end + 1).trim()).toBe("");

    // Specificity: the glass tokens are declared only on plain :root (the base
    // block and the two fallbacks), so no theme or attribute selector can beat them.
    const declarations = [...css.matchAll(/--glass-alpha-chrome:/g)].map((m) => m.index ?? 0);
    expect(declarations).toHaveLength(3);
    expect(declarations[1]).toBeGreaterThan(media.start);
    expect(declarations[2]).toBeGreaterThan(supports.start);

    // Every translucent glass surface reads a tier token (no fixed alpha left).
    // D2 dropped light's always-translucent .pdf-page-chrome: it now follows the
    // same Transparency mode as every other theme.
    expect(css).not.toContain(':root[data-theme="light"] .pdf-page-chrome');
    for (const m of css.matchAll(/(?<![-(])backdrop-filter:\s*([^;]+);/g)) {
      expect(m[1]).toMatch(/^(none|var\(--glass-(scrim-)?filter\))$/);
    }
  });
});

/**
 * D2 acceptance gate (Debbie, 2026-10-03; light added 15:49 BRT). With
 * nativeTheme synced, the OS material behind the app follows the app theme,
 * and the worst case is the opposite-luminance desktop showing through it:
 * - dark / dark-plus over #cccccc (dark app, white wallpaper; macOS also a
 *   white window behind). Real sample later: P95 luminance of sidebar+rail.
 * - light over #333333, the mirror of #cccccc (light app, black wallpaper;
 *   macOS also a dark window behind). Real sample later: P5 luminance (P95 of
 *   darkness) of sidebar+rail.
 * Samples can only tighten these backdrops; the gate never loosens.
 */
const OS_BACKDROP: Record<Theme, Rgb> = {
  dark: [0xcc, 0xcc, 0xcc],
  "dark-plus": [0xcc, 0xcc, 0xcc],
  light: [0x33, 0x33, 0x33],
};
const D2_GATE = 4.5;

function themesWithGlass(): Theme[] {
  const os = { dark: true, reducedTransparency: false, highContrast: false };
  return THEMES.filter((theme) =>
    [
      resolveWindowAppearance("darwin", "15.0.0"),
      resolveWindowAppearance("win32", "10.0.22631"),
    ].every((window) =>
      (["sidebar", "full"] as const).every(
        (transparency) =>
          resolveAppearance({ window, preferences: { theme, transparency }, os }).glass,
      ),
    ),
  );
}

describe("glass in production (D2)", () => {
  it("(d) every backdrop-filter is preceded by its -webkit- twin so Lightning CSS keeps both", () => {
    const rules = [...css.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] ?? "");
    let checked = 0;
    for (const body of rules) {
      const standard = body.search(/(?<![-\w])backdrop-filter:\s*var\(/);
      if (standard === -1) continue;
      const prefixed = body.indexOf("-webkit-backdrop-filter:");
      expect(prefixed, body.trim()).toBeGreaterThan(-1);
      expect(prefixed, body.trim()).toBeLessThan(standard);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it("(e) the production minifier (Lightning CSS via Tailwind) emits the standard property", () => {
    // Every innermost rule body that sets a glass backdrop-filter, re-wrapped and
    // run through the same optimize() step `electron-vite build` uses.
    const bodies = [...css.matchAll(/\{([^{}]*backdrop-filter:\s*var\(--glass[^{}]*)\}/g)].map(
      (m, i) => `.r${i}{${m[1]}}`,
    );
    expect(bodies.length).toBeGreaterThanOrEqual(5);
    const out = optimize(bodies.join("\n"), { minify: true }).code;
    for (let i = 0; i < bodies.length; i += 1) {
      const rule = out.match(new RegExp(`\\.r${i}\\{([^}]*)\\}`))?.[1] ?? "";
      expect(rule, `rule ${i}`).toMatch(/(^|;)backdrop-filter:var\(--glass/);
      expect(rule, `rule ${i}`).toMatch(/-webkit-backdrop-filter:var\(--glass/);
    }
  });

  it("(f) rail and sidebar share one base glass rule, with no CSS blur of their own", () => {
    const chrome = block(
      ':root[data-native-glass="true"] .app-rail,\n:root[data-native-glass="true"] .app-context-sidebar {',
    ).body;
    // Solid-compatible base: the fallback turns this tier to 100%.
    expect(chrome).toContain("var(--surface-glass-sidebar)");
    // Uniform glass: the only blur behind the panels is the window layer (k).
    expect(chrome).not.toContain("backdrop-filter");
    // Not scoped to a mode: the left chrome is glass in both "sidebar" and "full".
    expect(css).not.toMatch(/data-transparency="(sidebar|full)"\] \.app-(rail|context-sidebar)/);
  });

  it("(g) every theme gets the same glass, with no theme-specific solid override", () => {
    expect(themesWithGlass()).toEqual(["dark", "dark-plus", "light"]);
    // One treatment across the app: glass rules are never scoped to a theme, and
    // the tier alphas are only declared on plain :root (see (a) and (c)).
    for (const m of css.matchAll(/([^{}]*)\{/g)) {
      const selector = m[1] ?? "";
      if (selector.includes("data-native-glass")) expect(selector).not.toMatch(/data-theme/);
    }
  });

  /** Tiers that are translucent per Transparency mode ("off" has none). */
  const MODE_TIERS: Record<"sidebar" | "full", (keyof typeof TIERS)[]> = {
    sidebar: ["--glass-alpha-chrome"],
    // Uniform glass: rail, sidebar and main all sit on the one window tint.
    full: ["--glass-alpha-chrome", "--glass-alpha-overlay"],
  };

  it("(h) fg and muted >= 4.5:1 on every translucent tier, Sidebar and Full, every theme", () => {
    let checked = 0;
    for (const mode of ["sidebar", "full"] as const) {
      for (const theme of themesWithGlass()) {
        for (const tier of MODE_TIERS[mode]) {
          for (const text of ["--color-fg", "--color-fg-muted"]) {
            const ratio = worst(theme, tier, text, [OS_BACKDROP[theme]]);
            expect(ratio, `${mode} ${theme} ${tier} ${text}`).toBeGreaterThanOrEqual(D2_GATE);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(2 * 3 * (1 + 2));
  });

  it("(h) mirrored controls: what the opposite desktop would do without the nativeTheme sync", () => {
    // Dark over a pure white desktop fails on chrome and overlays: glass needs the sync.
    expect(worst("dark", "--glass-alpha-chrome", "--color-fg-muted", [WHITE])).toBeLessThan(
      D2_GATE,
    );
    expect(worst("dark", "--glass-alpha-overlay", "--color-fg-muted", [WHITE])).toBeLessThan(
      D2_GATE,
    );
    // Light holds even over pure black with the current shared alphas (no raise needed)...
    for (const tier of Object.keys(TIERS) as (keyof typeof TIERS)[]) {
      expect(worst("light", tier, "--color-fg-muted", [BLACK]), tier).toBeGreaterThanOrEqual(
        D2_GATE,
      );
    }
    // ...and the light gate is not vacuous: a thinner 60% chrome would fail over #333333.
    expect(
      worst("light", "--glass-alpha-chrome", "--color-fg-muted", [OS_BACKDROP.light], 0.6),
    ).toBeLessThan(D2_GATE);
  });

  it("(k) uniform glass: one tint + blur at the window, panels transparent, gated off for the fallback", () => {
    const gate = block(
      "@media (prefers-reduced-transparency: no-preference) and (prefers-contrast: no-preference) {",
    );
    const forced = block("@media (forced-colors: none) {", gate.start);
    expect(forced.start).toBeLessThan(gate.end);
    const supports = block(
      "@supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {",
      forced.start,
    );
    expect(supports.start).toBeLessThan(forced.end);
    const shell = block(':root[data-native-glass="true"] .app-shell {', supports.start);
    expect(shell.start).toBeLessThan(supports.end);
    expect(shell.body).toContain("background-color: var(--surface-glass-window);");
    expect(shell.body).toMatch(
      /-webkit-backdrop-filter: var\(--glass-filter\);\s*backdrop-filter: var\(--glass-filter\);/,
    );
    const panels = block(
      ':root[data-native-glass="true"] .app-rail,\n      :root',
      supports.start,
    ).body;
    expect(panels).toMatch(
      /background-color: transparent;\s*-webkit-backdrop-filter: none;\s*backdrop-filter: none;/,
    );
    const full = block(
      ':root[data-native-glass="true"][data-transparency="full"] .app-layout-row .surface-main,',
      supports.start,
    ).body;
    expect(full).toContain("border-color: transparent;");
    expect(full).toContain("background-color: transparent;");
    const sidebar = block(
      ':root[data-native-glass="true"][data-transparency="sidebar"] .app-layout-row .surface-main {',
      supports.start,
    ).body;
    // Sidebar mode keeps main opaque; only the sidebar|main line goes.
    expect(sidebar.trim()).toBe("border-left-color: transparent;");
    expect(
      block(':root[data-native-glass="true"] .app-rail::after {', supports.start).body.trim(),
    ).toBe("border-color: transparent;");
    // Only panel-edge border colours change: no outline / focus ring is touched.
    expect(gate.body).not.toMatch(/outline|focus|box-shadow/);
    // The uniform block sits before the solid fallback, which stays last (c).
    expect(gate.end).toBeLessThan(
      css.indexOf("@media (prefers-reduced-transparency: reduce), (prefers-contrast: more)"),
    );
  });

  it("(k) one alpha for rail, sidebar and main: 78% passes the D2 gate for main-area text", () => {
    // Debbie's rule: try 78%; only a failure would move to the smallest passing alpha.
    for (const theme of THEMES) {
      for (const text of ["--color-fg", "--color-fg-muted"]) {
        expect(
          worst(theme, "--glass-alpha-chrome", text, [OS_BACKDROP[theme]]),
          `${theme} ${text}`,
        ).toBeGreaterThanOrEqual(D2_GATE);
      }
    }
    expect(alpha("--glass-alpha-chrome")).toBe(0.78);
  });

  it("(j) every page-level background is cleared under native glass, <html> included", () => {
    // 152a4c2 shipped `:root { background: var(--color-canvas) }` with no glass
    // override: <html> painted the whole window and vibrancy never showed on macOS.
    const prod = optimize(css, { minify: false }).code;
    const topLevel: { selectors: string[]; body: string }[] = [];
    let depth = 0;
    let start = 0;
    let open = -1;
    for (let i = 0; i < prod.length; i += 1) {
      if (prod[i] === "{") {
        if (depth === 0) open = i;
        depth += 1;
      } else if (prod[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          const selector = prod.slice(start, open).trim();
          if (!selector.startsWith("@"))
            topLevel.push({
              selectors: selector.split(",").map((s) => s.trim()),
              body: prod.slice(open + 1, i),
            });
          start = i + 1;
        }
      }
    }
    const paints = (body: string) =>
      /(^|[;{\s])background(-color)?:\s*(?!transparent|#0000\b|none)[^;]+/.test(body);
    const clears = (body: string) =>
      /(^|[;{\s])background(-color)?:\s*(transparent|#0000)\b/.test(body);
    const GLASS = ':root[data-native-glass="true"]';
    const glassSelector: Record<string, string> = {
      ":root": GLASS,
      html: GLASS,
      body: `${GLASS} body`,
      "#root": `${GLASS} #root`,
    };
    let checked = 0;
    for (const [element, cleared] of Object.entries(glassSelector)) {
      if (!topLevel.some((r) => r.selectors.includes(element) && paints(r.body))) continue;
      checked += 1;
      expect(
        topLevel.some((r) => r.selectors.includes(cleared) && clears(r.body)),
        `${element} paints a background but nothing clears it under ${GLASS}`,
      ).toBe(true);
    }
    // :root and body both paint the canvas today; keep the guard meaningful.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("(i) native window colours mirror the palette tokens", () => {
    for (const theme of THEMES) {
      const hex = (rgb: Rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
      expect(SOLID_WINDOW_BACKGROUND[theme], `${theme} canvas`).toBe(
        hex(color(theme, "--color-canvas")),
      );
      expect(WINDOW_SYMBOL_COLOR[theme], `${theme} fg`).toBe(hex(color(theme, "--color-fg")));
    }
  });
});
