// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityTimeline } from "./ActivityTimeline";
import { AgentEventHub } from "./agentEventHub";

afterEach(() => {
  cleanup();
  Object.assign(window, { modus: undefined });
});

describe("Activity loading skeleton", () => {
  it("shows text-free bars while the first page loads, then clears", async () => {
    let resolve!: (page: { events: never[]; snapshotCursor: number; hasMore: boolean }) => void;
    const listEventPage = () => new Promise((r) => (resolve = r));
    Object.assign(window, { modus: { agent: { listEventPage } } });
    render(<ActivityTimeline cwd="/repo" hub={new AgentEventHub()} sessionId="s" />);
    const panel = screen.getByTestId("activity-timeline");
    expect(panel.getAttribute("aria-busy")).toBe("true");
    expect(panel.querySelector("[data-activity-skeleton]")).not.toBeNull();
    expect(panel.textContent?.trim()).toBe("");
    await act(async () => resolve({ events: [], snapshotCursor: 1, hasMore: false }));
    expect(panel.querySelector("[data-activity-skeleton]")).toBeNull();
    expect(panel.hasAttribute("aria-busy")).toBe(false);
  });

  it("no skeleton without a chat", () => {
    Object.assign(window, { modus: { agent: { listEventPage: () => new Promise(() => {}) } } });
    render(<ActivityTimeline cwd={undefined} hub={new AgentEventHub()} sessionId={undefined} />);
    expect(
      screen.getByTestId("activity-timeline").querySelector("[data-activity-skeleton]"),
    ).toBeNull();
  });
});
