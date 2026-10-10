// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEventItem, AgentEventPage } from "../../../../shared/agent-events";
import type { AgentEvent, GroupMemberStates } from "../../../../shared/contracts";
import { useGroupMemberWorking } from "./useGroupMemberWorking";
import type { GroupMemberStatesById } from "./useWorkingGroups";

function states(runningSessionIds: string[], groupId = "g-1"): GroupMemberStatesById {
  const entry: GroupMemberStates = {
    groupId,
    runningSessionIds,
    queuedSessionIds: [],
    waitingSessionIds: [],
  };
  return new Map([[groupId, entry]]);
}
function start(runId: string, sessionId = "s"): AgentEvent {
  return { type: "run.started", sessionId, runId, delivery: "normal" };
}
function delta(text: string, messageId = "m", sessionId = "s"): AgentEvent {
  return { type: "message.delta", sessionId, messageId, delta: text };
}
function item(event: AgentEvent, cursor: number): AgentEventItem {
  return {
    id: String(cursor),
    event: { ...event, eventCursor: cursor } as AgentEvent,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}
let listeners: Set<(event: AgentEvent) => void>;
let seeds: Map<string, (items: AgentEventItem[]) => void>;
function emit(event: AgentEvent, eventCursor?: number) {
  for (const listener of listeners)
    listener({ ...event, ...(eventCursor === undefined ? {} : { eventCursor }) } as AgentEvent);
}
async function seed(sessionId: string, items: AgentEventItem[]) {
  await act(async () => {
    seeds.get(sessionId)?.(items);
    await Promise.resolve();
  });
}
function page(items: AgentEventItem[]): AgentEventPage {
  return {
    events: items as Array<AgentEventItem & { createdAt: string }>,
    summaryEvents: items as Array<AgentEventItem & { createdAt: string }>,
    activityEvents: items as Array<AgentEventItem & { createdAt: string }>,
    snapshotCursor: Math.max(0, ...items.map((entry) => entry.event.eventCursor ?? 0)),
    hasMore: false,
  };
}
beforeEach(() => {
  listeners = new Set();
  seeds = new Map();
  Object.assign(window, {
    modus: {
      agent: {
        listEventPage: vi.fn(
          (id: string) =>
            new Promise<AgentEventPage>((resolve) =>
              seeds.set(id, (items) => resolve(page(items))),
            ),
        ),
        onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
      },
    },
  });
});
afterEach(cleanup);

describe("useGroupMemberWorking hydration", () => {
  it("requests only the bounded activity suffix for running members", () => {
    renderHook(() => useGroupMemberWorking("g-1", states(["s"])));

    expect(window.modus.agent.listEventPage).toHaveBeenCalledWith(
      "s",
      expect.objectContaining({ includeActivity: true, includeSummary: false }),
    );
  });

  it("merges the seed prefix with a live suffix even when the suffix is longer", async () => {
    const hook = renderHook(() => useGroupMemberWorking("g-1", states(["s"])));
    act(() => emit(delta("defghi"), 3));
    await seed("s", [item(start("r"), 1), item(delta("abc"), 2)]);
    await waitFor(() => expect(hook.result.current[0]?.live.streamText).toBe("abcdefghi"));
  });
  it("does not let a larger previous run wipe the active run", async () => {
    const hook = renderHook(() => useGroupMemberWorking("g-1", states(["s"])));
    act(() => {
      emit(start("new"), 3);
      emit(delta("new answer", "new-m"), 4);
    });
    await seed("s", [
      item(start("old"), 1),
      item(delta("x".repeat(100), "old-m"), 2),
      item(start("new"), 3),
    ]);
    await waitFor(() => expect(hook.result.current[0]?.live.streamText).toBe("new answer"));
  });
  it("applies overlapping live chunks only once using the durable cursor", async () => {
    const hook = renderHook(() => useGroupMemberWorking("g-1", states(["s"])));
    act(() => {
      emit(delta("abc"), 2);
      emit(delta("abc"), 3);
    });
    await seed("s", [item(start("r"), 1), item(delta("abc"), 2)]);
    await waitFor(() => expect(hook.result.current[0]?.live.streamText).toBe("abcabc"));
  });
  it("keeps an existing member subscribed when another member starts", async () => {
    const hook = renderHook(({ ids }) => useGroupMemberWorking("g-1", states(ids)), {
      initialProps: { ids: ["s"] },
    });
    await seed("s", [item(start("r"), 1), item(delta("prefix"), 2)]);
    hook.rerender({ ids: ["s", "other"] });
    act(() => emit(delta(" suffix"), 3));
    await waitFor(() =>
      expect(hook.result.current.find((row) => row.sessionId === "s")?.live.streamText).toBe(
        "prefix suffix",
      ),
    );
    expect(window.modus.agent.listEventPage).toHaveBeenCalledTimes(2);
    expect(window.modus.agent.onEvent).toHaveBeenCalledTimes(1);
  });
  it("batches a burst of deltas into one frame publication", async () => {
    let renders = 0;
    const hook = renderHook(() => {
      renders++;
      return useGroupMemberWorking("g-1", states(["s"]));
    });
    await seed("s", [item(start("r"), 1)]);
    const before = renders;
    for (let i = 0; i < 20; i++) act(() => emit(delta("x"), i + 2));
    await waitFor(() => expect(hook.result.current[0]?.live.streamText).toBe("x".repeat(20)));
    expect(renders - before).toBe(1);
  });
  it("ignores a seed from a room that was left", async () => {
    const hook = renderHook(({ id }) => useGroupMemberWorking(id, states([id], id)), {
      initialProps: { id: "A" },
    });
    const resolveA = seeds.get("A");
    hook.rerender({ id: "B" });
    await seed("B", [item(start("b", "B"), 1), item(delta("room B", "b-m", "B"), 2)]);
    await act(async () => {
      resolveA?.([item(delta("room A", "a-m", "A"), 3)]);
    });
    expect(hook.result.current.map((row) => [row.sessionId, row.live.streamText])).toEqual([
      ["B", "room B"],
    ]);
  });
  it("refreshes a stalled seed before its live buffer grows without bound", async () => {
    const hook = renderHook(() => useGroupMemberWorking("g-1", states(["s"])));
    const firstSeed = seeds.get("s");
    act(() => {
      emit(start("r"), 1);
      for (let i = 0; i < 600; i++) emit(delta("x"), i + 2);
    });
    expect(window.modus.agent.listEventPage).toHaveBeenCalledTimes(2);
    await seed("s", [item(start("r"), 1), item(delta("x".repeat(512)), 513)]);
    await act(async () => {
      firstSeed?.([item(start("r"), 1)]);
    });
    await waitFor(() => expect(hook.result.current[0]?.live.streamText).toBe("x".repeat(600)));
  });
});
