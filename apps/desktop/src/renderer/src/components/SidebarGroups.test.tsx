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
  it("gives groups distinct, stable visual identities in the sidebar", () => {
    const { rerender } = render(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );

    const iconIdentities = () =>
      screen.getAllByTestId("group-row").map((row) => {
        const icon = within(row).getByTestId("group-identity-icon");
        return icon.getAttribute("data-group-icon-identity");
      });
    const firstIdentities = iconIdentities();

    expect(firstIdentities).toHaveLength(GROUPS.length);
    expect(new Set(firstIdentities).size).toBe(GROUPS.length);

    rerender(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );

    expect(iconIdentities()).toEqual(firstIdentities);
  });

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
    expect(rows.map((row) => within(row).getByTestId("group-member-count").textContent)).toEqual([
      "2 members",
      "1 member",
    ]);
    expect(
      rows.map((row) => within(row).getByText(/Release squad|Inbox crew/).textContent),
    ).toEqual(["Release squad", "Inbox crew"]);
    expect(screen.queryByTestId("group-activity-dot")).toBeNull();
    expect(screen.queryAllByTestId("group-member-row")).toHaveLength(0);
  });

  it("New group opens the A4 modal with the app services (Copy lists the other groups' agents)", async () => {
    const user = userEvent.setup();
    const listAgents = vi.fn(async () => []);
    render(
      <SidebarGroups
        activityBySession={{}}
        defaultWorkspaceId="ws-1"
        groups={GROUPS}
        newGroupServices={{
          listAgents,
          addFolder: vi.fn(async () => null),
          generateProfile: vi.fn(),
        }}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    expect(screen.queryByTestId("new-group-modal")).toBeNull();
    await user.click(screen.getByRole("button", { name: "New group" }));
    const modal = screen.getByTestId("new-group-modal");
    expect(within(modal).getByRole("tab", { name: "Templates" })).toBeTruthy();
    expect(listAgents).toHaveBeenCalledTimes(1);
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

  it("does not nest permanent agent rows under groups (N5)", () => {
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    expect(screen.queryAllByTestId("group-member-row")).toHaveLength(0);
    expect(screen.getAllByTestId("group-member-count").map((el) => el.textContent)).toEqual([
      "2 members",
      "1 member",
    ]);
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
  function renderSidebar(section: "groups" | "direct-messages" = "groups") {
    const noop = vi.fn();
    render(
      <Sidebar
        activityBySession={{}}
        agentSessions={SESSIONS}
        canCreateSession
        groups={GROUPS}
        section={section}
        maxWidth={480}
        onArchiveProjectChats={noop}
        onArchiveSession={noop}
        onCreateGroup={vi.fn(async () => undefined)}
        onDeleteProjectChats={noop}
        onDeleteSession={noop}
        onListArchivedSessions={vi.fn(async () => [])}
        onNewSession={noop}
        onNewWorkspaceSession={noop}
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

  it("keeps the Groups context focused on persistent teams", () => {
    renderSidebar();
    expect(screen.getByTestId("sidebar-groups")).toBeTruthy();
    expect(screen.queryByText("Projects")).toBeNull();
    expect(screen.queryByText("Direct Messages")).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("shows a flat Direct Messages list and keeps project context collapsed", () => {
    renderSidebar("direct-messages");
    expect(screen.getByText("Direct Messages")).toBeTruthy();
    expect(screen.getByText("Chat project-chat")).toBeTruthy();
    expect(screen.getByText("Chat inbox-chat")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-groups")).toBeNull();
    expect(screen.queryByText("Projects")).toBeNull();
    expect(screen.queryByText("Repo")).toBeNull();
  });

  it("keeps group member room sessions out of the primary direct message list (N5)", () => {
    renderSidebar();
    const groups = screen.getByTestId("sidebar-groups");
    for (const title of ["Chat member-a", "Chat member-b", "Chat inbox-member"]) {
      expect(screen.queryByText(title)).toBeNull();
      expect(within(groups).queryByText(title)).toBeNull();
    }
    // Direct messages are scoped to their own rail destination.
    expect(within(groups).queryByText("Chat pinned-inbox")).toBeNull();
    expect(within(groups).queryByText("Chat inbox-chat")).toBeNull();
    expect(screen.queryByText("Chat pinned-inbox")).toBeNull();
    expect(screen.queryByText("Chat inbox-chat")).toBeNull();
  });

  it("keeps an agent's 1:1 chat in Direct Messages and outside Project context", async () => {
    const noop = vi.fn();
    const user = userEvent.setup();
    render(
      <Sidebar
        activityBySession={{}}
        agentSessions={[
          ...SESSIONS,
          session("dm-a", { title: "Direct with Ana", agentId: "agent-member-a" }),
        ]}
        canCreateSession
        groups={GROUPS}
        section="direct-messages"
        maxWidth={480}
        onArchiveProjectChats={noop}
        onArchiveSession={noop}
        onCreateGroup={vi.fn(async () => undefined)}
        onDeleteProjectChats={noop}
        onDeleteSession={noop}
        onListArchivedSessions={vi.fn(async () => [])}
        onNewSession={noop}
        onNewWorkspaceSession={noop}
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
    expect(screen.getByText("Direct with Ana")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Project context" }));
    const projectContext = screen.getByTestId("sidebar-project-context");
    expect(within(projectContext).getByText("Chat project-chat")).toBeTruthy();
    expect(within(projectContext).queryByText("Direct with Ana")).toBeNull();
  });

  it("room sessions (kind group_member) never show in the sidebar, even pinned", () => {
    renderSidebar("direct-messages");
    const pinned = screen.getByTestId("sidebar-pinned");
    expect(within(pinned).queryByText("Chat inbox-member")).toBeNull();
    expect(within(pinned).getByText("Chat pinned-inbox")).toBeTruthy();
    expect(screen.queryByText("Chat inbox-member")).toBeNull();
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
          section="direct-messages"
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
      await user.click(screen.getByRole("button", { name: "Project context" }));
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
    expect(
      within(row.parentElement as HTMLElement).queryAllByTestId("group-member-row"),
    ).toHaveLength(0);
    await user.click(within(row).getByRole("button", { name: "Open group" }));
    expect(onSelectGroup).toHaveBeenCalledTimes(2);

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
    expect(screen.queryAllByTestId("group-member-row")).toHaveLength(0);
    expect(screen.getByTestId("group-member-count").textContent).toContain("3");
  });
});

describe("SidebarGroups agents (N5)", () => {
  it("Add agent remains available from the group menu", async () => {
    const user = userEvent.setup();
    const onAddAgent = vi.fn();
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        onAddAgent={onAddAgent}
        onOpenAgentChat={vi.fn()}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    const groupRow = screen.getAllByTestId("group-row")[0] as HTMLElement;
    await user.click(within(groupRow).getByRole("button", { name: "Group actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add agent" }));
    expect(onAddAgent).toHaveBeenCalledWith("g-project");
  });

  it("a blocked group still shows as a selectable row without nested agents", async () => {
    const user = userEvent.setup();
    const onSelectGroup = vi.fn();
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={[GROUPS[1] as AgentGroupWithMembers]}
        onOpenAgentChat={vi.fn()}
        onSelectGroup={onSelectGroup}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
        {...groupHandlers()}
      />,
    );
    expect(screen.queryAllByTestId("group-member-row")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /Inbox squad|Open group/ }));
    expect(onSelectGroup).toHaveBeenCalled();
  });
});
