// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGroupWithMembers, AgentSessionInfo, WorkspaceInfo } from "../../../../shared/contracts";
import { SidebarGroups } from "./SidebarGroups";

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

function member(groupId: string, sessionId: string) {
  return {
    groupId,
    sessionId,
    agentId: `agent-${sessionId}`,
    name: `Chat ${sessionId}`,
    agentRole: "",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

const WORKSPACES: WorkspaceInfo[] = [
  {
    id: "ws-1",
    rootPath: "/repo",
    displayName: "Repo",
    isGitRepository: true,
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    pinned: false,
  },
];

const GROUP: AgentGroupWithMembers = {
  id: "g-project",
  name: "Squad",
  workspaceId: "ws-1",
  mode: "free",
  leadSessionId: "member-a",
  members: [member("g-project", "member-a"), member("g-project", "member-b")],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => cleanup());

describe("SidebarGroups waiting member opens group", () => {
  it("a waiting room member opens the group instead of a private chat", async () => {
    const user = userEvent.setup();
    const onOpenAgentChat = vi.fn();
    const onSelectGroup = vi.fn();
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={[GROUP]}
        memberStates={
          new Map([
            [
              "g-project",
              {
                groupId: "g-project",
                runningSessionIds: [],
                queuedSessionIds: [],
                waitingSessionIds: ["member-a"],
              },
            ],
          ])
        }
        onCreateGroup={vi.fn(async () => undefined)}
        onDeleteGroup={vi.fn()}
        onOpenAgentChat={onOpenAgentChat}
        onRemoveMember={vi.fn()}
        onRenameGroup={vi.fn()}
        onSelectGroup={onSelectGroup}
        onSelectSession={vi.fn()}
        onSetLead={vi.fn()}
        onUpdateMembers={vi.fn(async () => undefined)}
        sessions={[session("member-a"), session("member-b")]}
        workspaces={WORKSPACES}
      />,
    );
    const row = screen.getAllByTestId("group-member-row")[0] as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /Chat member-a/ }));
    expect(onSelectGroup).toHaveBeenCalledWith(GROUP);
    expect(onOpenAgentChat).not.toHaveBeenCalled();
  });
});
