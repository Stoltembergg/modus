// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanRef } from "../../../../shared/contracts";
import { AgentEventHub } from "./agentEventHub";
import { ActivityTimeline } from "./ActivityTimeline";

vi.mock("./Timeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Timeline")>();
  return {
    ...actual,
    Timeline: ({
      blocks,
      onOpenFile,
      onOpenPlan,
      onOpenSubagent,
    }: {
      blocks: Array<{ id: string }>;
      onOpenFile?: (path: string) => void;
      onOpenPlan?: (plan: PlanRef) => void;
      onOpenSubagent?: (sessionId: string) => void;
    }) => (
      <ul data-testid="activity-blocks">
        {blocks.map((block) => (
          <li key={block.id}>{block.id}</li>
        ))}
        <button onClick={() => onOpenFile?.("/repo/src/app.ts")} type="button">
          Open file
        </button>
        <button onClick={() => onOpenPlan?.({} as PlanRef)} type="button">
          Open plan
        </button>
        <button onClick={() => onOpenSubagent?.("child-session")} type="button">
          Open subagent
        </button>
      </ul>
    ),
  };
});

afterEach(cleanup);

describe("ActivityTimeline", () => {
  it("shows seeded session history and follows live run events", async () => {
    const hub = new AgentEventHub();
    render(<ActivityTimeline cwd="/repo" hub={hub} sessionId="s" />);

    const panel = screen.getByRole("region", { name: "Activity" });
    expect(panel.getAttribute("data-ui-surface")).toBe("sidebar");
    expect(screen.getByTestId("activity-event-count").textContent).toBe("0 events");

    hub.seedHistory("s", [
      {
        id: "started",
        createdAt: "2026-10-01T12:00:00.000Z",
        event: { type: "run.started", sessionId: "s", runId: "run-1", delivery: "normal" },
      },
    ]);
    await waitFor(() => expect(screen.getByTestId("activity-event-count").textContent).toBe("1 event"));

    hub.publish({
      id: "completed",
      createdAt: "2026-10-01T12:00:01.000Z",
      event: { type: "run.completed", sessionId: "s", runId: "run-1" },
    });
    await waitFor(() => expect(screen.getByTestId("activity-event-count").textContent).toBe("2 events"));
  });

  it("forwards file, plan, and subagent actions to the owning app", async () => {
    const hub = new AgentEventHub();
    const onOpenFile = vi.fn<(path: string) => void>();
    const onOpenPlan = vi.fn<(plan: PlanRef) => void>();
    const onOpenSubagent = vi.fn<(sessionId: string) => void>();
    render(
      <ActivityTimeline
        cwd="/repo"
        hub={hub}
        onOpenFile={onOpenFile}
        onOpenPlan={onOpenPlan}
        onOpenSubagent={onOpenSubagent}
        sessionId="s"
      />,
    );

    hub.seedHistory("s", [
      {
        id: "started",
        createdAt: "2026-10-01T12:00:00.000Z",
        event: { type: "run.started", sessionId: "s", runId: "run-1", delivery: "normal" },
      },
    ]);

    await waitFor(() => expect(screen.getByTestId("activity-blocks")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    fireEvent.click(screen.getByRole("button", { name: "Open plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Open subagent" }));

    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/app.ts");
    expect(onOpenPlan).toHaveBeenCalledWith(expect.any(Object));
    expect(onOpenSubagent).toHaveBeenCalledWith("child-session");
  });
});
