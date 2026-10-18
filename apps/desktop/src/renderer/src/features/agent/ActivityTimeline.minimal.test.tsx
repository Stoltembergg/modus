// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityTimeline } from "./ActivityTimeline";
import { AgentEventHub } from "./agentEventHub";
import { TerminalToolCard } from "./terminal/TerminalToolCard";

afterEach(() => {
  cleanup();
  Object.assign(window, { modus: undefined });
});

describe("Activity panel: minimal glass", () => {
  it("has no header, count or empty-state copy; the count is a data attribute", () => {
    render(<ActivityTimeline cwd="/repo" hub={new AgentEventHub()} sessionId="s" />);
    const panel = screen.getByRole("region", { name: "Activity" });
    expect(panel.classList.contains("activity-panel")).toBe(true);
    expect(panel.dataset.eventCount).toBe("0");
    expect(panel.querySelector("header, h2")).toBeNull();
    expect(panel.textContent?.trim()).toBe("");
  });

  it("without a chat it renders an empty, labelled surface", () => {
    render(<ActivityTimeline cwd={undefined} hub={new AgentEventHub()} sessionId={undefined} />);
    const panel = screen.getByRole("region", { name: "Activity" });
    expect(panel.textContent?.trim()).toBe("");
  });

  it("a failed first page shows one Retry control (no sentence) that reloads", async () => {
    let calls = 0;
    const listEventPage = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return { events: [], snapshotCursor: 1, hasMore: false };
    });
    Object.assign(window, { modus: { agent: { listEventPage } } });
    render(<ActivityTimeline cwd="/repo" hub={new AgentEventHub()} sessionId="s" />);
    const retry = await screen.findByRole("button", { name: "Couldn't load activity. Retry" });
    expect(retry.textContent).toBe("Retry");
    expect(screen.getByTestId("activity-timeline").textContent).toBe("Retry");
    fireEvent.click(retry);
    await waitFor(() => expect(listEventPage).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Couldn't load activity. Retry" })).toBeNull(),
    );
  });

  it("panel copy follows the app language (pt)", () => {
    document.documentElement.lang = "pt-BR";
    try {
      render(<ActivityTimeline cwd="/repo" hub={new AgentEventHub()} sessionId="s" />);
      expect(screen.getByRole("region", { name: "Atividade" })).toBeTruthy();
    } finally {
      document.documentElement.lang = "";
    }
  });
});

describe("terminal card footer", () => {
  const ok = { name: "bash", args: { command: "npm test" }, isComplete: true };
  it("shows no status footer for a successful command", () => {
    render(<TerminalToolCard {...ok} isError={false} output={"done\n"} />);
    fireEvent.click(screen.getByRole("button", { name: /Ran npm test/ }));
    expect(screen.queryByText("Success")).toBeNull();
  });
  it("keeps the footer on failure, with the alert icon and no red border box", () => {
    render(<TerminalToolCard {...ok} isError output={"boom\n"} />);
    const toggle = screen.getByRole("button", { name: /npm test/ });
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
    expect(screen.getByText("Failed")).toBeTruthy();
    const box = screen.getByText("Failed").closest("[data-activity-inset]");
    expect(box?.getAttribute("data-activity-inset")).toBe("error");
  });
});
