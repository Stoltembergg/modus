import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Visible prompt queue (`.queued-prompt-strip`, app.css). It sits on the
 * composer's tier (--surface-chat: --color-elevated when solid; the native
 * glass floor of that tier is pinned by glassTokens.test.ts). Prompt text uses
 * --color-fg, the image count --color-fg-muted, both >= 4.5:1 on the strip and
 * on the 8% accent hover tint, in light and dark, new look and classic.
 */
const app = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("./tokens-new.css", import.meta.url), "utf8");

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
const lum = (c: Rgb) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const over = (top: Rgb, alpha: number, base: Rgb): Rgb =>
  top.map((v, i) => v * alpha + (base[i] as number) * (1 - alpha)) as Rgb;

function block(source: string, selector: string): string {
  const at = source.indexOf(selector);
  if (at < 0) throw new Error(selector);
  return source.slice(source.indexOf("{", at) + 1, source.indexOf("\n}", at));
}
function token(bodies: string[], name: string): Rgb {
  for (const body of bodies) {
    const raw = body.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, "i"))?.[1];
    if (raw) return hex(raw);
  }
  throw new Error(name);
}

const classicDark = block(app, "@theme {");
const themes: Record<string, string[]> = {
  "new dark": [block(tokens, ':root[data-ui="new"] {')],
  "new light": [block(tokens, ':root[data-ui="new"][data-theme="light"] {')],
  "classic dark": [classicDark],
  "classic light": [block(app, ':root[data-theme="light"] {'), classicDark],
};
const hoverAlpha =
  Number(app.match(/\.queued-prompt-item:focus-within\s*\{[^}]*--color-accent\) (\d+)%/)?.[1]) /
  100;

describe("queued prompt strip contrast", () => {
  it("strip text is fg, the image count fg-muted, on the composer tier", () => {
    expect(app).toMatch(/\.queued-prompt-strip\s*\{[^}]*background: var\(--surface-chat\);/);
    expect(app).toMatch(/\.queued-prompt-text\s*\{[^}]*color: var\(--color-fg\);/);
    expect(app).toMatch(/\.queued-prompt-meta\s*\{[^}]*color: var\(--color-fg-muted\);/);
    expect(hoverAlpha).toBeGreaterThan(0);
    expect(hoverAlpha).toBeLessThanOrEqual(0.1);
  });

  for (const [theme, bodies] of Object.entries(themes)) {
    it(`${theme}: fg and fg-muted >= 4.5:1 on the strip and on the hover tint`, () => {
      const surface = token(bodies, "--color-elevated");
      const accent = token(bodies, "--color-accent");
      const hover = over(accent, hoverAlpha, surface);
      for (const name of ["--color-fg", "--color-fg-muted"]) {
        const fg = token(bodies, name);
        expect(contrast(fg, surface), `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(fg, hover), `${theme} ${name} hover`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
