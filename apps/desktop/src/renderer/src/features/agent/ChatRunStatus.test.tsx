// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRunStatus } from "./ChatRunStatus";

afterEach(cleanup);

describe("ChatRunStatus", () => {
  it("renders the working label in an out-of-flow slot above the composer (no layout shift)", () => {
    render(<ChatRunStatus retrying={false} />);
    expect(screen.getByRole("status").textContent).toContain("Working on your request");
    const slot = screen.getByTestId("chat-run-status-slot");
    // Absolutely positioned at the composer's top edge: takes no space in the flow.
    expect(slot.className).toMatch(/\babsolute\b/);
    expect(slot.className).toMatch(/\bbottom-full\b/);
    // Minimal style: no divider/border.
    expect(screen.getByTestId("chat-run-status").className).not.toMatch(/\bborder\b/);
  });

  it("shows the retry label and opens Activity", () => {
    const onOpenActivity = vi.fn();
    render(<ChatRunStatus onOpenActivity={onOpenActivity} retrying />);
    expect(screen.getByRole("status").textContent).toContain("Retrying the current turn");
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(onOpenActivity).toHaveBeenCalledOnce();
  });
});
