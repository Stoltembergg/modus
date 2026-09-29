import { describe, expect, it } from "vitest";
import type { AgentGroupWithMembers, AgentSessionInfo } from "../../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../../shared/contracts";
import {
  countProjectGroups,
  eligibleGroupSessions,
  groupMemberSessionIds,
  isGroupWorkingStub,
  manageableGroupSessions,
  removeProjectGroupsWarning,
} from "./groupSidebarModel";

function session(id: string, overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
  return {
    id,
    workspaceId: "ws-1",
    title: id,
    cwd: "/repo",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const GROUP: AgentGroupWithMembers = {
  id: "g-1",
  name: "Crew",
  mode: "free",
  workspaceId: "ws-1",
  members: [{ groupId: "g-1", sessionId: "member", joinedAt: "2026-01-01T00:00:00.000Z" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("groupSidebarModel", () => {
  it("collects member session ids across groups", () => {
    expect([...groupMemberSessionIds([GROUP])]).toEqual(["member"]);
    expect(groupMemberSessionIds([]).size).toBe(0);
  });

  it("offers only sessions the store would accept", () => {
    const sessions = [
      session("ok"),
      session("member"),
      session("other-project", { workspaceId: "ws-2" }),
      session("subagent", { parentSessionId: "ok" }),
      session("archived", { archivedAt: "2026-01-02T00:00:00.000Z" }),
      session("inbox", { workspaceId: CHATS_WORKSPACE_ID }),
    ];
    const members = groupMemberSessionIds([GROUP]);
    expect(eligibleGroupSessions(sessions, "ws-1", members).map((s) => s.id)).toEqual(["ok"]);
    expect(eligibleGroupSessions(sessions, null, members).map((s) => s.id)).toEqual(["inbox"]);
  });

  it("keeps the activity selector stubbed off until the runtime lands", () => {
    expect(isGroupWorkingStub(GROUP)).toBe(false);
  });
});

describe("manageableGroupSessions", () => {
  it("offers the eligible chats plus the group's own members, never other groups' members", () => {
    const sessions = [
      session("mine"),
      session("free"),
      session("theirs"),
      session("inbox", { workspaceId: CHATS_WORKSPACE_ID }),
    ];
    const group: AgentGroupWithMembers = {
      id: "g",
      name: "G",
      workspaceId: "ws-1",
      mode: "free",
      members: [{ groupId: "g", sessionId: "mine", joinedAt: "2026-01-01T00:00:00.000Z" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      manageableGroupSessions(sessions, group, new Set(["mine", "theirs"])).map((s) => s.id),
    ).toEqual(["mine", "free"]);
  });
});

describe("Remove project group warning", () => {
  it("counts a Project's groups and words the warning for 1 and many", () => {
    const g = (id: string, workspaceId?: string): AgentGroupWithMembers => ({
      id,
      name: id,
      ...(workspaceId ? { workspaceId } : {}),
      mode: "free",
      members: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const groups = [g("a", "ws-1"), g("b", "ws-1"), g("c", "ws-2"), g("d")];
    expect(countProjectGroups(groups, "ws-1")).toBe(2);
    expect(countProjectGroups(groups, "ws-3")).toBe(0);
    expect(removeProjectGroupsWarning(1)).toBe("1 group and its member chats will be deleted");
    expect(removeProjectGroupsWarning(2)).toBe("2 groups and their member chats will be deleted");
  });
});
