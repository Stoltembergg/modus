import { describe, expect, it } from "vitest";
import type { AgentGroupWithMembers, AgentSessionInfo } from "../../../../shared/contracts";
import {
  groupDeleteConfirmLabel,
  isGroupWorkingStub,
  isListedChat,
  projectGroupNames,
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

function group(id: string, workspaceId?: string): AgentGroupWithMembers {
  return {
    id,
    name: `Group ${id}`,
    ...(workspaceId ? { workspaceId } : {}),
    mode: "free",
    members: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("groupSidebarModel", () => {
  it("hides room sessions by kind, not by membership", () => {
    expect(isListedChat(session("chat"))).toBe(true);
    expect(isListedChat(session("room", { kind: "group_member" }))).toBe(false);
  });

  it("keeps the activity selector stubbed off by default", () => {
    expect(isGroupWorkingStub(group("a"))).toBe(false);
  });
});

describe("delete confirmations", () => {
  it("Remove project lists the groups it deletes", () => {
    const groups = [group("a", "ws-1"), group("b", "ws-1"), group("c", "ws-2"), group("d")];
    expect(projectGroupNames(groups, "ws-1")).toEqual(["Group a", "Group b"]);
    expect(projectGroupNames(groups, "ws-3")).toEqual([]);
    expect(removeProjectGroupsWarning(["Group a"])).toBe(
      "This also deletes 1 group with their agents, chats and messages: Group a",
    );
    expect(removeProjectGroupsWarning(["Group a", "Group b"])).toBe(
      "This also deletes 2 groups with their agents, chats and messages: Group a, Group b",
    );
  });

  it("Delete group says its agents and chats go with it", () => {
    expect(groupDeleteConfirmLabel(3)).toBe(
      "This deletes its 3 agents, their chats and all group messages",
    );
    expect(groupDeleteConfirmLabel(1)).toBe(
      "This deletes its 1 agent, their chats and all group messages",
    );
  });
});
