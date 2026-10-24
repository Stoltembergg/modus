import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Activity PR 3: text and icons in the Activity panel stay >= 4.5:1, and the Inspector tabs get the accent ring. */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("./app.css");

function block(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} exists`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}
const token = (src: string, name: string) =>
  src.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`))?.[1] ?? "";
const lum = (hex: string) => {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x = 0, y = 0] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
// Light diff surfaces (app.css light theme) and the light glass panel as measured.
const LIGHT_BGS = ["#d4e6ce", "#ffd9cc", "#e5f0e1", "#ffe8df", "#eef1f5"];
const DARK_DEL_GUTTERS = ["#4b302a", "#3a2824"];

describe("Activity contrast", () => {
  it("light success/danger text clears 4.5:1 on the panel and diff gutters", () => {
    const light = block(':root:not([data-theme="dark"]) .activity-panel');
    for (const name of ["--color-success", "--color-danger"]) {
      const fg = token(light, name);
      for (const bg of LIGHT_BGS)
        expect(ratio(fg, bg), `${name} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("dark danger text clears 4.5:1 on the removed-line gutter", () => {
    const fg = token(block(".activity-panel"), "--color-danger");
    for (const bg of DARK_DEL_GUTTERS) expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("thought glyph and chevron never fade below 0.85", () => {
    const opacity = (sel: string) => Number(block(sel).match(/opacity:\s*([\d.]+)/)?.[1]);
    expect(opacity(".work-status-line__glyph")).toBeGreaterThanOrEqual(0.85);
    expect(opacity(".work-status-line__chevron")).toBeGreaterThanOrEqual(0.85);
    const breathe = css.slice(css.indexOf("@keyframes work-status-breathe"));
    const min = Math.min(
      ...[...breathe.slice(0, breathe.indexOf("}\n  }")).matchAll(/opacity:\s*([\d.]+)/g)].map(
        (m) => Number(m[1]),
      ),
    );
    expect(min).toBeGreaterThanOrEqual(0.85);
  });

  it("diff line numbers and removed code are not dimmed", () => {
    const src = read("../features/agent/diff/InlineDiff.tsx");
    expect(src).not.toContain('isDel && "opacity-70"');
    expect(src).toContain("px-2 text-right text-fg-muted tabular-nums");
  });

  it("Inspector tabs: 2px accent ring 3px out on keyboard focus", () => {
    const src = read("../features/inspector/Inspector.tsx");
    for (const cls of [
      "focus-visible:outline-2",
      "focus-visible:outline-solid",
      "focus-visible:outline-offset-3",
      "focus-visible:outline-accent",
    ])
      expect(src).toContain(cls);
  });
});
