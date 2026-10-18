import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Settings glass group (`.settings-group`, app.css): the borderless surface rows
 * sit on. It tints --color-surface at --settings-group-alpha over the settings
 * content (opaque canvas without native glass). Text on it must keep >= 4.5:1
 * for fg and fg-muted in both new-look themes, also over the worst backdrop the
 * translucent part can show (white in dark, black in light).
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

function block(selector: string): string {
  const at = tokens.indexOf(selector);
  if (at < 0) throw new Error(selector);
  return tokens.slice(tokens.indexOf("{", at) + 1, tokens.indexOf("\n}", at));
}
function token(body: string, name: string): Rgb {
  const raw = body.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, "i"))?.[1];
  if (!raw) throw new Error(name);
  return hex(raw);
}

const alpha = Number(app.match(/--settings-group-alpha:\s*(\d+)%/)?.[1]) / 100;
const themes = {
  dark: { body: block(':root[data-ui="new"] {'), worst: [255, 255, 255] as Rgb },
  light: { body: block(':root[data-ui="new"][data-theme="light"] {'), worst: [0, 0, 0] as Rgb },
};

describe("settings glass group", () => {
  it("is slightly transparent (not solid) but not see-through", () => {
    expect(alpha).toBeGreaterThanOrEqual(0.6);
    expect(alpha).toBeLessThan(1);
  });

  for (const [theme, { body, worst }] of Object.entries(themes)) {
    it(`${theme}: fg and fg-muted stay >= 4.5:1 on the group`, () => {
      const surface = token(body, "--color-surface");
      const canvas = token(body, "--color-canvas");
      const group = over(surface, alpha, canvas);
      for (const name of ["--color-fg", "--color-fg-muted"]) {
        expect(contrast(token(body, name), group), `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
      }
      // Pessimistic: the group's translucent share shows the opposite-brightness
      // backdrop instead of canvas (window glass at its floor is pinned elsewhere).
      const pessimistic = over(surface, alpha, worst);
      expect(contrast(token(body, "--color-fg"), pessimistic)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
