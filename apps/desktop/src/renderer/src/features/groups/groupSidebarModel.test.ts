import { describe, expect, it } from "vitest";
import type { AgentGroupWithMembers, AgentSessionInfo } from "../../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../../shared/contracts";
import {
  eligibleGroupSessions,
  groupMemberSessionIds,
  isGroupWorkingStub,
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
