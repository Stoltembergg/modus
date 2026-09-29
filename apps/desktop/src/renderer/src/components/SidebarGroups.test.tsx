// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentGroupWithMembers,
  AgentSessionInfo,
  WorkspaceInfo,
} from "../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";
import { Sidebar } from "./Sidebar";
import { SidebarGroups } from "./SidebarGroups";

function session(id: string, overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
  return {
    id,
    workspaceId: "ws-1",
    title: `Chat ${id}`,
    cwd: "/repo",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
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

const SESSIONS = [
  session("member-a"),
  session("member-b"),
  session("project-chat"),
  session("pinned-inbox", {
    workspaceId: CHATS_WORKSPACE_ID,
    pinnedAt: "2026-01-02T00:00:00.000Z",
  }),
  session("inbox-member", {
    workspaceId: CHATS_WORKSPACE_ID,
    pinnedAt: "2026-01-02T00:00:00.000Z",
  }),
  session("inbox-chat", { workspaceId: CHATS_WORKSPACE_ID }),
];

function member(groupId: string, sessionId: string) {
  return { groupId, sessionId, joinedAt: "2026-01-01T00:00:00.000Z" };
}

const GROUPS: AgentGroupWithMembers[] = [
  {
    id: "g-project",
    name: "Release squad",
    workspaceId: "ws-1",
    mode: "free",
    leadSessionId: "member-a",
    members: [member("g-project", "member-a"), member("g-project", "member-b")],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "g-inbox",
    name: "Inbox crew",
    mode: "free",
    members: [member("g-inbox", "inbox-member")],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function groupHandlers() {
  return {
    onCreateGroup: vi.fn(async () => undefined),
    onRenameGroup: vi.fn(),
    onDeleteGroup: vi.fn(),
    onRemoveMember: vi.fn(),
    onSetLead: vi.fn(),
    onSelectSession: vi.fn(),
  };
}

afterEach(() => cleanup());

describe("SidebarGroups", () => {
  it("shows each group's name and member count, with no activity dot by default", () => {
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    const rows = screen.getAllByTestId("group-row");
    expect(
      rows.map((row) => within(row).getByRole("button", { expanded: true }).textContent),
    ).toEqual(["Release squad2 members", "Inbox crew1 member"]);
    expect(screen.queryByTestId("group-activity-dot")).toBeNull();
  });

  it("lights the activity dot only through the injected selector", () => {
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        isGroupWorking={(group) => group.id === "g-inbox"}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    const dots = screen.getAllByTestId("group-activity-dot");
    expect(dots).toHaveLength(1);
    expect(dots[0]?.closest("[data-group-id]")?.getAttribute("data-group-id")).toBe("g-inbox");
  });

  it("lists members under their group, marks the lead, and wires member actions", async () => {
    const user = userEvent.setup();
    const handlers = groupHandlers();
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...handlers}
      />,
    );
    const squad = screen.getAllByTestId("group-row")[0]?.parentElement as HTMLElement;
    const members = within(squad).getAllByTestId("group-member-row");
    expect(members.map((row) => row.textContent)).toEqual(["Chat member-aLead", "Chat member-b"]);

    await user.click(
      within(members[0] as HTMLElement).getByRole("button", { name: /Chat member-a/ }),
    );
    expect(handlers.onSelectSession).toHaveBeenCalledWith(SESSIONS[0]);
    await user.click(
      within(members[0] as HTMLElement).getByRole("button", { name: "Remove as lead" }),
    );
    expect(handlers.onSetLead).toHaveBeenCalledWith("g-project", null);
    await user.click(within(members[1] as HTMLElement).getByRole("button", { name: "Make lead" }));
    expect(handlers.onSetLead).toHaveBeenCalledWith("g-project", "member-b");
    await user.click(
      within(members[1] as HTMLElement).getByRole("button", { name: "Remove from group" }),
    );
    expect(handlers.onRemoveMember).toHaveBeenCalledWith("g-project", "member-b");

    // Collapsing hides the members.
    await user.click(within(squad).getByRole("button", { expanded: true }));
    expect(within(squad).queryAllByTestId("group-member-row")).toHaveLength(0);
  });
});

describe("Sidebar with groups", () => {
  function renderSidebar() {
    const noop = vi.fn();
    render(
      <Sidebar
        activityBySession={{}}
        agentSessions={SESSIONS}
        canCreateSession
        groups={GROUPS}
        maxWidth={480}
        onArchiveProjectChats={noop}
        onArchiveSession={noop}
        onCreateGroup={vi.fn(async () => undefined)}
        onDeleteProjectChats={noop}
        onDeleteSession={noop}
        onListArchivedSessions={vi.fn(async () => [])}
        onNewSession={noop}
        onNewWorkspaceSession={noop}
        onOpenLimits={noop}
        onOpenSettings={noop}
        onOpenWorkspace={noop}
        onPinProject={noop}
        onPinSession={noop}
        onRemoveProject={noop}
        onRenameProject={noop}
        onRestoreSession={noop}
        onRevealProject={noop}
        onSelectSession={noop}
        onWidthChange={noop}
        open
        width={280}
        workspaces={WORKSPACES}
      />,
    );
  }

  it("orders sections New chat, Pinned, Groups, Projects, Chats", () => {
    renderSidebar();
    const text = document.body.textContent ?? "";
    const order = ["New chat", "Pinned", "Groups", "Projects", "Chats"].map((label) =>
      text.indexOf(label),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("shows member chats only under their group", () => {
    renderSidebar();
    const groups = screen.getByTestId("sidebar-groups");
    for (const title of ["Chat member-a", "Chat member-b", "Chat inbox-member"]) {
      expect(screen.getAllByText(title)).toHaveLength(1);
      expect(within(groups).getByText(title)).toBeTruthy();
    }
    // Non-members stay where they were.
    expect(within(groups).queryByText("Chat pinned-inbox")).toBeNull();
    expect(screen.getAllByText("Chat pinned-inbox")).toHaveLength(1);
    expect(within(groups).queryByText("Chat inbox-chat")).toBeNull();
    expect(screen.getAllByText("Chat inbox-chat")).toHaveLength(1);
  });

  it("puts a deleted group's chats back in the other sections", () => {
    const noop = vi.fn();
    const props = {
      activityBySession: {},
      agentSessions: SESSIONS,
      canCreateSession: true,
      maxWidth: 480,
      onArchiveProjectChats: noop,
      onArchiveSession: noop,
      onCreateGroup: vi.fn(async () => undefined),
      onDeleteProjectChats: noop,
      onDeleteSession: noop,
      onListArchivedSessions: vi.fn(async () => []),
      onNewSession: noop,
      onNewWorkspaceSession: noop,
      onOpenLimits: noop,
      onOpenSettings: noop,
      onOpenWorkspace: noop,
      onPinProject: noop,
      onPinSession: noop,
      onRemoveProject: noop,
      onRenameProject: noop,
      onRestoreSession: noop,
      onRevealProject: noop,
      onSelectSession: noop,
      onWidthChange: noop,
      open: true,
      width: 280,
      workspaces: WORKSPACES,
    };
    const { rerender } = render(<Sidebar {...props} groups={GROUPS} />);
    expect(
      within(screen.getByTestId("sidebar-groups")).getByText("Chat inbox-member"),
    ).toBeTruthy();
    rerender(<Sidebar {...props} groups={[GROUPS[0] as AgentGroupWithMembers]} />);
    expect(
      within(screen.getByTestId("sidebar-groups")).queryByText("Chat inbox-member"),
    ).toBeNull();
    expect(screen.getAllByText("Chat inbox-member")).toHaveLength(1);
  });
});
