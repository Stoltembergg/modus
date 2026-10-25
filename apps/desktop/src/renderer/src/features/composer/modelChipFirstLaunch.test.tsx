// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModelPicker } from "../agents/ModelPicker";
import { MODEL_CHIP_INTERACTIVE, MODEL_CHIP_WARNING } from "./modelChipStyle";

/** First launch: the "Pick a model" chip gets a visible focus ring and readable warning text. */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("../../styles/app.css");
const tokensNew = read("../../styles/tokens-new.css");

function block(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} exists`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}
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
// Light chip fill and composer surface as measured on a fresh profile.
const LIGHT_CHIP_BGS = ["#f7f7f7", "#ffffff"];

afterEach(cleanup);

describe("first-launch model chip", () => {
  it("keyboard focus draws the 2px accent ring, 3px out (the chip drops the default outline)", () => {
    expect(MODEL_CHIP_INTERACTIVE).toContain("outline-none");
    expect(MODEL_CHIP_INTERACTIVE.split(" ")).toContain("model-chip");
    const ring = block(".model-chip:focus-visible");
    expect(ring).toContain("outline: 2px solid var(--color-accent)");
    expect(ring).toContain("outline-offset: 3px");
  });

  it("light warning text clears 4.5:1 on the chip; the base danger token did not", () => {
    const light = block(':root:not([data-theme="dark"]) .model-chip-warning');
    const fg = light.match(/--color-danger:\s*(#[0-9a-f]{6})/)?.[1] ?? "";
    for (const bg of LIGHT_CHIP_BGS) expect(ratio(fg, bg), `on ${bg}`).toBeGreaterThanOrEqual(4.5);
    const base = tokensNew.match(/--color-danger:\s*#d23b3b/)?.[0];
    expect(base, "light base token unchanged").toBeTruthy();
    expect(ratio("#d23b3b", "#f7f7f7")).toBeLessThan(4.5);
  });

  it("the warning-tone trigger carries both hooks", () => {
    render(
      <ModelPicker
        label="Model"
        models={[]}
        onValueChange={() => {}}
        placeholder="Pick a model"
        tone="warning"
        triggerText="Pick a model"
        value=""
        variant="chip"
      />,
    );
    const trigger = screen.getByTestId("model-picker-trigger");
    expect(trigger.className).toContain("model-chip");
    for (const cls of MODEL_CHIP_WARNING.split(" ")) expect(trigger.className).toContain(cls);
  });
});
