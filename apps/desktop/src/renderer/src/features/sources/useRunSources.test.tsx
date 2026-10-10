// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEventItem,
  AgentEventPage,
  AgentEventPageOptions,
} from "../../../../shared/agent-events";
import { useRunSources, useRunSourcesForRuns } from "./useRunSources";

afterEach(() => {
  cleanup();
  Object.assign(window, { modus: undefined });
});

describe("useRunSources", () => {
  it("loads only tool activity from the requested run through paged IPC", async () => {
    const events: AgentEventItem[] = [
      {
        id: "run-started",
        event: {
          type: "run.started",
          sessionId: "s",
          runId: "run-target",
          delivery: "normal",
          eventCursor: 1,
        },
      },
      {
        id: "tool-started",
        event: {
          type: "tool.started",
          sessionId: "s",
          runId: "run-target",
          toolCallId: "read-call",
          toolName: "read_file",
          args: { path: "/repo/src/target.ts" },
          eventCursor: 2,
        },
      },
      {
        id: "tool-output",
        event: {
          type: "tool.output",
          sessionId: "s",
          toolCallId: "read-call",
          output: "read complete",
          eventCursor: 3,
        },
      },
      {
        id: "tool-ended",
        event: {
          type: "tool.ended",
          sessionId: "s",
          runId: "run-target",
          toolCallId: "read-call",
          toolName: "read_file",
          isError: false,
          eventCursor: 4,
        },
      },
      {
        id: "run-completed",
        event: { type: "run.completed", sessionId: "s", runId: "run-target", eventCursor: 5 },
      },
    ];
    const page: AgentEventPage = {
      events: events.map((item) => ({
        ...item,
        createdAt: item.createdAt ?? "2026-10-01T12:00:00.000Z",
      })),
      summaryEvents: [],
      activityEvents: [],
      snapshotCursor: 5,
      nextCursor: 5,
      hasMore: false,
    };
    const listEventPage = vi.fn(async (): Promise<AgentEventPage> => page);
    const listEvents = vi.fn(async (): Promise<AgentEventItem[]> => events);
    Object.assign(window, { modus: { agent: { listEventPage, listEvents } } });

    const hook = renderHook(() => useRunSources("s", "run-target", true));

    await waitFor(() =>
      expect(hook.result.current).toEqual([
        expect.objectContaining({ path: "/repo/src/target.ts" }),
      ]),
    );
    expect(listEventPage).toHaveBeenCalledWith(
      "s",
      expect.objectContaining({ runId: "run-target", direction: "forward" }),
    );
    expect(listEvents).not.toHaveBeenCalled();
  });

  it("loads complete main-chat source sets independently for visible runs", async () => {
    const makeRunPage = (runId: string, path: string): AgentEventPage => ({
      events: [
        {
          id: `${runId}-started`,
          event: {
            type: "run.started",
            sessionId: "main-session",
            runId,
            delivery: "normal",
            eventCursor: 1,
          },
          createdAt: "2026-10-01T12:00:00.000Z",
        },
        {
          id: `${runId}-tool-started`,
          event: {
            type: "tool.started",
            sessionId: "main-session",
            runId,
            toolCallId: `${runId}-tool`,
            toolName: "read_file",
            args: { path },
            eventCursor: 2,
          },
          createdAt: "2026-10-01T12:00:01.000Z",
        },
        {
          id: `${runId}-tool-ended`,
          event: {
            type: "tool.ended",
            sessionId: "main-session",
            runId,
            toolCallId: `${runId}-tool`,
            toolName: "read_file",
            isError: false,
            eventCursor: 3,
          },
          createdAt: "2026-10-01T12:00:02.000Z",
        },
      ],
      summaryEvents: [],
      activityEvents: [],
      snapshotCursor: 3,
      nextCursor: 3,
      hasMore: false,
    });
    const listEventPage = vi.fn(async (_sessionId: string, options: AgentEventPageOptions) => {
      if (!("runId" in options) || !options.runId) {
        throw new Error("Expected run-scoped source lookup");
      }
      return makeRunPage(
        options.runId,
        options.runId === "run-one" ? "/repo/one.ts" : "/repo/two.ts",
      );
    });
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const hook = renderHook(() => useRunSourcesForRuns("main-session", ["run-two", "run-one"]));

    await waitFor(() => expect(hook.result.current.sourcesByRun.size).toBe(2));
    expect(hook.result.current.sourcesByRun.get("run-one")).toEqual([
      expect.objectContaining({ path: "/repo/one.ts" }),
    ]);
    expect(hook.result.current.sourcesByRun.get("run-two")).toEqual([
      expect.objectContaining({ path: "/repo/two.ts" }),
    ]);
    expect(hook.result.current.loadingRunIds.size).toBe(0);
    expect(hook.result.current.failedRunIds.size).toBe(0);
    expect(listEventPage).toHaveBeenCalledWith(
      "main-session",
      expect.objectContaining({ runId: "run-one", direction: "forward" }),
    );
    expect(listEventPage).toHaveBeenCalledWith(
      "main-session",
      expect.objectContaining({ runId: "run-two", direction: "forward" }),
    );
  });

  it("keeps source completeness pending and marks failed run lookups unavailable", async () => {
    let releaseFirstPage: ((page: AgentEventPage) => void) | undefined;
    const listEventPage = vi.fn(async (_sessionId: string, options: AgentEventPageOptions) => {
      if (!("runId" in options) || !options.runId) {
        throw new Error("Expected run-scoped source lookup");
      }
      if (options.runId === "run-failed") throw new Error("offline");
      return new Promise<AgentEventPage>((resolve) => {
        releaseFirstPage = resolve;
      });
    });
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const hook = renderHook(() =>
      useRunSourcesForRuns("main-session", ["run-pending", "run-failed"]),
    );

    await waitFor(() => expect(hook.result.current.failedRunIds.has("run-failed")).toBe(true));
    expect(hook.result.current.requestedRunIds).toEqual(new Set(["run-failed", "run-pending"]));
    expect(hook.result.current.loadingRunIds).toEqual(new Set(["run-pending"]));
    expect(hook.result.current.sourcesByRun.has("run-pending")).toBe(false);

    releaseFirstPage?.({
      events: [],
      summaryEvents: [],
      activityEvents: [],
      snapshotCursor: 0,
      hasMore: false,
    });
    await waitFor(() => expect(hook.result.current.loadingRunIds.size).toBe(0));
    expect(hook.result.current.failedRunIds).toEqual(new Set(["run-failed"]));
    expect(hook.result.current.sourcesByRun.has("run-pending")).toBe(true);
    expect(hook.result.current.sourcesByRun.get("run-pending")).toEqual([]);
  });

  it("marks run history unavailable when a page cursor stalls", async () => {
    const listEventPage = vi.fn(async () => ({
      events: [],
      summaryEvents: [],
      activityEvents: [],
      snapshotCursor: 5,
      nextCursor: 0,
      hasMore: true,
    }));
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const hook = renderHook(() => useRunSourcesForRuns("stalled-session", ["stalled-run"]));

    await waitFor(() => expect(hook.result.current.failedRunIds.has("stalled-run")).toBe(true));
    expect(hook.result.current.sourcesByRun.has("stalled-run")).toBe(false);
  });

  it("marks run history unavailable when the page snapshot changes mid-read", async () => {
    const listEventPage = vi
      .fn()
      .mockResolvedValueOnce({
        events: [],
        summaryEvents: [],
        activityEvents: [],
        snapshotCursor: 5,
        nextCursor: 1,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        events: [],
        summaryEvents: [],
        activityEvents: [],
        snapshotCursor: 6,
        nextCursor: 2,
        hasMore: false,
      });
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const hook = renderHook(() => useRunSourcesForRuns("snapshot-session", ["snapshot-run"]));

    await waitFor(() => expect(hook.result.current.failedRunIds.has("snapshot-run")).toBe(true));
    expect(listEventPage).toHaveBeenCalledTimes(2);
    expect(hook.result.current.sourcesByRun.has("snapshot-run")).toBe(false);
  });
});
