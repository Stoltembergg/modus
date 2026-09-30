import { describe, expect, it } from "vitest";
import { groupMemberOpenTarget } from "./groupMemberOpenTarget";

describe("groupMemberOpenTarget", () => {
  it("routes room-active members to the group pane", () => {
    expect(groupMemberOpenTarget("waiting")).toBe("group");
    expect(groupMemberOpenTarget("working")).toBe("group");
    expect(groupMemberOpenTarget("idle")).toBe("chat");
  });
});
