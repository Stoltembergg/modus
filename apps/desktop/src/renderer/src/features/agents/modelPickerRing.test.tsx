// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PickableModel } from "../../lib/modusModels";
import { ModelPicker } from "./ModelPicker";

/** Keyboard-highlighted picker row gets the 2px accent ring; pointer hover keeps only the fill. */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../styles/app.css"), "utf8");
const RING = '[data-nav="keyboard"] .model-picker-item[data-highlighted]';

const models: PickableModel[] = [
  { id: "a/one", name: "One", provider: "openai", providerName: "OpenAI" },
  { id: "a/two", name: "Two", provider: "openai", providerName: "OpenAI" },
];

afterEach(cleanup);

/** Mirrors RING (happy-dom's matches() misreads the descendant attribute selector). */
const ringOn = (el: Element | null) =>
  !!el &&
  el.classList.contains("model-picker-item") &&
  el.hasAttribute("data-highlighted") &&
  el.closest("[data-nav]")?.getAttribute("data-nav") === "keyboard";

async function open(onValueChange = vi.fn()) {
  render(
    <ModelPicker
      label="Model"
      models={models}
      onValueChange={onValueChange}
      placeholder="Pick a model"
      value="a/one"
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByTestId("model-picker-trigger"));
  });
  return screen.getByTestId("model-picker-popup");
}

describe("model picker keyboard ring", () => {
  it("the ring rule is the 2px accent outline, inset", () => {
    const at = css.indexOf(`${RING} {`);
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("}", at));
    expect(block).toContain("outline: 2px solid var(--color-accent)");
    expect(block).toContain("outline-offset: -2px");
  });

  it("arrow keys put the ring on the highlighted row; pointer hover drops it", async () => {
    const onValueChange = vi.fn();
    const popup = await open(onValueChange);
    const input = screen.getByLabelText("Search models");
    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    expect(popup.getAttribute("data-nav")).toBe("keyboard");
    const highlighted = popup.querySelector(".model-picker-item[data-highlighted]");
    expect(highlighted, "a row is highlighted").toBeTruthy();
    expect(ringOn(highlighted)).toBe(true);
    await act(async () => {
      fireEvent.pointerMove(highlighted as Element);
    });
    expect(popup.getAttribute("data-nav")).toBe("pointer");
    expect(ringOn(highlighted)).toBe(false);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
