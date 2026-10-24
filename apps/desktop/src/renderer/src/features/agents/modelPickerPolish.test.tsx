// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";

/** Model picker polish: visible keyboard highlight, readable search placeholder,
 *  accent-derived check, and empty-state copy that matches the query. */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "ModelPicker.tsx"), "utf8");
const tokens = readFileSync(resolve(here, "../../styles/tokens-new.css"), "utf8");
const lightAt = tokens.indexOf(':root[data-ui="new"][data-theme="light"] {');
const dark = tokens.slice(0, lightAt);
const light = tokens.slice(lightAt);

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as RGB;
const tok = (block: string, name: string) => block.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim() ?? "";
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => a[i]! * t + b[i]! * (1 - t)) as RGB;
const lum = (c: RGB) => {
  const [r, g, b] = c.map((x) => {
    const v = x / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: RGB, b: RGB) => {
  const [x = 0, y = 0] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const pct = (value: string) => Number(value.match(/(\d+)%/)?.[1]) / 100;
// Measured popup fill (glass over canvas): dark #1a2333, light #ffffff.
const DARK_POPUP = hex("#1a2333");
const LIGHT_POPUP = hex("#ffffff");

afterEach(cleanup);

describe("model picker polish", () => {
  it("keyboard-highlighted rows use a stronger neutral fill (no accent, no border)", () => {
    expect(source).toContain("data-highlighted:bg-(--color-picker-highlight)");
    expect(source).not.toContain("data-highlighted:bg-hover");
    const darkHl = mix(hex(tok(dark, "color-fg")), DARK_POPUP, pct(tok(dark, "color-picker-highlight")));
    const lightHl = mix(hex(tok(light, "color-fg")), LIGHT_POPUP, pct(tok(light, "color-picker-highlight")));
    expect(tok(dark, "color-picker-highlight")).not.toContain("accent");
    // Was 1.15:1 (dark, 5% white) and 1.08:1 (light, 4%).
    expect(ratio(darkHl, DARK_POPUP)).toBeGreaterThanOrEqual(1.8);
    expect(ratio(lightHl, LIGHT_POPUP)).toBeGreaterThanOrEqual(1.2);
  });

  it("search placeholder uses fg-muted (fg-faint was 4.34:1 in dark)", () => {
    expect(source).toContain("placeholder:text-fg-muted");
    expect(ratio(hex(tok(dark, "color-fg-muted")), DARK_POPUP)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(tok(light, "color-fg-muted")), LIGHT_POPUP)).toBeGreaterThanOrEqual(4.5);
  });

  it("dark check is an accent-derived token, >= 4.5:1 on the popup and the highlighted row", () => {
    expect(source).toContain("text-(--color-accent-check)");
    const check = tok(dark, "color-accent-check");
    expect(check).toMatch(/^color-mix\(in srgb, var\(--color-accent\) \d+%, white\)$/);
    const c = mix(hex(tok(dark, "color-accent")), [255, 255, 255], pct(check));
    const hl = mix(hex(tok(dark, "color-fg")), DARK_POPUP, pct(tok(dark, "color-picker-highlight")));
    expect(ratio(c, DARK_POPUP)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c, hl)).toBeGreaterThanOrEqual(4.5);
    expect(tok(light, "color-accent-check")).toBe("var(--color-accent)");
  });

  it("empty query says 'No models'; typed text says 'No models match'; value never changes", async () => {
    const onValueChange = vi.fn();
    render(
      <ModelPicker label="Model" models={[]} onValueChange={onValueChange} placeholder="Pick a model" value="" />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("model-picker-trigger"));
    });
    expect(await screen.findByText("No models")).toBeTruthy();
    expect(screen.queryByText("No models match")).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "zzzz" } });
    });
    expect(await screen.findByText("No models match")).toBeTruthy();
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
