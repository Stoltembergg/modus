import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NEW_LOOK_SOLID_WINDOW_BACKGROUND,
  NEW_LOOK_WINDOW_SYMBOL_COLOR,
} from "../../../shared/appearance";

/**
 * New look tokens (redesign Phase 1, PR 1). (a) every rule is scoped to
 * :root[data-ui="new"] so the classic look cannot change, (b) the token table
 * is pinned, (c) text contrast on every glass tier uses the same pessimistic
 * model as glassTokens.test.ts (surface over a white / mid-grey / black
 * backdrop, no blur, no OS material) and adds the faint tier, (d) the solid
 * fallback re-zeroes the new alphas last in the cascade.
 */
const css = readFileSync(new URL("./tokens-new.css", import.meta.url), "utf8");
const appCss = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const mainTsx = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");

type Rgb = [number, number, number];
type Theme = "dark" | "light";

const DARK_SELECTOR = ':root[data-ui="new"] {';
const LIGHT_SELECTOR = ':root[data-ui="new"][data-theme="light"] {';

function block(source: string, selector: string, from = 0) {
  const start = source.indexOf(selector, from);
  if (start === -1) throw new Error(`${selector} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open + 1, i), start, end: i };
    }
  }
  throw new Error(`${selector} not terminated`);
}

function decl(body: string, name: string): string | undefined {
  return body.match(new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;]+);`))?.[1]?.trim();
}

const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
const dark = block(withoutComments, DARK_SELECTOR).body;
const light = block(withoutComments, LIGHT_SELECTOR).body;
const appStrip = block(appCss, ":root {\n  --surface-app").body;

function raw(theme: Theme, name: string): string {
  const value = (theme === "light" ? decl(light, name) : undefined) ?? decl(dark, name);
  if (!value) throw new Error(`${name} not declared for ${theme}`);
  return value;
}

function color(theme: Theme, name: string): Rgb {
  const value = raw(theme, name);
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) throw new Error(`${name} for ${theme} is not a hex colour: ${value}`);
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function pct(value: string | undefined): number {
  const match = value?.match(/^(\d+(?:\.\d+)?)%$/)?.[1];
  if (!match) throw new Error(`not a percentage: ${value}`);
  return Number(match) / 100;
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
const THEMES: Theme[] = ["dark", "light"];

/** Glass tier → [base colour, alpha]. Strip alpha is shared with classic (app.css). */
function tiers(theme: Theme): Record<string, [Rgb, number]> {
  const chrome = pct(decl(dark, "--glass-alpha-chrome"));
  const overlay = pct(decl(dark, "--glass-alpha-overlay"));
  const strip = pct(decl(appStrip, "--glass-alpha-strip"));
  return {
    "window (g0)": [color(theme, "--color-panel"), chrome],
    "overlay (g3)": [color(theme, "--color-elevated"), overlay],
    "strip on elevated": [color(theme, "--color-elevated"), strip],
    "strip on panel": [color(theme, "--color-panel"), strip],
    "strip on canvas": [color(theme, "--color-canvas"), strip],
  };
}

const worst = (ink: Rgb, [base, a]: [Rgb, number], backdrops: Rgb[]) =>
  Math.min(...backdrops.map((bg) => contrast(ink, over(a, base, bg))));

describe("new look tokens: scope", () => {
  it("(a) every rule in tokens-new.css is scoped to the new look", () => {
    const selectors = [...withoutComments.matchAll(/(?:^|[{}])([^{}]+)\{/g)]
      .map((m) => (m[1] ?? "").trim())
      .filter((selector) => selector && !selector.startsWith("@"));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector, selector).toMatch(/^:root\[data-ui="new"\]/);
    }
  });

  it("(a) classic stays untouched: app.css never mentions data-ui and loads first", () => {
    expect(appCss).not.toContain("data-ui");
    const app = mainTsx.indexOf('import "./styles/app.css";');
    const next = mainTsx.indexOf('import "./styles/tokens-new.css";');
    expect(app).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(app);
  });

  it("(a) no backdrop-filter of its own: the D2 glass rules in app.css stay the only ones", () => {
    expect(withoutComments).not.toMatch(/[;{]\s*(?:-webkit-)?backdrop-filter\s*:/);
  });
});

describe("new look tokens: values", () => {
  it("(b) pins the token table (a value change is a deliberate edit here)", () => {
    const names = [
      "--color-canvas",
      "--color-panel",
      "--color-surface",
      "--color-elevated",
      "--color-fg",
      "--color-fg-muted",
      "--color-fg-subtle",
      "--color-fg-faint",
      "--color-accent",
      "--color-accent-hover",
      "--color-accent-active",
      "--color-focus-ring",
      "--color-link",
      "--color-success",
      "--color-danger",
      "--status-warning",
      "--color-dialog-warning",
    ];
    const table = (theme: Theme) => Object.fromEntries(names.map((n) => [n, raw(theme, n)]));
    expect(table("dark")).toEqual({
      "--color-canvas": "#0f1520",
      "--color-panel": "#0b1018",
      "--color-surface": "#151d2a",
      "--color-elevated": "#1a2333",
      "--color-fg": "#f2f4f8",
      "--color-fg-muted": "#a9b2c0",
      "--color-fg-subtle": "#939dac",
      "--color-fg-faint": "#7d8797",
      "--color-accent": "#863ff5",
      "--color-accent-hover": "#8d4bf6",
      "--color-accent-active": "#7a35e8",
      "--color-focus-ring": "#a77bf9",
      "--color-link": "#b48cfa",
      "--color-success": "#34c38f",
      "--color-danger": "#f06a6a",
      "--status-warning": "#f2b84b",
      "--color-dialog-warning": "#f2b84b",
    });
    expect(table("light")).toEqual({
      "--color-canvas": "#f6f8fb",
      "--color-panel": "#eef1f6",
      "--color-surface": "#ffffff",
      "--color-elevated": "#ffffff",
      "--color-fg": "#161c27",
      "--color-fg-muted": "#3f4959",
      "--color-fg-subtle": "#535d6f",
      "--color-fg-faint": "#626c7e",
      "--color-accent": "#863ff5",
      "--color-accent-hover": "#7a35e8",
      "--color-accent-active": "#6c2bd9",
      "--color-focus-ring": "#7a35e8",
      "--color-link": "#6c2bd9",
      "--color-success": "#138a5e",
      "--color-danger": "#d23b3b",
      "--status-warning": "#a76500",
      "--color-dialog-warning": "#8a5300",
    });
    expect({
      chrome: decl(dark, "--glass-alpha-chrome"),
      overlay: decl(dark, "--glass-alpha-overlay"),
      blur: decl(dark, "--glass-blur"),
      saturateDark: decl(dark, "--glass-saturate"),
      saturateLight: decl(light, "--glass-saturate"),
      radii: ["xs", "sm", "md", "lg", "xl", "2xl"].map((r) => decl(dark, `--radius-${r}`)),
    }).toEqual({
      chrome: "60%",
      overlay: "86%",
      blur: "24px",
      saturateDark: "1.3",
      saturateLight: "1.6",
      radii: ["6px", "8px", "10px", "14px", "18px", "24px"],
    });
  });

  it("(b) glass ruling (Gabriel 2026-10-13): more transparent than 64% / 90%, blur not lowered", () => {
    expect(pct(decl(dark, "--glass-alpha-chrome"))).toBeLessThan(0.64);
    expect(pct(decl(dark, "--glass-alpha-overlay"))).toBeLessThan(0.9);
    const blur = Number(decl(dark, "--glass-blur")?.match(/^(\d+)px$/)?.[1]);
    expect(blur).toBeGreaterThanOrEqual(20);
  });

  it("(b) one alpha set for both themes: light never overrides a glass alpha", () => {
    expect(light).not.toMatch(/--glass-alpha-/);
  });

  it("(b) one accent: the Modus logo purple, shared by send, Build and focus", () => {
    const logo = readFileSync(new URL("../assets/modus-logo.svg", import.meta.url), "utf8");
    const logoFills = new Set(
      [...logo.matchAll(/fill="(#[0-9a-f]{6})"/gi)].map((m) => m[1]?.toLowerCase()),
    );
    expect([...logoFills]).toEqual(["#863ff5"]);
    for (const theme of THEMES) {
      expect(raw(theme, "--color-accent"), `${theme} accent is the logo purple`).toBe("#863ff5");
      expect(raw(theme, "--color-build")).toBe(raw(theme, "--color-accent"));
      for (const name of ["--color-accent", "--color-focus-ring", "--color-link"]) {
        const [r, g, b] = color(theme, name);
        expect(b, `${theme} ${name} is purple`).toBeGreaterThan(Math.max(r, g));
        expect(r, `${theme} ${name} is purple, not blue`).toBeGreaterThan(g + 30);
      }
    }
    expect(withoutComments).not.toMatch(
      /47,\s*107,\s*242|31,\s*95,\s*224|#2f6bf2|#1f5fe0|#f54e00/i,
    );
  });

  it("(b) native window colours mirror the new canvas and text", () => {
    for (const theme of THEMES) {
      expect(NEW_LOOK_SOLID_WINDOW_BACKGROUND[theme]).toBe(raw(theme, "--color-canvas"));
      expect(NEW_LOOK_WINDOW_SYMBOL_COLOR[theme]).toBe(raw(theme, "--color-fg"));
    }
  });
});

describe("new look tokens: contrast gate", () => {
  it("(c) text on every glass tier, dark and light, faint included", () => {
    for (const theme of THEMES) {
      const likely = theme === "light" ? WHITE : BLACK;
      for (const [tier, surface] of Object.entries(tiers(theme))) {
        const at = `${theme} ${tier}`;
        expect(
          worst(color(theme, "--color-fg"), surface, [WHITE, GREY, BLACK]),
          `${at} fg`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          worst(color(theme, "--color-fg-muted"), surface, [GREY, likely]),
          `${at} muted`,
        ).toBeGreaterThanOrEqual(4.5);
        // TODO(redesign shell PR): subtle carries text-2xs labels and should reach
        // 4.5:1 here (today ~3.99 dark / ~3.79 light over window glass on grey);
        // see "Redesign pending" item 1 in HANDOFF.md.
        expect(
          worst(color(theme, "--color-fg-subtle"), surface, [GREY]),
          `${at} subtle`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          worst(color(theme, "--color-fg-faint"), surface, [GREY, likely]),
          `${at} faint`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("(c) chat / Settings tint (#245, --glass-alpha-chat) stacked on the window glass", () => {
    const chrome = pct(decl(dark, "--glass-alpha-chrome"));
    const chat = pct(decl(appStrip, "--glass-alpha-chat"));
    for (const theme of THEMES) {
      const likely = theme === "light" ? WHITE : BLACK;
      const panel = color(theme, "--color-panel");
      const elevated = color(theme, "--color-elevated");
      const stacked = (ink: Rgb, backdrops: Rgb[]) =>
        Math.min(
          ...backdrops.map((bg) => contrast(ink, over(chat, elevated, over(chrome, panel, bg)))),
        );
      const at = `${theme} chat on window`;
      expect(
        stacked(color(theme, "--color-fg"), [WHITE, GREY, BLACK]),
        `${at} fg`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        stacked(color(theme, "--color-fg-muted"), [GREY, likely]),
        `${at} muted`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        stacked(color(theme, "--color-fg-subtle"), [GREY]),
        `${at} subtle`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        stacked(color(theme, "--color-fg-faint"), [GREY, likely]),
        `${at} faint`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("(c) solid surfaces (Transparency off / fallback): body text AA, faint >= 4:1", () => {
    for (const theme of THEMES) {
      for (const base of [
        "--color-canvas",
        "--color-panel",
        "--color-surface",
        "--color-elevated",
      ]) {
        const bg = color(theme, base);
        const at = `${theme} ${base}`;
        expect(contrast(color(theme, "--color-fg"), bg), `${at} fg`).toBeGreaterThanOrEqual(7);
        expect(
          contrast(color(theme, "--color-fg-muted"), bg),
          `${at} muted`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(color(theme, "--color-fg-faint"), bg),
          `${at} faint`,
        ).toBeGreaterThanOrEqual(4);
        expect(contrast(color(theme, "--color-link"), bg), `${at} link`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it("(c) warning text >= 4.5:1 on every solid surface, its own notice fill and the dialog glass", () => {
    for (const theme of THEMES) {
      const warning = color(theme, "--color-dialog-warning");
      for (const base of [
        "--color-canvas",
        "--color-panel",
        "--color-surface",
        "--color-elevated",
      ]) {
        const bg = color(theme, base);
        expect(contrast(warning, bg), `${theme} ${base}`).toBeGreaterThanOrEqual(4.5);
        // Notices: text-warning on bg-warning/10 over the surface.
        expect(
          contrast(warning, over(0.1, warning, bg)),
          `${theme} notice on ${base}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      // Dialogs sit on the overlay tier (g3) over any backdrop.
      expect(
        worst(warning, tiers(theme)["overlay (g3)"] as [Rgb, number], [WHITE, GREY, BLACK]),
        `${theme} overlay`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("(c) classic dialog warning >= 4.5:1 on classic surfaces and its notice fill (dark, light, dark-plus)", () => {
    const classic = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const base = block(classic, "@theme {").body;
    const themes: Record<string, string> = {
      dark: base,
      light: block(classic, ':root[data-theme="light"] {').body,
      "dark-plus": block(classic, ':root[data-theme="dark-plus"] {').body,
    };
    const resolve = (body: string, name: string): Rgb => {
      let value = decl(body, name) ?? decl(base, name);
      for (let i = 0; value?.startsWith("var(") && i < 4; i += 1) {
        const ref = value.slice(4, -1).trim();
        value = decl(body, ref) ?? decl(base, ref);
      }
      const hex = value?.match(/^#([0-9a-f]{6})$/i)?.[1];
      if (!hex) throw new Error(`${name}: not a hex colour (${value})`);
      return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
    };
    for (const [theme, body] of Object.entries(themes)) {
      const warning = resolve(body, "--color-dialog-warning");
      for (const name of [
        "--color-canvas",
        "--color-panel",
        "--color-surface",
        "--color-elevated",
      ]) {
        const bg = resolve(body, name);
        expect(contrast(warning, bg), `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(warning, over(0.1, warning, bg)),
          `${theme} notice on ${name}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("(a) the dialog warning is the only warning colour key: no --color-warning theme token", () => {
    expect(appCss).not.toMatch(/^\s*--color-warning:/m);
    expect(css).not.toMatch(/^\s*--color-warning:/m);
  });

  it("(c) faint stays clearly apart from fg: >= 3:1 between the two colours and >= 3x on every solid surface, both themes", () => {
    for (const theme of THEMES) {
      const fg = color(theme, "--color-fg");
      const faint = color(theme, "--color-fg-faint");
      expect(contrast(fg, faint), `${theme} fg vs faint`).toBeGreaterThanOrEqual(3);
      for (const base of [
        "--color-canvas",
        "--color-panel",
        "--color-surface",
        "--color-elevated",
      ]) {
        const bg = color(theme, base);
        expect(
          contrast(fg, bg) / contrast(faint, bg),
          `${theme} ${base} fg/faint`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("(c) text hierarchy: fg > muted > subtle > faint, each step >= 1.2x contrast, on every solid surface, both themes", () => {
    const ladder = ["--color-fg", "--color-fg-muted", "--color-fg-subtle", "--color-fg-faint"];
    for (const theme of THEMES) {
      for (const base of [
        "--color-canvas",
        "--color-panel",
        "--color-surface",
        "--color-elevated",
      ]) {
        const bg = color(theme, base);
        const levels = ladder.map((name) => contrast(color(theme, name), bg));
        for (let i = 1; i < ladder.length; i += 1) {
          expect(
            (levels[i - 1] ?? 0) / (levels[i] ?? 1),
            `${theme} ${base}: ${ladder[i - 1]} vs ${ladder[i]}`,
          ).toBeGreaterThanOrEqual(1.2);
        }
      }
    }
  });

  it("(c) white text on the accent fill meets AA in both themes, hover included", () => {
    for (const theme of THEMES) {
      expect(
        contrast(WHITE, color(theme, "--color-accent")),
        `${theme} accent`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(WHITE, color(theme, "--color-accent-hover")),
        `${theme} hover`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(WHITE, color(theme, "--color-accent-active")),
        `${theme} pressed`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("new look tokens: fallback", () => {
  it("(d) reduced transparency / more contrast / forced colors / no backdrop-filter re-zero the new alphas, last", () => {
    const media = block(
      withoutComments,
      "@media (prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active) {",
    );
    const supports = block(
      withoutComments,
      "@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {",
    );
    for (const fallback of [media, supports]) {
      const inner = block(fallback.body, DARK_SELECTOR).body;
      expect(decl(inner, "--glass-alpha-chrome")).toBe("100%");
      expect(decl(inner, "--glass-alpha-overlay")).toBe("100%");
      expect(decl(inner, "--glass-filter")).toBe("none");
      expect(decl(inner, "--glass-scrim-filter")).toBe("none");
      // From the first fallback on, an alpha may only ever be set back to solid.
      const later = [
        ...withoutComments.slice(fallback.start).matchAll(/--glass-alpha-[a-z]+:\s*([^;]+);/g),
      ];
      for (const match of later) expect(match[1]?.trim()).toBe("100%");
    }
    const lastNormalRule = block(withoutComments, LIGHT_SELECTOR).end;
    expect(media.start).toBeGreaterThan(lastNormalRule);
    expect(supports.start).toBeGreaterThan(lastNormalRule);
  });
});
