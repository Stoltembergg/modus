import { describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import {
  applyGroupActivityEvent,
  type GroupMemberStatesById,
  groupActivityState,
  isGroupRunning,
  memberActivityState,
  waitingSessionIdsOf,
} from "./useWorkingGroups";

const activity = (
  groupId: string,
  running: string[],
  queued: string[] = [],
  waiting: string[] = [],
) =>
  ({
    type: "group.activity",
    groupId,
    runningSessionIds: running,
    queuedSessionIds: queued,
    waitingSessionIds: waiting,
  }) as const;

describe("applyGroupActivityEvent", () => {
  it("tracks a group while a member runs, queues or waits, and drops it when all are empty", () => {
    const empty: GroupMemberStatesById = new Map();
    const running = applyGroupActivityEvent(empty, activity("g1", ["s1"]));
    expect(groupActivityState(running, "g1")).toBe("working");
    expect(isGroupRunning(running, "g1")).toBe(true);
    const queued = applyGroupActivityEvent(running, activity("g1", [], ["s2"]));
    expect(groupActivityState(queued, "g1")).toBe("working");
    const idle = applyGroupActivityEvent(queued, activity("g1", []));
    expect(idle.has("g1")).toBe(false);
    expect(groupActivityState(idle, "g1")).toBe("idle");
    // Already idle: same map.
    expect(applyGroupActivityEvent(idle, activity("g1", []))).toBe(idle);
  });

  it("waiting for you takes priority over working, for the group and per member", () => {
    const states = applyGroupActivityEvent(new Map(), activity("g1", ["s1"], [], ["s2"]));
    expect(groupActivityState(states, "g1")).toBe("waiting");
    expect(memberActivityState(states, "g1", "s1")).toBe("working");
    expect(memberActivityState(states, "g1", "s2")).toBe("waiting");
    expect(memberActivityState(states, "g1", "s3")).toBe("idle");
    expect(waitingSessionIdsOf(states, "g1")).toEqual(["s2"]);
    expect(waitingSessionIdsOf(states, "missing")).toEqual([]);
    // Waiting alone must remain stoppable.
    const waitingOnly = applyGroupActivityEvent(states, activity("g1", [], [], ["s2"]));
    expect(isGroupRunning(waitingOnly, "g1")).toBe(true);
    expect(groupActivityState(waitingOnly, "g1")).toBe("waiting");
  });

  it("ignores other events", () => {
    const states = applyGroupActivityEvent(new Map(), activity("g1", ["s1"]));
    expect(
      applyGroupActivityEvent(states, {
        type: "group.message",
        groupId: "g1",
        message: {} as GroupMessage,
      }),
    ).toBe(states);
    expect(
      applyGroupActivityEvent(states, {
        type: "group.chain-ended",
        groupId: "g1",
        chainId: "c1",
        reason: "stopped",
      }),
    ).toBe(states);
  });
});
