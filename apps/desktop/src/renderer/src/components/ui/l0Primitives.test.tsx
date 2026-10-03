// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const motion = vi.hoisted(() => ({ reduce: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => motion.reduce };
});

import { RevealOnMount } from "./RevealOnMount";
import { SendStopIcon } from "./SendStopIcon";
import { StreamingCaret } from "./StreamingCaret";
import { TaskCheck } from "./TaskCheck";
import { WorkingText } from "./WorkingText";
import { formatElapsed, WorkStatusLine } from "./WorkStatusLine";

afterEach(() => {
  cleanup();
  motion.reduce = false;
});

describe("RevealOnMount", () => {
  it("animate=false renders the block with no motion style", () => {
    render(
      <RevealOnMount animate={false}>
        <p>history</p>
      </RevealOnMount>,
    );
    const wrapper = screen.getByText("history").parentElement as HTMLElement;
    expect(wrapper.dataset.reveal).toBe("static");
    expect(wrapper.getAttribute("style")).toBeNull();
  });

  it("animate=true starts below full opacity", () => {
    render(
      <RevealOnMount animate>
        <p>fresh</p>
      </RevealOnMount>,
    );
    const wrapper = screen.getByText("fresh").parentElement as HTMLElement;
    expect(wrapper.dataset.reveal).toBe("enter");
    expect(Number(wrapper.style.opacity)).toBeLessThan(1);
    expect(wrapper.style.filter ?? "").toBe("");
  });

  it("reduced motion renders the final state directly", () => {
    motion.reduce = true;
    render(
      <RevealOnMount animate>
        <p>fresh</p>
      </RevealOnMount>,
    );
    const wrapper = screen.getByText("fresh").parentElement as HTMLElement;
    expect(wrapper.dataset.reveal).toBe("static");
  });

  it("does not replay or remount when the prop flips after mount", () => {
    const { rerender } = render(
      <RevealOnMount animate>
        <p>fresh</p>
      </RevealOnMount>,
    );
    const child = screen.getByText("fresh");
    rerender(
      <RevealOnMount animate={false}>
        <p>fresh</p>
      </RevealOnMount>,
    );
    expect(screen.getByText("fresh")).toBe(child);
  });
});

describe("StreamingCaret", () => {
  it("active renders exactly one aria-hidden node", () => {
    const { container } = render(<StreamingCaret active />);
    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.classList.contains("streaming-caret")).toBe(true);
  });

  it("inactive renders nothing", () => {
    const { container } = render(<StreamingCaret active={false} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("WorkingText", () => {
  it("active gets the sweep class", () => {
    render(<WorkingText>Working…</WorkingText>);
    const node = screen.getByText("Working…");
    expect(node.classList.contains("working-text")).toBe(true);
    expect(node.classList.contains("working-text--sweep")).toBe(true);
  });

  it("paused is static text with no gradient class", () => {
    render(<WorkingText paused>Saving</WorkingText>);
    const node = screen.getByText("Saving");
    expect(node.classList.contains("working-text--sweep")).toBe(false);
    expect(node.dataset.workingText).toBe("static");
  });

  it("reduced motion is static text with no gradient class", () => {
    motion.reduce = true;
    render(<WorkingText className="text-canvas">Saving</WorkingText>);
    const node = screen.getByText("Saving");
    expect(node.classList.contains("working-text--sweep")).toBe(false);
    expect(node.classList.contains("text-canvas")).toBe(true);
  });
});

describe("TaskCheck", () => {
  it("unchecked exposes an image with its label and no mark", () => {
    const { container } = render(<TaskCheck aria-label="Not done" checked={false} />);
    const img = screen.getByRole("img", { name: "Not done" });
    expect(img.dataset.state).toBe("unchecked");
    expect(container.querySelector(".task-check__mark")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("checked fills and draws the mark; turning checked pops once", () => {
    const { container, rerender } = render(<TaskCheck aria-label="Task" checked={false} />);
    rerender(<TaskCheck aria-label="Task" checked />);
    const img = screen.getByRole("img", { name: "Task" });
    expect(img.dataset.state).toBe("checked");
    expect(container.querySelector(".task-check__mark")).not.toBeNull();
    expect(img.hasAttribute("data-pop")).toBe(true);
  });

  it("mounting already checked does not pop; reduced motion never pops", () => {
    render(<TaskCheck aria-label="Done" checked />);
    expect(screen.getByRole("img", { name: "Done" }).hasAttribute("data-pop")).toBe(false);
    cleanup();
    motion.reduce = true;
    const { rerender } = render(<TaskCheck aria-label="Task" checked={false} />);
    rerender(<TaskCheck aria-label="Task" checked />);
    expect(screen.getByRole("img", { name: "Task" }).hasAttribute("data-pop")).toBe(false);
  });

  it("honours size", () => {
    render(<TaskCheck aria-label="Big" checked={false} size={20} />);
    expect(screen.getByRole("img", { name: "Big" }).style.width).toBe("20px");
  });
});

describe("SendStopIcon", () => {
  it("shows the arrow when idle and the square when busy", () => {
    const { container, rerender } = render(<SendStopIcon busy={false} />);
    const visible = () =>
      container.querySelector('[data-visible="true"]')?.getAttribute("data-icon");
    expect(visible()).toBe("send");
    rerender(<SendStopIcon busy />);
    expect(visible()).toBe("stop");
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("WorkStatusLine", () => {
  it("formats the timer", () => {
    expect(formatElapsed(12.34)).toBe("12.3s");
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(59.96)).toBe("1m 00.0s");
    expect(formatElapsed(65)).toBe("1m 05.0s");
    expect(formatElapsed(754.25)).toBe("12m 34.3s");
  });

  it("A: live thinking shows the preview with the sweep, no toggle, no timer", () => {
    const { container } = render(
      <WorkStatusLine
        collapsible={false}
        color="var(--color-fg-faint)"
        fontSize={12}
        label="Reading the repo"
        showTimer={false}
        working
      />,
    );
    const working = container.querySelector('[data-layer="working"]') as HTMLElement;
    expect(working.textContent).toBe("Reading the repo");
    expect(working.querySelector(".working-text--sweep")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect((container.firstElementChild as HTMLElement).style.fontSize).toBe("12px");
    expect(container.querySelector(".work-status-line__glyph")?.hasAttribute("data-working")).toBe(
      true,
    );
  });

  it("B: finished thinking shows Thought and its steps start closed", async () => {
    const user = userEvent.setup();
    render(<WorkStatusLine doneLabel="Thought" steps={["step one"]} working={false} />);
    const toggle = screen.getByRole("button");
    expect(toggle.textContent).toContain("Thought");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const list = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(list?.tagName).toBe("OL");
    expect(list?.hidden).toBe(true);
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(list?.hidden).toBe(false);
    expect(list?.textContent).toBe("step one");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("C: work header uses renderLabel while working and doneLabel + timer when finished", () => {
    const renderLabel = (text: string, working: boolean) =>
      working ? <span data-testid="phase">Editing files</span> : text;
    const { container, rerender } = render(
      <WorkStatusLine
        doneLabel="Worked for"
        elapsed={3}
        fontSize={13}
        label="Working…"
        renderLabel={renderLabel}
        shimmer={false}
        showTimer
        working
      />,
    );
    expect(screen.getByTestId("phase").textContent).toBe("Editing files");
    expect(container.querySelector(".working-text--sweep")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Working…");
    rerender(
      <WorkStatusLine
        doneLabel="Worked for"
        elapsed={72.5}
        fontSize={13}
        label="Working…"
        renderLabel={renderLabel}
        shimmer={false}
        showTimer
        working={false}
      />,
    );
    const done = container.querySelector('[data-layer="done"]') as HTMLElement;
    expect(done.textContent).toBe("Worked for 1m 12.5s");
    expect(done.dataset.visible).toBe("true");
    expect(container.querySelector('[data-layer="working"]')?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(screen.getByRole("status").textContent).toBe("Worked for 1m 12.5s");
  });

  it("terminal labels have no timer when showTimer is off", () => {
    const { container } = render(
      <WorkStatusLine doneLabel="Stopped by you" elapsed={9} showTimer={false} working={false} />,
    );
    expect(container.querySelector('[data-layer="done"]')?.textContent).toBe("Stopped by you");
  });

  it("the status does not chatter while a streaming preview label changes", () => {
    const { rerender } = render(<WorkStatusLine label="Thinking…" working />);
    rerender(<WorkStatusLine label="Thinking about the parser" working />);
    expect(screen.getByRole("status").textContent).toBe("Thinking…");
    act(() => {
      rerender(
        <WorkStatusLine doneLabel="Thought" label="Thinking about the parser" working={false} />,
      );
    });
    expect(screen.getByRole("status").textContent).toBe("Thought");
  });

  it("reduced motion drops the sweep", () => {
    motion.reduce = true;
    const { container } = render(<WorkStatusLine label="Working…" working />);
    expect(container.querySelector(".working-text--sweep")).toBeNull();
  });
});
