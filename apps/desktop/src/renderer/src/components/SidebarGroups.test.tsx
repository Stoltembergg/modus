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
import { groupDeleteConfirmLabel } from "../features/groups/groupSidebarModel";
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
  session("member-a", { kind: "group_member" }),
  session("member-b", { kind: "group_member" }),
  session("project-chat"),
  session("pinned-inbox", {
    workspaceId: CHATS_WORKSPACE_ID,
    pinnedAt: "2026-01-02T00:00:00.000Z",
  }),
  session("inbox-member", {
    workspaceId: CHATS_WORKSPACE_ID,
    pinnedAt: "2026-01-02T00:00:00.000Z",
    kind: "group_member",
  }),
  session("inbox-chat", { workspaceId: CHATS_WORKSPACE_ID }),
];

/** A member: its agent's name (here the session title) comes with the group. */
function member(groupId: string, sessionId: string, name = `Chat ${sessionId}`) {
  return {
    groupId,
    sessionId,
    agentId: `agent-${sessionId}`,
    name,
    agentRole: "",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
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
    onUpdateMembers: vi.fn(async (_groupId: string, _change: unknown) => undefined),
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

  it("offers Rename, Manage members and Delete from the row's context menu", async () => {
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
    const row = screen.getAllByTestId("group-row")[0] as HTMLElement;
    await user.pointer({ keys: "[MouseRight]", target: row });
    const menu = await screen.findByTestId("group-context-menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Rename", "Manage members", "Delete"]);

    // Delete is two-step; the confirm label is exact and the menu stays open.
    await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(handlers.onDeleteGroup).not.toHaveBeenCalled();
    const confirm = within(menu).getByRole("menuitem", { name: groupDeleteConfirmLabel(2) });
    expect(confirm.textContent).toBe(
      "This deletes its 2 agents, their chats and all group messages",
    );
    await user.click(confirm);
    expect(handlers.onDeleteGroup).toHaveBeenCalledWith("g-project");

    // Rename from the context menu opens the inline editor.
    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getAllByTestId("group-row")[0] as HTMLElement,
    });
    await user.click(
      within(await screen.findByTestId("group-context-menu")).getByRole("menuitem", {
        name: "Rename",
      }),
    );
    expect(screen.getByRole("textbox", { name: "Group name" })).toBeTruthy();
  });

  it("the … menu carries the same three actions", async () => {
    const user = userEvent.setup();
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: "Group actions" })[0] as HTMLElement);
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
      "Rename",
      "Manage members",
      "Delete",
    ]);
  });

  it("Manage members adds new agents, removes members (never below 2) and sets the lead", async () => {
    const user = userEvent.setup();
    const handlers = groupHandlers();
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        models={[{ id: "m-1", name: "Model 1" }]}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...handlers}
      />,
    );
    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getAllByTestId("group-row")[0] as HTMLElement,
    });
    await user.click(
      within(await screen.findByTestId("group-context-menu")).getByRole("menuitem", {
        name: "Manage members",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Manage members")).toBeTruthy();
    // Two members left: removing one is disabled until another agent is added.
    const removeA = within(dialog).getByRole("button", { name: "Remove Chat member-a" });
    expect((removeA as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Add agent" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 1 name" }), "Cy");
    expect((removeA as HTMLButtonElement).disabled).toBe(false);
    await user.click(removeA);
    await user.selectOptions(within(dialog).getByRole("combobox", { name: /Lead/ }), "member-b");
    await user.click(within(dialog).getByRole("button", { name: "Save members" }));

    expect(handlers.onUpdateMembers).toHaveBeenCalledTimes(1);
    expect(handlers.onUpdateMembers).toHaveBeenCalledWith("g-project", {
      add: [{ name: "Cy", modelId: "m-1" }],
      removeAgentIds: ["agent-member-a"],
      lead: { agentId: "agent-member-b" },
    });
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

  it("an agent's 1:1 chat is not listed under its Project (only under its agent)", () => {
    const noop = vi.fn();
    render(
      <Sidebar
        activityBySession={{}}
        agentSessions={[
          ...SESSIONS,
          session("dm-a", { title: "Direct with Ana", agentId: "agent-member-a" }),
        ]}
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
    expect(screen.getByText("Chat project-chat")).toBeTruthy();
    expect(screen.queryByText("Direct with Ana")).toBeNull();
  });

  it("room sessions (kind group_member) never show outside the Groups section, even pinned", () => {
    renderSidebar();
    const pinned = screen.getByTestId("sidebar-pinned");
    expect(within(pinned).queryByText("Chat inbox-member")).toBeNull();
    expect(within(pinned).getByText("Chat pinned-inbox")).toBeTruthy();
    expect(screen.getAllByText("Chat inbox-member")).toHaveLength(1);
  });

  describe("Remove project with groups", () => {
    const WS2: WorkspaceInfo = {
      ...(WORKSPACES[0] as WorkspaceInfo),
      id: "ws-2",
      rootPath: "/other",
      displayName: "Other",
    };
    const [squad] = GROUPS as [AgentGroupWithMembers];
    const second: AgentGroupWithMembers = {
      ...squad,
      id: "g-project-2",
      name: "Second",
      members: [],
    };

    function renderWith(groups: AgentGroupWithMembers[]) {
      const noop = vi.fn();
      const onRemoveProject = vi.fn();
      render(
        <Sidebar
          activityBySession={{}}
          agentSessions={SESSIONS}
          canCreateSession
          groups={groups}
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
          onRemoveProject={onRemoveProject}
          onRenameProject={noop}
          onRestoreSession={noop}
          onRevealProject={noop}
          onSelectSession={noop}
          onWidthChange={noop}
          open
          width={280}
          workspaces={[...WORKSPACES, WS2]}
        />,
      );
      return onRemoveProject;
    }

    async function openProjectMenu(user: ReturnType<typeof userEvent.setup>, index: number) {
      await user.click(
        screen.getAllByRole("button", { name: "Project actions" })[index] as HTMLElement,
      );
      return screen.findByRole("menu");
    }

    it("warns with the singular for one group, then removes on the second click", async () => {
      const user = userEvent.setup();
      const onRemoveProject = renderWith(GROUPS);
      const menu = await openProjectMenu(user, 0);
      await user.click(within(menu).getByRole("menuitem", { name: "Remove" }));
      expect(onRemoveProject).not.toHaveBeenCalled();
      const confirm = within(menu).getByRole("menuitem", {
        name: "This also deletes 1 group, its agents and chats: Release squad",
      });
      await user.click(confirm);
      expect(onRemoveProject).toHaveBeenCalledWith("ws-1");
    });

    it("warns with the plural and the right count for several groups", async () => {
      const user = userEvent.setup();
      const onRemoveProject = renderWith([...GROUPS, second]);
      const menu = await openProjectMenu(user, 0);
      await user.click(within(menu).getByRole("menuitem", { name: "Remove" }));
      expect(
        within(menu).getByRole("menuitem", {
          name: "This also deletes 2 groups, their agents and chats: Release squad, Second",
        }),
      ).toBeTruthy();
      expect(onRemoveProject).not.toHaveBeenCalled();
    });

    it("removes right away with the unchanged label when the Project has no groups", async () => {
      const user = userEvent.setup();
      const onRemoveProject = renderWith(GROUPS);
      const menu = await openProjectMenu(user, 1);
      await user.click(within(menu).getByRole("menuitem", { name: "Remove" }));
      expect(onRemoveProject).toHaveBeenCalledWith("ws-2");
      expect(screen.queryByText(/member chats will be deleted/)).toBeNull();
    });
  });
});

describe("SidebarGroups room selection and states", () => {
  it("clicking a group opens its room and selects the row; the rail toggles members", async () => {
    const user = userEvent.setup();
    const onSelectGroup = vi.fn();
    const view = render(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        onSelectGroup={onSelectGroup}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    const row = screen.getAllByTestId("group-row")[0] as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /Release squad/ }));
    expect(onSelectGroup).toHaveBeenCalledWith(GROUPS[0]);
    // Members stay listed; the rail button hides them.
    const squad = row.parentElement as HTMLElement;
    expect(within(squad).getAllByTestId("group-member-row")).toHaveLength(2);
    await user.click(within(row).getByRole("button", { name: "Hide members" }));
    expect(within(squad).queryAllByTestId("group-member-row")).toHaveLength(0);

    view.rerender(
      <SidebarGroups
        activeGroupId="g-project"
        activityBySession={{}}
        groups={GROUPS}
        onSelectGroup={onSelectGroup}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    const rows = screen.getAllByTestId("group-row");
    expect(rows.map((item) => item.className.includes("row-selected"))).toEqual([true, false]);
    expect(
      within(rows[0] as HTMLElement)
        .getByRole("button", { name: /Release squad/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("the amber waiting dot takes priority over the working dot", () => {
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        isGroupWaiting={(group) => group.id === "g-project"}
        isGroupWorking={() => true}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    const [squad, inbox] = screen.getAllByTestId("group-row") as HTMLElement[];
    expect(within(squad as HTMLElement).getByTestId("group-waiting-dot").className).toContain(
      "bg-amber-400",
    );
    expect(within(squad as HTMLElement).queryByTestId("group-activity-dot")).toBeNull();
    expect(within(inbox as HTMLElement).getByTestId("group-activity-dot")).toBeTruthy();
    expect(within(inbox as HTMLElement).queryByTestId("group-waiting-dot")).toBeNull();
  });
});

describe("SidebarGroups duplicate member titles", () => {
  it("labels repeated titles with a muted short id; unique titles stay plain", () => {
    const sessions = [
      session("3f2a91c0", { title: "Reviewer" }),
      session("8b01d2e3", { title: "Reviewer" }),
      session("c0ffee00", { title: "Planner" }),
    ];
    const group: AgentGroupWithMembers = {
      id: "g-dup",
      name: "Dup squad",
      workspaceId: "ws-1",
      mode: "free",
      members: sessions.map((s) => member("g-dup", s.id, s.title)),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={[group]}
        sessions={sessions}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    expect(screen.getAllByTestId("group-member-row").map((row) => row.textContent)).toEqual([
      "Reviewer · 3f2a",
      "Reviewer · 8b01",
      "Planner",
    ]);
  });
});

describe("SidebarGroups agents (A3)", () => {
  const DM = session("dm-a", { title: "Chat member-a", agentId: "agent-member-a" });

  it("each agent row shows a 16 px avatar, name and role; clicking opens its 1:1 chat", async () => {
    const user = userEvent.setup();
    const onOpenAgentChat = vi.fn();
    const onSelectGroup = vi.fn();
    const groups: AgentGroupWithMembers[] = [
      {
        ...(GROUPS[0] as AgentGroupWithMembers),
        members: [
          {
            ...member("g-project", "member-a"),
            agentRole: "Reviewer",
            avatarFace: "wink",
            avatarColor: "teal",
          },
          member("g-project", "member-b"),
        ],
      },
    ];
    render(
      <SidebarGroups
        activeSessionId="dm-a"
        activityBySession={{}}
        groups={groups}
        memberStates={
          new Map([
            [
              "g-project",
              {
                groupId: "g-project",
                runningSessionIds: ["member-b"],
                queuedSessionIds: [],
                waitingSessionIds: [],
              },
            ],
          ])
        }
        onOpenAgentChat={onOpenAgentChat}
        onSelectGroup={onSelectGroup}
        sessions={[...SESSIONS, DM]}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    const rows = screen.getAllByTestId("group-member-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Chat member-aLeadReviewer",
      "Chat member-b",
    ]);
    const avatars = rows.map((row) => within(row).getByTestId("agent-avatar"));
    expect(avatars.map((avatar) => avatar.dataset.size)).toEqual(["16", "16"]);
    expect(avatars[0]?.dataset.face).toBe("wink");
    expect(avatars.map((avatar) => avatar.dataset.state)).toEqual(["idle", "working"]);
    // The open 1:1 chat selects its agent's row.
    expect(rows.map((row) => row.className.includes("row-selected"))).toEqual([true, false]);

    await user.click(within(rows[1] as HTMLElement).getByRole("button", { name: /Chat member-b/ }));
    expect(onOpenAgentChat).toHaveBeenCalledWith("agent-member-b");
    expect(onSelectGroup).not.toHaveBeenCalled();
  });

  it("Edit agent on a row and Add agent in the group menu open the agent dialog", async () => {
    const user = userEvent.setup();
    const onEditAgent = vi.fn();
    const onAddAgent = vi.fn();
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        onAddAgent={onAddAgent}
        onEditAgent={onEditAgent}
        onOpenAgentChat={vi.fn()}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    const row = screen.getAllByTestId("group-member-row")[1] as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Edit agent" }));
    expect(onEditAgent).toHaveBeenCalledWith("agent-member-b");

    const groupRow = screen.getAllByTestId("group-row")[0] as HTMLElement;
    await user.click(within(groupRow).getByRole("button", { name: "Group actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add agent" }));
    expect(onAddAgent).toHaveBeenCalledWith("g-project");
  });

  it("a blocked group (no Project, one agent) still lists its agents, clickable", async () => {
    const user = userEvent.setup();
    const onOpenAgentChat = vi.fn();
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={[GROUPS[1] as AgentGroupWithMembers]}
        onOpenAgentChat={onOpenAgentChat}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    const rows = screen.getAllByTestId("group-member-row");
    expect(rows).toHaveLength(1);
    await user.click(
      within(rows[0] as HTMLElement).getByRole("button", { name: /Chat inbox-member/ }),
    );
    expect(onOpenAgentChat).toHaveBeenCalledWith("agent-inbox-member");
  });
});
