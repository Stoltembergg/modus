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
import { GROUP_DELETE_CONFIRM_LABEL, SidebarGroups } from "./SidebarGroups";

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
    const confirm = within(menu).getByRole("menuitem", { name: GROUP_DELETE_CONFIRM_LABEL });
    expect(confirm.textContent).toBe("Member sessions return to the sidebar");
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

  it("Manage members edits the group through one atomic update", async () => {
    const user = userEvent.setup();
    const handlers = groupHandlers();
    const sessions = [
      ...SESSIONS,
      session("free-chat"),
      session("other-ws", { workspaceId: "ws-2" }),
    ];
    render(
      <SidebarGroups
        activityBySession={{}}
        groups={GROUPS}
        sessions={sessions}
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
    // Current members (preselected) plus eligible chats of the same Project.
    const boxes = within(dialog).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => [box.closest("label")?.textContent, box.checked])).toEqual([
      ["Chat member-a", true],
      ["Chat member-b", true],
      ["Chat project-chat", false],
      ["Chat free-chat", false],
    ]);
    expect((within(dialog).getByRole("combobox") as HTMLSelectElement).value).toBe("member-a");

    await user.click(within(dialog).getByRole("checkbox", { name: "Chat member-a" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Chat free-chat" }));
    await user.selectOptions(within(dialog).getByRole("combobox"), "free-chat");
    await user.click(within(dialog).getByRole("button", { name: "Save members" }));

    expect(handlers.onUpdateMembers).toHaveBeenCalledTimes(1);
    expect(handlers.onUpdateMembers).toHaveBeenCalledWith("g-project", {
      members: [{ sessionId: "member-b" }, { sessionId: "free-chat" }],
      leadSessionId: "free-chat",
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

  it("keeps pins: a pinned member shows only under its group, and in Pinned again once it leaves", () => {
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
    const inPinned = (title: string) =>
      within(screen.getByTestId("sidebar-pinned")).queryByText(title) !== null;
    const inGroups = (title: string) =>
      within(screen.getByTestId("sidebar-groups")).queryByText(title) !== null;
    const [squad, crew] = GROUPS as [AgentGroupWithMembers, AgentGroupWithMembers];

    // Member (pinned): only under the group.
    const { rerender } = render(<Sidebar {...props} groups={GROUPS} />);
    expect(inGroups("Chat inbox-member")).toBe(true);
    expect(inPinned("Chat inbox-member")).toBe(false);
    expect(screen.getAllByText("Chat inbox-member")).toHaveLength(1);
    expect(inPinned("Chat pinned-inbox")).toBe(true);

    // Removed from the group (group kept, now empty): back in Pinned.
    rerender(<Sidebar {...props} groups={[squad, { ...crew, members: [] }]} />);
    expect(inGroups("Chat inbox-member")).toBe(false);
    expect(inPinned("Chat inbox-member")).toBe(true);
    expect(screen.getAllByText("Chat inbox-member")).toHaveLength(1);

    // Rejoins, then the group is deleted: back in Pinned again.
    rerender(<Sidebar {...props} groups={GROUPS} />);
    expect(inPinned("Chat inbox-member")).toBe(false);
    rerender(<Sidebar {...props} groups={[squad]} />);
    expect(inPinned("Chat inbox-member")).toBe(true);
    expect(screen.getAllByText("Chat inbox-member")).toHaveLength(1);
    // The pin itself was never touched.
    expect(SESSIONS.find((s) => s.id === "inbox-member")?.pinnedAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
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
        name: "1 group and its member chats will be deleted",
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
          name: "2 groups and their member chats will be deleted",
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
      members: sessions.map((s) => member("g-dup", s.id)),
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
