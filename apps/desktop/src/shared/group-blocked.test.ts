import { describe, expect, it } from "vitest";
import { CHATS_WORKSPACE_ID } from "./contracts";
import {
  GROUP_MAX_MEMBERS,
  GROUP_MIN_MEMBERS,
  groupBlockedErrorCode,
  groupBlockedReason,
  groupCreateCountError,
  groupMemberCountError,
  groupMembersUpdateCountError,
} from "./group-blocked";

describe("groupBlockedReason", () => {
  it("needs a folder: null and the Chats inbox", () => {
    expect(groupBlockedReason({ workspaceId: null }, 3)).toBe("project-required");
    expect(groupBlockedReason({}, 3)).toBe("project-required");
    expect(groupBlockedReason({ workspaceId: CHATS_WORKSPACE_ID }, 3)).toBe("project-required");
    // The folder comes first: it is what a 1-member legacy group lacks too.
    expect(groupBlockedReason({ workspaceId: null }, 1)).toBe("project-required");
  });

  it("needs two members; more than 10 still works", () => {
    expect(groupBlockedReason({ workspaceId: "ws" }, [])).toBe("min-members");
    expect(groupBlockedReason({ workspaceId: "ws" }, ["a"])).toBe("min-members");
    expect(groupBlockedReason({ workspaceId: "ws" }, ["a", "b"])).toBeNull();
    expect(groupBlockedReason({ workspaceId: "ws" }, 11)).toBeNull();
    expect(groupBlockedErrorCode("project-required")).toBe("group-project-required");
    expect(groupBlockedErrorCode("min-members")).toBe("group-min-members");
  });
});

describe("member count rules", () => {
  it("create: 1 and 11 are refused, 2 and 10 are fine", () => {
    expect([GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS]).toEqual([2, 10]);
    expect(groupCreateCountError(0)).toBe("group-min-members");
    expect(groupCreateCountError(1)).toBe("group-min-members");
    expect(groupCreateCountError(2)).toBeNull();
    expect(groupCreateCountError(10)).toBeNull();
    expect(groupCreateCountError(11)).toBe("group-max-members");
  });

  it("changes: an 11th member and removing at 2 are refused; legacy groups keep working", () => {
    expect(groupMemberCountError(10, 11)).toBe("group-max-members");
    expect(groupMemberCountError(2, 1)).toBe("group-min-members");
    expect(groupMemberCountError(3, 2)).toBeNull();
    // Legacy 11-member group: shrinking is fine, growing is not.
    expect(groupMemberCountError(11, 10)).toBeNull();
    expect(groupMemberCountError(11, 11)).toBeNull();
    expect(groupMemberCountError(11, 12)).toBe("group-max-members");
    // Legacy 1-member group: adding unblocks it.
    expect(groupMemberCountError(1, 2)).toBeNull();
    expect(groupMemberCountError(0, 1)).toBeNull();
  });
});

describe("groupMembersUpdateCountError (one update, the FINAL count)", () => {
  it("checks current - removed + added", () => {
    // Replace both members of a 2-member group.
    expect(groupMembersUpdateCountError(2, 2, 2)).toBeNull();
    expect(groupMembersUpdateCountError(2, 0, 1)).toBe("group-min-members");
    expect(groupMembersUpdateCountError(3, 1, 3)).toBe("group-min-members");
    expect(groupMembersUpdateCountError(10, 1, 0)).toBe("group-max-members");
    expect(groupMembersUpdateCountError(10, 1, 1)).toBeNull();
    // Lead-only change of a legacy 1-member group is refused: the final state is below 2.
    expect(groupMembersUpdateCountError(1, 0, 0)).toBe("group-min-members");
    expect(groupMembersUpdateCountError(1, 1, 0)).toBeNull();
  });

  it("a legacy group above 10 may remove members but never add while above 10", () => {
    expect(groupMembersUpdateCountError(11, 0, 1)).toBeNull();
    expect(groupMembersUpdateCountError(12, 0, 1)).toBeNull();
    expect(groupMembersUpdateCountError(11, 1, 1)).toBe("group-max-members");
    expect(groupMembersUpdateCountError(12, 1, 3)).toBeNull();
  });
});
