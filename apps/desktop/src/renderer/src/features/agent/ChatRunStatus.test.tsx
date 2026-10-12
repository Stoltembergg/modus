// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRunStatus, RUN_STAGE_MIN_MS } from "./ChatRunStatus";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const labelText = () => screen.getByTestId("chat-run-status-label").textContent;

describe("ChatRunStatus", () => {
  it("falls back to 'Working on your request' in an out-of-flow slot (no layout shift)", () => {
    render(<ChatRunStatus retrying={false} />);
    expect(labelText()).toBe("Working on your request");
    const slot = screen.getByTestId("chat-run-status-slot");
    expect(slot.className).toMatch(/\babsolute\b/);
    expect(slot.className).toMatch(/\bbottom-full\b/);
    expect(screen.getByTestId("chat-run-status").className).not.toMatch(/\bborder\b/);
    expect(screen.getByTestId("chat-run-status-label").className).toMatch(/\btruncate\b/);
  });

  it("shows the live stage and keeps the retry label", () => {
    const view = render(<ChatRunStatus retrying={false} stage={{ kind: "thinking" }} />);
    expect(labelText()).toBe("Thinking…");
    cleanup();
    render(<ChatRunStatus retrying stage={{ kind: "thinking" }} />);
    expect(labelText()).toBe("Retrying the current turn");
    void view;
  });

  it("throttles fast stage hops so the label doesn't flicker", () => {
    vi.useFakeTimers();
    const view = render(<ChatRunStatus retrying={false} stage={{ kind: "thinking" }} />);
    act(() => {
      view.rerender(<ChatRunStatus retrying={false} stage={{ kind: "searching" }} />);
    });
    act(() => {
      view.rerender(
        <ChatRunStatus retrying={false} stage={{ kind: "runningCommand", command: "npm test" }} />,
      );
    });
    // First value held; the intermediate hop never paints.
    act(() => {
      vi.advanceTimersByTime(RUN_STAGE_MIN_MS / 2);
    });
    expect(labelText()).not.toBe("Searching the codebase…");
    act(() => {
      vi.advanceTimersByTime(RUN_STAGE_MIN_MS);
    });
    expect(labelText()).toBe("Running npm test");
  });

  it("opens Activity", () => {
    const onOpenActivity = vi.fn();
    render(<ChatRunStatus onOpenActivity={onOpenActivity} retrying={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(onOpenActivity).toHaveBeenCalledOnce();
  });
});
