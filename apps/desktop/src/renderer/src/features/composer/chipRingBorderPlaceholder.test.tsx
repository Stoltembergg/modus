import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODEL_CHIP_BASE, MODEL_CHIP_WARNING } from "./modelChipStyle";

/** Chips: 3px ring offset like the rest of the app, no warning border, readable composer placeholder. */
const here = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(resolve(here, "../../styles/app.css"), "utf8");
const tokens = readFileSync(resolve(here, "../../styles/tokens-new.css"), "utf8");
const composer = readFileSync(resolve(here, "Composer.tsx"), "utf8");

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
// Composer surface (measured): dark #1a2333, light #ffffff; light chip fill #f7f7f7.
const DARK_BG = "#1a2333";
const LIGHT_BGS = ["#ffffff", "#f7f7f7"];

describe("composer chips and placeholder", () => {
  it("chip focus ring sits 3px out, like Activity and the copy button", () => {
    const at = css.indexOf(".model-chip:focus-visible {");
    const block = css.slice(at, css.indexOf("}", at));
    expect(block).toContain("outline-offset: 3px");
  });

  it("warning chip has no visible border, only danger text", () => {
    expect(MODEL_CHIP_WARNING).not.toMatch(/border-danger/);
    expect(MODEL_CHIP_WARNING.split(" ")).toContain("border-transparent");
    expect(MODEL_CHIP_BASE.split(" ")).toContain("border");
    expect(MODEL_CHIP_WARNING.split(" ")).toContain("text-danger");
  });

  it("composer placeholder clears 4.5:1 in dark and light", () => {
    expect(composer).toContain("text-fg-placeholder");
    const vals = [...tokens.matchAll(/--color-fg-placeholder:\s*(#[0-9a-f]{6})/g)].map((m) => m[1] ?? "");
    expect(vals).toHaveLength(2);
    const [dark = "", light = ""] = vals;
    expect(ratio(dark, DARK_BG)).toBeGreaterThanOrEqual(4.5);
    for (const bg of LIGHT_BGS) expect(ratio(light, bg), `on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
});
