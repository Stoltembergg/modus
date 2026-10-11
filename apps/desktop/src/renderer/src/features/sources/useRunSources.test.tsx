// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function emptyPage(snapshotCursor = 0): AgentEventPage {
  return {
    events: [],
    summaryEvents: [],
    activityEvents: [],
    snapshotCursor,
    hasMore: false,
  };
}

async function resolvePendingPages(
  pendingPages: Array<ReturnType<typeof deferred<AgentEventPage>>>,
): Promise<void> {
  while (pendingPages.length > 0) {
    const batch = pendingPages.splice(0);
    await act(async () => {
      for (const pending of batch) pending.resolve(emptyPage());
      await Promise.all(batch.map((pending) => pending.promise));
    });
  }
}

describe("useRunSources", () => {
  it("limits concurrent event-page requests across visible run collections", async () => {
    let active = 0;
    let maximumActive = 0;
    const pendingPages: Array<ReturnType<typeof deferred<AgentEventPage>>> = [];
    const listEventPage = vi.fn((_sessionId: string, _options: AgentEventPageOptions) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      const pending = deferred<AgentEventPage>();
      pendingPages.push(pending);
      return pending.promise.finally(() => {
        active--;
      });
    });
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const first = renderHook(() => useRunSourcesForRuns("main-session", ["a", "b", "c", "d"]));
    const second = renderHook(() => useRunSourcesForRuns("main-session", ["e", "f", "g", "h"]));
    try {
      await waitFor(() => expect(listEventPage).toHaveBeenCalledTimes(4));
      expect(maximumActive).toBe(4);
      expect(pendingPages).toHaveLength(4);

      await act(async () => {
        for (const pending of pendingPages.splice(0)) pending.resolve(emptyPage());
      });
      await waitFor(() => expect(listEventPage).toHaveBeenCalledTimes(8));

      await act(async () => {
        for (const pending of pendingPages.splice(0)) pending.resolve(emptyPage());
      });
      await waitFor(() => {
        expect(first.result.current.loadingRunIds.size).toBe(0);
        expect(second.result.current.loadingRunIds.size).toBe(0);
      });
      expect(maximumActive).toBe(4);
      expect(first.result.current.failedRunIds.size).toBe(0);
      expect(second.result.current.failedRunIds.size).toBe(0);
    } finally {
      first.unmount();
      second.unmount();
      await resolvePendingPages(pendingPages);
    }
  });

  it("stops paging an in-flight source lookup after its last view unmounts", async () => {
    const firstPage = deferred<AgentEventPage>();
    const listEventPage = vi.fn().mockReturnValue(firstPage.promise);
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const hook = renderHook(() => useRunSources("session-cancel", "run-cancel", true));
    try {
      await waitFor(() => expect(listEventPage).toHaveBeenCalledTimes(1));
      hook.unmount();

      await act(async () => {
        firstPage.resolve({
          ...emptyPage(2),
          nextCursor: 2,
          hasMore: true,
        });
        await firstPage.promise;
      });
      await Promise.resolve();

      expect(listEventPage).toHaveBeenCalledTimes(1);
    } finally {
      hook.unmount();
      await resolvePendingPages([firstPage]);
    }
  });

  it("cancels a queued source lookup when its last view unmounts", async () => {
    const pendingPages: Array<ReturnType<typeof deferred<AgentEventPage>>> = [];
    const listEventPage = vi.fn(() => {
      const pending = deferred<AgentEventPage>();
      pendingPages.push(pending);
      return pending.promise;
    });
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const hooks = Array.from({ length: 5 }, (_, index) =>
      renderHook(() => useRunSources("queued-session", `queued-run-${index}`, true)),
    );
    let queuedViewUnmounted = false;
    try {
      await waitFor(() => expect(listEventPage).toHaveBeenCalledTimes(4));
      await waitFor(() => expect(hooks[4]?.result.current.status).toBe("loading"));
      hooks[4]?.unmount();
      queuedViewUnmounted = true;

      await resolvePendingPages(pendingPages);
      await waitFor(() => {
        for (const hook of hooks.slice(0, 4)) {
          expect(hook.result.current.status).toBe("loaded");
        }
      });
      expect(listEventPage).toHaveBeenCalledTimes(4);
    } finally {
      hooks.forEach((hook, index) => {
        if (index !== 4 || !queuedViewUnmounted) hook.unmount();
      });
      await resolvePendingPages(pendingPages);
    }
  });

  it("keeps a deduplicated lookup active until its last view unmounts", async () => {
    const firstPage = deferred<AgentEventPage>();
    const secondPage = deferred<AgentEventPage>();
    const listEventPage = vi
      .fn()
      .mockReturnValueOnce(firstPage.promise)
      .mockReturnValueOnce(secondPage.promise);
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const first = renderHook(() => useRunSources("shared-session", "shared-run", true));
    const second = renderHook(() => useRunSources("shared-session", "shared-run", true));
    let firstViewUnmounted = false;
    try {
      await waitFor(() => expect(listEventPage).toHaveBeenCalledTimes(1));
      first.unmount();
      firstViewUnmounted = true;

      await act(async () => {
        firstPage.resolve({ ...emptyPage(2), nextCursor: 2, hasMore: true });
        await firstPage.promise;
      });
      await waitFor(() => expect(listEventPage).toHaveBeenCalledTimes(2));

      await act(async () => {
        secondPage.resolve(emptyPage(2));
        await secondPage.promise;
      });
      await waitFor(() => expect(second.result.current.status).toBe("loaded"));
      expect(listEventPage).toHaveBeenCalledTimes(2);
      expect(second.result.current.sources).toEqual([]);
    } finally {
      if (!firstViewUnmounted) first.unmount();
      second.unmount();
      await act(async () => {
        firstPage.resolve(emptyPage());
        secondPage.resolve(emptyPage());
        await Promise.all([firstPage.promise, secondPage.promise]);
      });
    }
  });

  it("reports queued lookups as unavailable when the global queue is full", async () => {
    const pendingPages: Array<ReturnType<typeof deferred<AgentEventPage>>> = [];
    const listEventPage = vi.fn(() => {
      const pending = deferred<AgentEventPage>();
      pendingPages.push(pending);
      return pending.promise;
    });
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const hooks = Array.from({ length: 66 }, (_, batch) =>
      renderHook(() =>
        useRunSourcesForRuns(
          "overloaded-session",
          Array.from({ length: 4 }, (_, index) => `run-${batch * 4 + index}`),
        ),
      ),
    );
    const overflowing = hooks.at(-1);
    try {
      await waitFor(() => expect(overflowing?.result.current.failedRunIds.size).toBe(4));

      expect(overflowing?.result.current.loadingRunIds.size).toBe(0);
      expect(listEventPage).toHaveBeenCalledTimes(4);
      for (const hook of hooks.slice(0, 65)) {
        expect(hook.result.current.failedRunIds.size).toBe(0);
        expect(hook.result.current.loadingRunIds.size).toBe(4);
      }

      expect(overflowing?.result.current.failedRunIds).toEqual(
        new Set(["run-260", "run-261", "run-262", "run-263"]),
      );
    } finally {
      for (const hook of hooks) hook.unmount();
      await resolvePendingPages(pendingPages);
    }

    expect(listEventPage).toHaveBeenCalledTimes(4);
  });

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
    const page = (
      pageEvents: AgentEventItem[],
      nextCursor: number,
      hasMore: boolean,
    ): AgentEventPage => ({
      events: pageEvents.map((item) => ({
        ...item,
        createdAt: item.createdAt ?? "2026-10-01T12:00:00.000Z",
      })),
      summaryEvents: [],
      activityEvents: [],
      snapshotCursor: 5,
      nextCursor,
      hasMore,
    });
    const firstPage = page(events.slice(0, 2), 2, true);
    const secondPage = page(events.slice(2), 5, false);
    const listEventPage = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const hook = renderHook(() => useRunSources("s", "run-target", true));

    await waitFor(() =>
      expect(hook.result.current.sources).toEqual([
        expect.objectContaining({ path: "/repo/src/target.ts" }),
      ]),
    );
    expect(listEventPage).toHaveBeenCalledWith(
      "s",
      expect.objectContaining({
        runId: "run-target",
        direction: "forward",
        afterCursor: 0,
        limit: 256,
      }),
    );
    expect(listEventPage).toHaveBeenNthCalledWith(2, "s", {
      direction: "forward",
      runId: "run-target",
      afterCursor: 2,
      limit: 256,
      snapshotCursor: 5,
    });
  });

  it("does not retain the full event page after the source view unmounts", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const sessionId = "cache-cleanup-session";
    const runId = "cache-cleanup-run";
    const page: AgentEventPage = {
      events: [
        {
          id: "cache-run-started",
          event: { type: "run.started", sessionId, runId, delivery: "normal", eventCursor: 1 },
          createdAt: "2026-10-01T12:00:00.000Z",
        },
        {
          id: "cache-tool-started",
          event: {
            type: "tool.started",
            sessionId,
            runId,
            toolCallId: "cache-tool",
            toolName: "read_file",
            args: { path: "/repo/cache-cleanup.ts" },
            eventCursor: 2,
          },
          createdAt: "2026-10-01T12:00:01.000Z",
        },
        {
          id: "cache-tool-ended",
          event: {
            type: "tool.ended",
            sessionId,
            runId,
            toolCallId: "cache-tool",
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
    };
    const listEventPage = vi.fn(async (): Promise<AgentEventPage> => page);
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const firstView = renderHook(() => useRunSources(sessionId, runId, true));
    try {
      await waitFor(() => expect(firstView.result.current.sources).toHaveLength(1));
      firstView.unmount();

      const secondView = renderHook(() => useRunSources(sessionId, runId, true));
      await waitFor(() => expect(secondView.result.current.sources).toHaveLength(1));
      expect(listEventPage).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
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

  it("marks the whole source lookup failed when unfinished calls exceed the collector budget", async () => {
    const sessionId = "bounded-source-session";
    const runId = "bounded-source-run";
    const events: AgentEventPage["events"] = Array.from({ length: 257 }, (_, index) => ({
      id: `bounded-start-${index}`,
      event: {
        type: "tool.started" as const,
        sessionId,
        runId,
        toolCallId: `bounded-call-${index}`,
        toolName: "web_search",
        args: { query: "docs" },
        eventCursor: index + 1,
      },
      createdAt: "2026-10-01T12:00:00.000Z",
    }));
    const firstPage: AgentEventPage = {
      events: events.slice(0, 256),
      summaryEvents: [],
      activityEvents: [],
      snapshotCursor: 257,
      nextCursor: 256,
      hasMore: true,
    };
    const secondPage: AgentEventPage = {
      events: events.slice(256),
      summaryEvents: [],
      activityEvents: [],
      snapshotCursor: 257,
      nextCursor: 257,
      hasMore: false,
    };
    const listEventPage = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const hook = renderHook(() => useRunSourcesForRuns(sessionId, [runId]));

    await waitFor(() => expect(hook.result.current.failedRunIds.has(runId)).toBe(true));
    expect(listEventPage).toHaveBeenCalledTimes(2);
    expect(hook.result.current.sourcesByRun.has(runId)).toBe(false);
    expect(hook.result.current.loadingRunIds.has(runId)).toBe(false);
  });

  it("fails a paged lookup when retained output crosses the run budget", async () => {
    const sessionId = "bounded-output-session";
    const runId = "bounded-output-run";
    const firstPage: AgentEventPage = {
      events: [
        {
          id: "bounded-output-start",
          event: {
            type: "tool.started",
            sessionId,
            runId,
            toolCallId: "bounded-output-call",
            toolName: "web_search",
            eventCursor: 1,
          },
          createdAt: "2026-10-01T12:00:00.000Z",
        },
      ],
      summaryEvents: [],
      activityEvents: [],
      snapshotCursor: 3,
      nextCursor: 1,
      hasMore: true,
    };
    const secondPage: AgentEventPage = {
      events: [
        {
          id: "bounded-output-text",
          event: {
            type: "tool.output",
            sessionId,
            toolCallId: "bounded-output-call",
            output: "x".repeat(1024 * 1024 + 1),
            eventCursor: 2,
          },
          createdAt: "2026-10-01T12:00:01.000Z",
        },
        {
          id: "bounded-output-end",
          event: {
            type: "tool.ended",
            sessionId,
            runId,
            toolCallId: "bounded-output-call",
            toolName: "web_search",
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
    };
    const listEventPage = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    Object.assign(window, { modus: { agent: { listEventPage } } });

    const hook = renderHook(() => useRunSourcesForRuns(sessionId, [runId]));

    await waitFor(() => expect(hook.result.current.failedRunIds.has(runId)).toBe(true));
    expect(listEventPage).toHaveBeenCalledTimes(2);
    expect(hook.result.current.sourcesByRun.has(runId)).toBe(false);
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
