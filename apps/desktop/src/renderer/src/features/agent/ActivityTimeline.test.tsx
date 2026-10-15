// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEventItem,
  AgentEventPage,
  AgentEventPageOptions,
} from "../../../../shared/agent-events";
import type { PlanRef } from "../../../../shared/contracts";
import { ActivityTimeline } from "./ActivityTimeline";
import { AgentEventHub } from "./agentEventHub";

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.assign(window, { modus: undefined });
});

describe("ActivityTimeline", () => {
  it.each([
    "underfilled",
    "overflow",
    "retry",
    "hidden",
  ])("loads earlier activity automatically or on scroll, with explicit retry (%s)", async (mode) => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
      mode === "hidden" ? 0 : 300,
    );
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      mode === "overflow" ? 500 : 0,
    );
    const page = (
      events: AgentEventItem[],
      snapshotCursor: number,
      nextCursor: number | undefined,
      hasMore: boolean,
    ): AgentEventPage => ({
      events: events.map((item) => ({
        ...item,
        createdAt: item.createdAt ?? "2026-10-01T12:00:00.000Z",
      })),
      summaryEvents: [],
      activityEvents: [],
      snapshotCursor,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      hasMore,
    });
    const latest: AgentEventItem = {
      id: "latest",
      event: {
        type: "run.started",
        sessionId: "s",
        runId: "run-latest",
        delivery: "normal",
        eventCursor: 20,
      },
      createdAt: "2026-10-01T12:00:00.000Z",
    };
    const olderStarted: AgentEventItem = {
      id: "older-started",
      event: {
        type: "run.started",
        sessionId: "s",
        runId: "run-older",
        delivery: "normal",
        eventCursor: 10,
      },
      createdAt: "2026-10-01T11:00:00.000Z",
    };
    const olderCompleted: AgentEventItem = {
      id: "older-completed",
      event: { type: "run.completed", sessionId: "s", runId: "run-older", eventCursor: 11 },
      createdAt: "2026-10-01T11:01:00.000Z",
    };
    let olderAttempts = 0;
    const listEventPage = vi.fn(async (_sessionId: string, options: AgentEventPageOptions) => {
      if (options.direction === "backward" && options.beforeCursor !== undefined) {
        olderAttempts += 1;
        if (mode === "retry" && olderAttempts === 1)
          throw new Error("Storage temporarily unavailable");
        return page([olderStarted, olderCompleted], 20, 10, false);
      }
      return page([latest], 20, 20, true);
    });
    Object.assign(window, { modus: { agent: { listEventPage } } });
    render(<ActivityTimeline cwd="/repo" hub={new AgentEventHub()} sessionId="s" />);
    if (mode === "hidden") {
      await screen.findByRole("button", { name: "Load earlier activity" });
      expect(olderAttempts).toBe(0);
      return;
    }
    if (mode === "overflow") {
      const button = await screen.findByRole("button", { name: "Load earlier activity" });
      expect(olderAttempts).toBe(0);
      fireEvent.scroll(button.parentElement as HTMLElement);
    }
    if (mode === "retry") {
      await screen.findByText("Unable to load activity history. Try again.");
      expect(olderAttempts).toBe(1);
      const button = screen.getByRole("button", { name: "Load earlier activity" });
      fireEvent.scroll(button.parentElement as HTMLElement);
      expect(olderAttempts).toBe(1);
      fireEvent.click(button);
    }
    await waitFor(() =>
      expect(screen.getByTestId("activity-event-count").textContent).toBe("3 events"),
    );
    expect(listEventPage).toHaveBeenCalledWith(
      "s",
      expect.objectContaining({ direction: "backward", beforeCursor: 20, snapshotCursor: 20 }),
    );
  });

  it("ignores an older-page response arriving after switching sessions", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    let finishOlder!: (page: AgentEventPage) => void;
    const run = (sessionId: string): AgentEventPage => ({
      events: [
        {
          id: `${sessionId}-run`,
          createdAt: "now",
          event: {
            type: "run.started",
            sessionId,
            runId: `${sessionId}-run`,
            delivery: "normal",
            eventCursor: 20,
          },
        },
      ],
      summaryEvents: [],
      activityEvents: [],
      snapshotCursor: 20,
      nextCursor: 20,
      hasMore: sessionId === "first",
    });
    const listEventPage = vi.fn(async (sessionId: string, options: AgentEventPageOptions) => {
      if (options.direction === "backward" && options.beforeCursor !== undefined) {
        return new Promise<AgentEventPage>((resolve) => {
          finishOlder = resolve;
        });
      }
      return run(sessionId);
    });
    Object.assign(window, { modus: { agent: { listEventPage } } });
    const hub = new AgentEventHub();
    const view = render(<ActivityTimeline cwd="/repo" hub={hub} sessionId="first" />);
    await waitFor(() => expect(finishOlder).toBeTypeOf("function"));
    view.rerender(<ActivityTimeline cwd="/repo" hub={hub} sessionId="second" />);
    await waitFor(() =>
      expect(screen.getByTestId("activity-blocks").textContent).toContain("second-run"),
    );
    await act(async () => {
      finishOlder({ ...run("first"), hasMore: false });
    });
    expect(screen.getByTestId("activity-blocks").textContent).not.toContain("first-run");
    expect(screen.getByTestId("activity-event-count").textContent).toBe("1 event");
  });

  it("drops the previous session history when the selected session changes", async () => {
    const hub = new AgentEventHub();
    const view = render(<ActivityTimeline cwd="/repo" hub={hub} sessionId="first" />);
    hub.seedHistory("first", [
      {
        id: "first-run",
        createdAt: "2026-10-01T12:00:00.000Z",
        event: { type: "run.started", sessionId: "first", runId: "run-1", delivery: "normal" },
      },
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("activity-event-count").textContent).toBe("1 event"),
    );

    view.rerender(<ActivityTimeline cwd="/repo" hub={hub} sessionId="second" />);

    await waitFor(() =>
      expect(screen.getByTestId("activity-event-count").textContent).toBe("0 events"),
    );
  });

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
    await waitFor(() =>
      expect(screen.getByTestId("activity-event-count").textContent).toBe("1 event"),
    );

    hub.publish({
      id: "completed",
      createdAt: "2026-10-01T12:00:01.000Z",
      event: { type: "run.completed", sessionId: "s", runId: "run-1" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("activity-event-count").textContent).toBe("2 events"),
    );
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

  it("never duplicates the to-do list in Activity (it lives above the Composer)", async () => {
    const hub = new AgentEventHub();
    render(<ActivityTimeline cwd="/repo" hub={hub} sessionId="s" />);
    hub.seedHistory("s", [
      {
        id: "todos-1",
        createdAt: "2026-10-01T12:00:00.000Z",
        event: {
          type: "todos.updated",
          sessionId: "s",
          todos: [{ id: "t1", content: "Write tests", status: "pending" }],
        },
      },
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("activity-event-count").textContent).toMatch(/1/),
    );
    expect(screen.queryByText("Write tests")).toBeNull();
  });
});
