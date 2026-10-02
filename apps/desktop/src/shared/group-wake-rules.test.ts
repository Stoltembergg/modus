import { describe, expect, it } from "vitest";
import {
  autonomousWakeEligible,
  memberWakeTargets,
  partitionArchivedWakeTargets,
  resolveUserWakeRule,
} from "./group-wake-rules";

const free = { mode: "free" as const, leadSessionId: "lead" };
const coordinator = { mode: "coordinator" as const, leadSessionId: "lead" };

describe("resolveUserWakeRule (runtime priority order)", () => {
  it("mentions → reply author → coordinator Lead → autonomous", () => {
    expect(
      resolveUserWakeRule({ mentions: ["a"], repliedAuthorSessionId: "b", group: coordinator }),
    ).toEqual({ rule: "mention", wanted: ["a"] });
    expect(
      resolveUserWakeRule({ mentions: [], repliedAuthorSessionId: "b", group: coordinator }),
    ).toEqual({ rule: "reply", wanted: ["b"] });
    expect(resolveUserWakeRule({ mentions: [], group: coordinator })).toEqual({
      rule: "coordinator",
      wanted: ["lead"],
    });
    expect(resolveUserWakeRule({ mentions: [], group: free })).toEqual({ rule: "autonomous" });
    // Coordinator without a Lead is not active.
    expect(resolveUserWakeRule({ mentions: [], group: { mode: "coordinator" } })).toEqual({
      rule: "autonomous",
    });
  });

  it("filters members, the author and archived targets like route()", () => {
    expect(memberWakeTargets(["a", "a", "x", "me"], new Set(["a", "me"]), "me")).toEqual(["a"]);
    expect(
      partitionArchivedWakeTargets(
        ["a", "b"],
        [{ sessionId: "a", archived: true }, { sessionId: "b" }],
      ),
    ).toEqual({ archived: ["a"], targets: ["b"] });
    expect(
      autonomousWakeEligible(
        [{ sessionId: "a", archived: true }, { sessionId: "b" }, { sessionId: "c" }],
        ["c"],
      ),
    ).toEqual([{ sessionId: "b" }]);
  });
});
