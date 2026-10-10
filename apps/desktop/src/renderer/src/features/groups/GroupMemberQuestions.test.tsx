// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventItem, AgentEventPage } from "../../../../shared/agent-events";
import type { AgentEvent } from "../../../../shared/contracts";
import { useGroupMemberQuestions } from "./GroupMemberQuestions";

const requested = (sessionId: string, id: string): AgentEvent => ({
  type: "question.requested",
  sessionId,
  request: { id, sessionId, questions: [] },
});
const resolved = (sessionId: string, id: string): AgentEvent => ({
  type: "question.resolved",
  sessionId,
  requestId: id,
  answers: [],
  skipped: false,
});
afterEach(cleanup);
function setup() {
  let listener!: (event: AgentEvent) => void;
  const seeds = new Map<string, (events: AgentEventItem[]) => void>();
  const toPage = (items: AgentEventItem[]): AgentEventPage => ({
    events: items as Array<AgentEventItem & { createdAt: string }>,
    summaryEvents: items as Array<AgentEventItem & { createdAt: string }>,
    activityEvents: items as Array<AgentEventItem & { createdAt: string }>,
    snapshotCursor: items.length,
    hasMore: false,
  });
  Object.assign(window, {
    modus: {
      agent: {
        listEvents: vi.fn(async () => []),
        listEventPage: vi.fn(
          (sessionId: string) =>
            new Promise<AgentEventPage>((resolve) =>
              seeds.set(sessionId, (items) => resolve(toPage(items))),
            ),
        ),
        onEvent: vi.fn((fn: (event: AgentEvent) => void) => {
          listener = fn;
          return () => {};
        }),
      },
    },
  });
  return { seeds, emit: (event: AgentEvent) => listener(event) };
}
describe("question hydration", () => {
  it("does not restore a question resolved while its seed was pending", async () => {
    const fake = setup();
    const hook = renderHook(() => useGroupMemberQuestions(["s"]));
    expect(window.modus.agent.listEventPage).toHaveBeenCalledWith(
      "s",
      expect.objectContaining({ includeSummary: true }),
    );
    act(() => fake.emit(resolved("s", "q")));
    await act(async () => {
      fake.seeds.get("s")?.([{ id: "q-request", event: requested("s", "q") }]);
    });
    expect(hook.result.current.has("s")).toBe(false);
  });
  it("keeps a waiting member live when another member starts waiting", async () => {
    const fake = setup();
    const hook = renderHook(({ ids }) => useGroupMemberQuestions(ids), {
      initialProps: { ids: ["s"] },
    });
    await act(async () => {
      fake.seeds.get("s")?.([{ id: "q-request", event: requested("s", "q") }]);
    });
    await waitFor(() => expect(hook.result.current.get("s")?.id).toBe("q"));
    hook.rerender({ ids: ["s", "other"] });
    act(() => fake.emit(resolved("s", "q")));
    await waitFor(() => expect(hook.result.current.has("s")).toBe(false));
    expect(window.modus.agent.listEventPage).toHaveBeenCalledTimes(2);
    expect(window.modus.agent.onEvent).toHaveBeenCalledTimes(1);
  });
  it("ignores seeds and events for sessions that left the waiting set", async () => {
    const fake = setup();
    const hook = renderHook(({ ids }) => useGroupMemberQuestions(ids), {
      initialProps: { ids: ["A"] },
    });
    hook.rerender({ ids: ["B"] });
    act(() => fake.emit(requested("A", "wrong")));
    await act(async () => {
      fake.seeds.get("A")?.([{ id: "a", event: requested("A", "wrong") }]);
      fake.seeds.get("B")?.([
        { id: "b", event: requested("B", "right") },
        { id: "wrong", event: requested("A", "wrong") },
      ]);
    });
    await waitFor(() =>
      expect([...hook.result.current].map(([session, request]) => [session, request.id])).toEqual([
        ["B", "right"],
      ]),
    );
  });
  it("does not flash an old question when a member begins a new waiting lifetime", async () => {
    const fake = setup();
    const hook = renderHook(({ ids }) => useGroupMemberQuestions(ids), {
      initialProps: { ids: ["s"] },
    });
    await act(async () => {
      fake.seeds.get("s")?.([{ id: "q-request", event: requested("s", "q") }]);
    });
    await waitFor(() => expect(hook.result.current.get("s")?.id).toBe("q"));
    hook.rerender({ ids: [] });
    act(() => fake.emit(resolved("s", "q")));
    hook.rerender({ ids: ["s"] });
    expect(hook.result.current.has("s")).toBe(false);
  });
});
