// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GroupMemberStates, GroupRuntimeEvent } from "../../../../shared/contracts";
import { applyGroupActivityEvent, isGroupRunning, useGroupMemberStates } from "./useWorkingGroups";

const states = (
  groupId: string,
  runningSessionIds: string[] = [],
  waitingSessionIds: string[] = [],
): GroupMemberStates => ({ groupId, runningSessionIds, queuedSessionIds: [], waitingSessionIds });
afterEach(cleanup);
describe("member state hydration", () => {
  it("keeps live cancellation and user waits ahead of a stale snapshot", async () => {
    let listener!: (event: GroupRuntimeEvent) => void;
    let resolve!: (states: GroupMemberStates[]) => void;
    Object.assign(window, {
      modus: {
        group: {
          onEvent: (fn: (event: GroupRuntimeEvent) => void) => {
            listener = fn;
            return () => {};
          },
          memberStates: () =>
            new Promise<GroupMemberStates[]>((done) => {
              resolve = done;
            }),
        },
      },
    });
    const hook = renderHook(() => useGroupMemberStates());
    act(() => {
      listener({ type: "group.activity", ...states("cancelled") });
      listener({ type: "group.activity", ...states("waiting", [], ["waiter"]) });
    });
    await act(async () => {
      resolve([
        states("cancelled", ["old"]),
        states("waiting", ["old"]),
        states("other", ["worker"]),
        states("idle"),
      ]);
    });
    await waitFor(() =>
      expect(hook.result.current.get("other")?.runningSessionIds).toEqual(["worker"]),
    );
    expect(hook.result.current.has("cancelled")).toBe(false);
    expect(hook.result.current.has("idle")).toBe(false);
    expect(isGroupRunning(hook.result.current, "waiting")).toBe(true);
  });
  it("does not republish identical membership on activity pings", () => {
    const entry = applyGroupActivityEvent(new Map(), {
      type: "group.activity",
      ...states("g", ["worker"]),
    });
    expect(
      applyGroupActivityEvent(entry, { type: "group.activity", ...states("g", ["worker"]) }),
    ).toBe(entry);
  });
});
