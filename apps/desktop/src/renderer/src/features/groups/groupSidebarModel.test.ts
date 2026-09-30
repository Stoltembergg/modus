import { describe, expect, it } from "vitest";
import { agentAvatarForId } from "../../../../shared/agent-templates";
import type { AgentGroupWithMembers, AgentSessionInfo } from "../../../../shared/contracts";
import { groupBlockedReason } from "../../../../shared/group-blocked";
import {
  agentChatBlocked,
  agentChatSessions,
  groupAgentRows,
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

  it("hides an agent's 1:1 chat from the chat lists (it is listed under its agent)", () => {
    expect(isListedChat(session("dm", { agentId: "a-1" }))).toBe(false);
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
      "This also deletes 1 group, its agents and chats: Group a",
    );
    expect(removeProjectGroupsWarning(["Group a", "Group b"])).toBe(
      "This also deletes 2 groups, their agents and chats: Group a, Group b",
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

describe("group agent rows (A3)", () => {
  const member = (agentId: string, name: string, extra: object = {}) => ({
    groupId: "g",
    sessionId: `room-${agentId}`,
    agentId,
    name,
    agentRole: "",
    joinedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
  const squad: AgentGroupWithMembers = {
    ...group("g", "ws-1"),
    leadSessionId: "room-a",
    members: [
      member("a", "Ana", { agentRole: "Reviewer", avatarFace: "wink", avatarColor: "teal" }),
      member("b", "Bo", { role: "Builder" }),
      member("c", "Cy", { archived: true, avatarFace: "calm", avatarColor: "pink" }),
    ],
  };
  const states = new Map([
    [
      "g",
      {
        groupId: "g",
        runningSessionIds: ["room-b", "room-c"],
        queuedSessionIds: [],
        waitingSessionIds: [],
      },
    ],
  ]);

  it("lists avatar, name, role, lead, room state and the 1:1 chat", () => {
    const chats = agentChatSessions([
      session("dm-a", { agentId: "a" }),
      session("room-a", { kind: "group_member", agentId: "a" }),
      session("other"),
    ]);
    expect([...chats.keys()]).toEqual(["a"]);
    const rows = groupAgentRows(squad, chats, states);
    expect(
      rows.map(({ name, role, isLead, state, chatSessionId }) => ({
        name,
        role,
        isLead,
        state,
        chatSessionId,
      })),
    ).toEqual([
      { name: "Ana", role: "Reviewer", isLead: true, state: "idle", chatSessionId: "dm-a" },
      { name: "Bo", role: "Builder", isLead: false, state: "working", chatSessionId: undefined },
      { name: "Cy", role: undefined, isLead: false, state: "archived", chatSessionId: undefined },
    ]);
    expect(rows[0]).toMatchObject({ face: "wink", color: "teal" });
    const derived = agentAvatarForId("b");
    expect(rows[1]).toMatchObject({ face: derived.avatarFace, color: derived.avatarColor });
  });

  it("the 1:1 chat's activity lights an idle agent (asking = waiting, running = working)", () => {
    const chats = agentChatSessions([session("dm-a", { agentId: "a" })]);
    const running = { running: true, needsInput: false, unread: false, failed: false };
    expect(groupAgentRows(squad, chats, undefined, { "dm-a": running })[0]?.state).toBe("working");
    expect(
      groupAgentRows(squad, chats, undefined, { "dm-a": { ...running, needsInput: true } })[0]
        ?.state,
    ).toBe("waiting");
  });

  it("a blocked group still lists its agents", () => {
    const { workspaceId: _workspaceId, ...noProject } = squad;
    const blocked: AgentGroupWithMembers = { ...noProject, members: squad.members.slice(0, 1) };
    expect(groupBlockedReason(blocked, blocked.members)).not.toBeNull();
    expect(groupAgentRows(blocked, new Map(), undefined).map((row) => row.name)).toEqual(["Ana"]);
  });
});

describe("agentChatBlocked (A3: a blocked group's 1:1 chat is read-only)", () => {
  const member = (groupId: string, agentId: string) => ({
    groupId,
    sessionId: `room-${agentId}`,
    agentId,
    name: agentId,
    agentRole: "",
    joinedAt: "2026-01-01T00:00:00.000Z",
  });
  const working: AgentGroupWithMembers = {
    ...group("w", "ws-1"),
    members: [member("w", "a"), member("w", "b")],
  };
  const noProject: AgentGroupWithMembers = {
    ...group("n"),
    members: [member("n", "c"), member("n", "d")],
  };
  const tooSmall: AgentGroupWithMembers = { ...group("s", "ws-1"), members: [member("s", "e")] };
  const groups = [working, noProject, tooSmall];

  it("blocks the chat of an agent whose group has no Project, with the room's reason", () => {
    const blocked = agentChatBlocked(session("dm-c", { agentId: "c" }), groups);
    expect(blocked?.group.id).toBe("n");
    expect(blocked?.reason).toBe("project-required");
    expect(blocked?.reason).toBe(groupBlockedReason(noProject, noProject.members));
  });

  it("blocks any groupBlockedReason (too few members too)", () => {
    expect(agentChatBlocked(session("dm-e", { agentId: "e" }), groups)?.reason).toBe("min-members");
  });

  it("leaves a working group's chat, a plain chat and room sessions writable", () => {
    expect(agentChatBlocked(session("dm-a", { agentId: "a" }), groups)).toBeNull();
    expect(agentChatBlocked(session("plain"), groups)).toBeNull();
    expect(
      agentChatBlocked(session("room-c", { agentId: "c", kind: "group_member" }), groups),
    ).toBeNull();
    expect(agentChatBlocked(undefined, groups)).toBeNull();
  });
});
