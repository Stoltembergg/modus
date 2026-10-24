// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("../../styles/app.css");
const timeline = read("../../features/agent/Timeline.tsx");

function block(selector: string, from = 0): string {
  const at = css.indexOf(`${selector} {`, from);
  expect(at, `${selector} exists`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

afterEach(() => vi.useRealTimers());

describe("message copy button", () => {
  it("copies the raw markdown and shows the copied state, with no text", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const markdown = "## Plan\n\n- **one**\n- `two`";
    render(<CopyButton label="Copy response" text={markdown} />);
    const button = screen.getByRole("button", { name: "Copy response" });
    expect(button.textContent).toBe("");
    expect(button.getAttribute("title")).toBeNull();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith(markdown);
    expect(button.dataset.copied).toBe("true");
    await act(async () => {
      vi.advanceTimersByTime(1700);
    });
    expect(button.dataset.copied).toBeUndefined();
  });

  it("keyboard focus gets the #322 accent ring, outside the box", () => {
    const rule = block(".copy-button:focus-visible");
    expect(rule).toMatch(/outline:\s*2px solid var\(--color-accent\)/);
    expect(rule).toMatch(/outline-offset:\s*3px/);
  });

  it("copied state cross-fades on motion tokens; reduced motion is a 120 ms fade", () => {
    expect(block(".copy-button-icon")).toMatch(/opacity var\(--motion-duration-base\)/);
    const reduced = css.slice(
      css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf(".copy-reveal {")),
    );
    expect(reduced).toMatch(
      /\.copy-button-icon,\s*\.copy-reveal\s*\{\s*transition:\s*opacity var\(--motion-duration-reduced\) var\(--motion-ease-linear\);/,
    );
  });

  it("the turn copy is revealed on hover and on keyboard focus", () => {
    const reveal = timeline.match(/className="([^"]*copy-reveal[^"]*)"/)?.[1] ?? "";
    expect(reveal).toContain("group-hover/turn:opacity-100");
    expect(reveal).toContain("group-focus-within/turn:opacity-100");
  });
});
