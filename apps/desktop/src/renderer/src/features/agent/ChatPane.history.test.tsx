// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEventItem,
  AgentEventPage,
  AgentEventPageOptions,
} from "../../../../shared/agent-events";
import type { AgentSessionInfo, PlanRef } from "../../../../shared/contracts";
import { AgentEventHub } from "./agentEventHub";
import { ChatPane } from "./ChatPane";

vi.mock("./Timeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Timeline")>();
  return {
    ...actual,
    Timeline: ({ blocks }: { blocks: Array<{ id: string }> }) => (
      <div data-testid="chat-timeline">{blocks.map((block) => block.id).join(",")}</div>
    ),
  };
});
vi.mock("./ConversationTimeline", () => ({ ConversationTimeline: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.assign(window, { modus: undefined });
});

describe("ChatPane paged history", () => {
  it("automatically fills an underfilled session viewport using its fixed snapshot", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    const latestEvent: AgentEventItem = {
      id: "latest-run",
      event: {
        type: "run.started",
        sessionId: "session-1",
        runId: "latest",
        delivery: "normal",
        eventCursor: 8,
      },
      createdAt: "2026-10-01T12:00:00.000Z",
    };
    const latestCompletion: AgentEventItem = {
      id: "latest-completion",
      event: {
        type: "run.completed",
        sessionId: "session-1",
        runId: "latest",
        eventCursor: 9,
      },
      createdAt: "2026-10-01T12:00:01.000Z",
    };
    const olderEvent: AgentEventItem = {
      id: "older-run",
      event: {
        type: "run.started",
        sessionId: "session-1",
        runId: "older",
        delivery: "normal",
        eventCursor: 3,
      },
      createdAt: "2026-10-01T11:00:00.000Z",
    };
    const toPage = (
      events: AgentEventItem[],
      nextCursor: number,
      hasMore: boolean,
    ): AgentEventPage => ({
      events: events.map((item) => ({
        ...item,
        createdAt: item.createdAt ?? "2026-10-01T12:00:00.000Z",
      })),
      summaryEvents: [],
      activityEvents: [],
      snapshotCursor: 9,
      nextCursor,
      hasMore,
    });
    const listEventPage = vi.fn(async (_sessionId: string, options: AgentEventPageOptions) =>
      "runId" in options && options.runId
        ? toPage([], 0, false)
        : options.direction === "backward" && options.beforeCursor !== undefined
          ? toPage([olderEvent], 3, false)
          : toPage([latestEvent, latestCompletion], 9, true),
    );
    Object.assign(window, {
      modus: {
        agent: {
          listEventPage,
          releaseRuntime: vi.fn(async () => undefined),
          startPlanBuild: vi.fn(),
        },
        diff: { sessionStats: vi.fn(async () => ({})) },
        process: {
          list: vi.fn(async () => []),
          onChanged: vi.fn(() => () => undefined),
        },
      },
    });
    const session = {
      id: "session-1",
      workspaceId: "workspace-1",
      title: "Session",
      cwd: "/repo",
      status: "idle",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    } satisfies AgentSessionInfo;
    const view = render(
      <ChatPane
        defaultModel=""
        hideComposer
        hub={new AgentEventHub()}
        models={[]}
        onModelChange={() => undefined}
        onModelConfigChange={async () => undefined}
        onOpenReview={() => undefined}
        onPlanUpdated={() => undefined}
        onSessionsChanged={() => undefined}
        session={session}
        workspace={null}
      />,
    );

    await waitFor(() =>
      expect(
        listEventPage.mock.calls.some(
          ([, options]) => options.direction === "backward" && options.beforeCursor === 9,
        ),
      ).toBe(true),
    );
    expect(listEventPage).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ direction: "backward", includeSummary: true }),
    );

    await waitFor(() =>
      expect(
        listEventPage.mock.calls.filter(([, options]) => options.direction === "backward"),
      ).toHaveLength(2),
    );
    expect(listEventPage).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        direction: "backward",
        beforeCursor: 9,
        snapshotCursor: 9,
      }),
    );
    expect(listEventPage).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ runId: "latest", direction: "forward" }),
    );
    await waitFor(() => expect(screen.queryByTestId("chat-load-older-events")).toBeNull());
    view.unmount();
  });
  it("does not carry the previous session pagination cursor into the newly selected session", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500);
    const listEventPage = vi.fn(async (sessionId: string, _options: AgentEventPageOptions) => ({
      events: [
        {
          id: `${sessionId}-run`,
          createdAt: "now",
          event: {
            type: "run.started" as const,
            sessionId,
            runId: `${sessionId}-run`,
            delivery: "normal" as const,
          },
        },
      ],
      summaryEvents: [],
      activityEvents: [],
      snapshotCursor: sessionId === "first" ? 10 : 20,
      nextCursor: 10,
      hasMore: sessionId === "first",
    }));
    Object.assign(window, {
      modus: {
        agent: { listEventPage, releaseRuntime: vi.fn(async () => undefined) },
        diff: { sessionStats: vi.fn(async () => ({})) },
        process: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => undefined) },
      },
    });
    const hub = new AgentEventHub();
    const pane = (id: string) => (
      <ChatPane
        defaultModel=""
        hideComposer
        hub={hub}
        models={[]}
        onModelChange={() => {}}
        onModelConfigChange={async () => {}}
        onOpenReview={() => {}}
        onPlanUpdated={() => {}}
        onSessionsChanged={() => {}}
        workspace={null}
        session={{
          id,
          workspaceId: "workspace",
          title: id,
          cwd: "/repo",
          status: "running",
          createdAt: "now",
          updatedAt: "now",
        }}
      />
    );
    const view = render(pane("first"));
    await screen.findByTestId("chat-load-older-events");
    height.mockReturnValue(0);
    view.rerender(pane("second"));
    await waitFor(() => expect(hub.getHistory("second")).toHaveLength(1));
    expect(
      listEventPage.mock.calls.some(
        ([id, options]) =>
          id === "second" &&
          options?.direction === "backward" &&
          options.beforeCursor !== undefined,
      ),
    ).toBe(false);
  });

  it("keeps the SDK alive when leaving a pane while plan approval is still starting", async () => {
    const session: AgentSessionInfo = {
      id: "approval-session",
      workspaceId: "workspace",
      title: "Plan",
      cwd: "/repo",
      status: "idle",
      createdAt: "now",
      updatedAt: "now",
    };
    const plan: PlanRef = {
      id: session.id,
      sessionId: session.id,
      workspaceId: session.workspaceId,
      title: "Plan",
      overview: "Implement safely",
      content: "Approved content",
      blocks: [],
      todos: [{ id: "step", content: "Implement", status: "pending" }],
      path: "/plan.md",
      hash: "hash",
      buildStatus: "not_built",
      createdAt: "now",
      updatedAt: "now",
    };
    let finish!: () => void;
    const startPlanBuild = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const releaseRuntime = vi.fn(async () => undefined);
    Object.assign(window, {
      modus: {
        agent: {
          startPlanBuild,
          releaseRuntime,
          listEventPage: vi.fn(async () => ({
            events: [
              {
                id: "plan",
                createdAt: "now",
                event: { type: "plan.updated", sessionId: session.id, plan, eventCursor: 1 },
              },
            ],
            summaryEvents: [],
            activityEvents: [],
            snapshotCursor: 1,
            nextCursor: 1,
            hasMore: false,
          })),
        },
        diff: { sessionStats: vi.fn(async () => ({})) },
        process: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => undefined) },
      },
    });
    const view = render(
      <ChatPane
        defaultModel=""
        hub={new AgentEventHub()}
        models={[]}
        onModelChange={() => {}}
        onModelConfigChange={async () => {}}
        onOpenReview={() => {}}
        onPlanUpdated={() => {}}
        onSessionsChanged={() => {}}
        session={session}
        workspace={null}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Yes, implement/ }));
    await waitFor(() => expect(startPlanBuild).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => {
      finish();
    });
    expect(releaseRuntime).not.toHaveBeenCalled();
  });
});
