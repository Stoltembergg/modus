import { describe, expect, it } from "vitest";
import { groupMemberOpenTarget } from "./groupMemberOpenTarget";

describe("groupMemberOpenTarget", () => {
  it("routes Waiting for you members to the group pane", () => {
    expect(groupMemberOpenTarget("waiting")).toBe("group");
    expect(groupMemberOpenTarget("working")).toBe("chat");
    expect(groupMemberOpenTarget("idle")).toBe("chat");
  });
});
