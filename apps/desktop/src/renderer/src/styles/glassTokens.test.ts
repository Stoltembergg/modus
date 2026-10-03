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
  "--glass-alpha-canvas": "--color-canvas",
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
        "--glass-alpha-canvas",
        "--glass-blur",
        "--glass-saturate",
        "--glass-filter",
        "--glass-scrim-blur",
        "--glass-scrim-filter",
        "--surface-glass-sidebar",
        "--surface-glass-elevated",
        "--surface-main-glass",
      ].map((name) => [
        name,
        decl(semanticRoot, name)?.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")"),
      ]),
    );
    expect(tokens).toEqual({
      "--glass-alpha-chrome": "78%",
      "--glass-alpha-overlay": "82%",
      "--glass-alpha-canvas": "94%",
      "--glass-blur": "18px",
      "--glass-saturate": "1.12",
      "--glass-filter": "blur(var(--glass-blur)) saturate(var(--glass-saturate))",
      "--glass-scrim-blur": "2px",
      "--glass-scrim-filter": "blur(var(--glass-scrim-blur))",
      "--surface-glass-sidebar":
        "color-mix(in srgb, var(--color-panel) var(--glass-alpha-chrome), transparent)",
      "--surface-glass-elevated":
        "color-mix(in srgb, var(--color-elevated) var(--glass-alpha-overlay), transparent)",
      "--surface-main-glass":
        "color-mix(in srgb, var(--color-canvas) var(--glass-alpha-canvas), transparent)",
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

    // Order: after every theme override (the last one is light's .pdf-page-chrome)
    // and after the native-glass rules whose selectors it repeats.
    const lastTheme = css.lastIndexOf(":root[data-theme=");
    expect(lastTheme).toBeGreaterThan(
      css.indexOf(':root[data-theme="light"] .pdf-page-chrome') - 1,
    );
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

    // Every translucent glass surface reads a tier token (no fixed alpha left),
    // including the light pdf chrome that used to be a fixed 94%.
    expect(block(':root[data-theme="light"] .pdf-page-chrome {').body).toContain(
      "var(--glass-alpha-canvas)",
    );
    for (const m of css.matchAll(/(?<![-(])backdrop-filter:\s*([^;]+);/g)) {
      expect(m[1]).toMatch(/^(none|var\(--glass-(scrim-)?filter\))$/);
    }
  });
});

/**
 * D2 acceptance gate (Debbie, 2026-10-03). With nativeTheme synced, the OS
 * material behind a dark app is the dark material. Provisional worst case for
 * it: #cccccc (dark app, white wallpaper / white window behind). A real P95
 * sample from macOS / Win11 may only make this darker in reality; the gate
 * never loosens past #cccccc.
 */
const OS_BACKDROP_DARK: Rgb = [0xcc, 0xcc, 0xcc];
const D2_GATE = 4.5;

function themesWithGlass(): Theme[] {
  const os = { dark: true, reducedTransparency: false, highContrast: false };
  return THEMES.filter((theme) =>
    [
      resolveWindowAppearance("darwin", "15.0.0"),
      resolveWindowAppearance("win32", "10.0.22631"),
    ].some(
      (window) =>
        resolveAppearance({ window, preferences: { theme, transparency: "auto" }, os }).glass,
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

  it("(f) the rail and sidebar leave the blur to the OS material (no CSS backdrop-filter)", () => {
    const chrome = block(
      ':root[data-native-glass="true"] .app-rail,\n:root[data-native-glass="true"] .app-context-sidebar {',
    ).body;
    expect(chrome).toContain("var(--surface-glass-sidebar)");
    expect(chrome).not.toMatch(/backdrop-filter/);
  });

  it("(g) only dark and dark-plus can get glass; light is always solid", () => {
    expect(themesWithGlass()).toEqual(["dark", "dark-plus"]);
  });

  it("(h) fg and muted >= 4.5:1 on every glass tier over the #cccccc OS backdrop", () => {
    const results: string[] = [];
    for (const theme of themesWithGlass()) {
      for (const tier of Object.keys(TIERS) as (keyof typeof TIERS)[]) {
        for (const text of ["--color-fg", "--color-fg-muted"]) {
          const ratio = worst(theme, tier, text, [OS_BACKDROP_DARK]);
          results.push(`${theme} ${tier} ${text} ${ratio.toFixed(2)}`);
          expect(ratio, `${theme} ${tier} ${text}`).toBeGreaterThanOrEqual(D2_GATE);
        }
      }
    }
    expect(results).toHaveLength(12);
    // Negative control: without the sync (light material / white desktop behind a
    // dark app) the same tokens fail, which is why D2 couples glass to nativeTheme.
    expect(worst("dark", "--glass-alpha-overlay", "--color-fg-muted", [WHITE])).toBeLessThan(
      D2_GATE,
    );
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
