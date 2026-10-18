// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { domMax, LazyMotion, MotionConfig } from "motion/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { QueuedPromptItem } from "../../../../shared/contracts";
import { QueuedPromptStrip, queuedPromptPreview } from "./QueuedPromptStrip";

const nativeAnimation = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  Reflect.deleteProperty(Element.prototype, "animate");
  return descriptor;
});
afterAll(() => {
  if (nativeAnimation) Object.defineProperty(Element.prototype, "animate", nativeAnimation);
});
afterEach(cleanup);

const css = readFileSync(new NodeURL("../../styles/app.css", import.meta.url), "utf8");
const source = readFileSync(new NodeURL("./QueuedPromptStrip.tsx", import.meta.url), "utf8");

const items: QueuedPromptItem[] = [
  { id: "q-1", delivery: "follow-up", text: "Then add a test\n\nfor the parser", imageCount: 0 },
  { id: "q-2", delivery: "steer", text: "Use this screenshot", imageCount: 2 },
];

function strip(list: QueuedPromptItem[], onRemove = vi.fn()) {
  const view = render(
    <LazyMotion features={domMax} strict>
      <QueuedPromptStrip items={list} onRemove={onRemove} />
    </LazyMotion>,
  );
  return { ...view, onRemove };
}

/** Every `.queued-prompt-*` rule body in app.css. */
function stripRules(): string[] {
  return [...css.matchAll(/([^{}]*\.queued-prompt-[^{}]*)\{([^}]*)\}/g)].map(
    (match) => `${match[1]}{${match[2]}}`,
  );
}

describe("QueuedPromptStrip", () => {
  it("renders nothing when the queue is empty", () => {
    const { container } = strip([]);
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("queued-prompt-strip")).toBeNull();
  });

  it("lists prompts in arrival order keyed by queue id, one line each, with an image count", () => {
    strip(items);
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-queued-prompt-id]"));
    expect(rows.map((row) => row.dataset.queuedPromptId)).toEqual(["q-1", "q-2"]);
    expect(rows[0]?.textContent).toBe("Then add a test for the parser");
    expect(screen.getByTestId("queued-prompt-images").textContent).toBe("2");
    expect(screen.getByRole("img", { name: "images" })).toBeTruthy();
  });

  it("has no helper text: only the prompts and their image counts are visible", () => {
    const { container } = strip(items);
    expect(container.textContent).toBe("Then add a test for the parserUse this screenshot2");
  });

  it("remove calls back with that item's id", () => {
    const { onRemove } = strip(items);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove queued message: Use this screenshot" }),
    );
    expect(onRemove).toHaveBeenCalledWith("q-2");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("drops a row when its id leaves the queue", async () => {
    const view = strip(items);
    view.rerender(
      <LazyMotion features={domMax} strict>
        <QueuedPromptStrip items={[items[1] as QueuedPromptItem]} onRemove={vi.fn()} />
      </LazyMotion>,
    );
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll<HTMLElement>("[data-queued-prompt-id]")).map(
          (row) => row.dataset.queuedPromptId,
        ),
      ).toEqual(["q-2"]),
    );
  });

  it("reveals remove only on row hover or keyboard focus, with an accent focus ring", () => {
    strip(items);
    const button = screen.getByRole("button", { name: /Then add a test/ });
    const classes = button.className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        "opacity-0",
        "group-hover/queued:opacity-100",
        "focus-visible:opacity-100",
      ]),
    );
    expect(button.closest("li")?.className).toContain("group/queued");
    // Reachable by keyboard (no tabindex=-1) and focusable.
    expect(button.getAttribute("tabindex")).toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
    const focusRule = stripRules().find((rule) =>
      rule.includes(".queued-prompt-remove:focus-visible"),
    );
    expect(focusRule).toMatch(/opacity:\s*1/);
    expect(focusRule).toMatch(/box-shadow:\s*0 0 0 2px var\(--color-accent\)/);
  });

  it("has no dividers or borders: one glass surface, rows separated by spacing", () => {
    strip(items);
    const nodes = [
      screen.getByTestId("queued-prompt-strip"),
      ...screen.getByTestId("queued-prompt-strip").querySelectorAll("*"),
    ];
    for (const node of nodes) {
      const className = typeof node.className === "string" ? node.className : "";
      expect(className).not.toMatch(/(?:^|\s)(?:border(?:-[a-z]+)*|divide-[\w/-]+)(?:\s|$)/);
    }
    expect(document.querySelector("hr")).toBeNull();
    for (const rule of stripRules()) {
      expect(rule).not.toMatch(/\bborder(?:-(?:top|bottom|left|right))?:(?!\s*0;)/);
    }
    const surface = stripRules().find((rule) => /\.queued-prompt-strip\s*\{/.test(rule));
    expect(surface).toContain("background: var(--surface-chat)");
    expect(surface).toContain("border-radius: var(--radius-xl)");
  });

  it("takes enter, exit and reflow from queuedPromptMotion (no inline movement values)", () => {
    expect(source).toContain("queuedPromptMotion(reducedMotion)");
    expect(source).toContain("useReducedMotion()");
    expect(source.match(/\blayout\b/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).not.toMatch(/\b(?:x|y|scale):\s*-?\d/);
  });

  it("renders under reduced motion without dropping rows", () => {
    render(
      <MotionConfig reducedMotion="always">
        <LazyMotion features={domMax} strict>
          <QueuedPromptStrip items={items} onRemove={vi.fn()} />
        </LazyMotion>
      </MotionConfig>,
    );
    expect(document.querySelectorAll("[data-queued-prompt-id]")).toHaveLength(2);
  });

  it("previews collapse whitespace to one line", () => {
    expect(queuedPromptPreview("  a\n\n b\tc  ")).toBe("a b c");
  });
});
