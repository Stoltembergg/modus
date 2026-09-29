import { describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { applyGroupActivityEvent } from "./useWorkingGroups";

const activity = (groupId: string, running: string[], queued: string[] = []) =>
  ({
    type: "group.activity",
    groupId,
    runningSessionIds: running,
    queuedSessionIds: queued,
  }) as const;

describe("applyGroupActivityEvent", () => {
  it("marks a group working while a member runs or waits, and idle when both are empty", () => {
    const empty: ReadonlySet<string> = new Set();
    const running = applyGroupActivityEvent(empty, activity("g1", ["s1"]));
    expect([...running]).toEqual(["g1"]);
    const queued = applyGroupActivityEvent(running, activity("g1", [], ["s2"]));
    expect(queued).toBe(running);
    expect([...applyGroupActivityEvent(queued, activity("g1", []))]).toEqual([]);
  });

  it("ignores other events", () => {
    const set: ReadonlySet<string> = new Set(["g1"]);
    expect(
      applyGroupActivityEvent(set, {
        type: "group.message",
        groupId: "g1",
        message: {} as GroupMessage,
      }),
    ).toBe(set);
    expect(
      applyGroupActivityEvent(set, {
        type: "group.chain-ended",
        groupId: "g1",
        chainId: "c1",
        reason: "blocked",
      }),
    ).toBe(set);
  });
});
