// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { domMax, LazyMotion } from "motion/react";
import { useState } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentInfo,
  AgentSessionInfo,
  MoveAgentSessionInput,
  WorkspaceInfo,
} from "../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";
import type { SessionActivity } from "../features/agent/agentEventHub";
import { Sidebar } from "./Sidebar";
import { AppSidebar } from "./shell/AppSidebar";

vi.mock("./ui/ModusBot", () => ({ ModusBot: () => <span aria-hidden="true" /> }));
// Happy DOM's WAAPI cancel rejects unlike Motion's browser expectations. Keep
// real Motion components and transitions, using their supported JS fallback.
const nativeAnimation = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  Reflect.deleteProperty(Element.prototype, "animate");
  return descriptor;
});
afterAll(() => {
  if (nativeAnimation) Object.defineProperty(Element.prototype, "animate", nativeAnimation);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const WORKSPACE: WorkspaceInfo = {
  id: "dayz",
  displayName: "Dayz",
  rootPath: "/dayz",
  isGitRepository: true,
  lastOpenedAt: "2026-10-14T00:00:00Z",
  pinned: false,
};
const SECOND_WORKSPACE: WorkspaceInfo = {
  ...WORKSPACE,
  id: "modus",
  displayName: "Destination",
  rootPath: "/modus",
};
const CHATS_WORKSPACE: WorkspaceInfo = {
  id: CHATS_WORKSPACE_ID,
  displayName: "Chats",
  rootPath: "/chats",
  isGitRepository: false,
  lastOpenedAt: "2026-10-14T00:00:00Z",
  pinned: false,
  inbox: true,
};
const AGENT: AgentInfo = {
  id: "atlas",
  name: "Atlas",
  role: "",
  instructions: "",
  avatarColor: "orange",
  avatarFace: "happy",
  avatarShape: "roundedSquare",
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
};
function session(id: string, extra: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
  return {
    id,
    title: id,
    workspaceId: WORKSPACE.id,
    cwd: WORKSPACE.rootPath,
    status: "idle",
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    ...extra,
  };
}

function Navigation({
  initialSessions,
  activeSessionId,
  activityBySession = {},
  pinned = true,
  onSelect = () => {},
  onMove = async () => {},
  onArchive = () => {},
  onRestore = () => {},
  onListArchived = async () => [],
  workspaces = [WORKSPACE, SECOND_WORKSPACE],
}: {
  initialSessions: AgentSessionInfo[];
  activeSessionId?: string;
  activityBySession?: Record<string, SessionActivity>;
  pinned?: boolean;
  onSelect?: (session: AgentSessionInfo) => void;
  onMove?: (input: MoveAgentSessionInput) => Promise<void>;
  onArchive?: (session: AgentSessionInfo) => void;
  onRestore?: (session: AgentSessionInfo) => void;
  onListArchived?: (workspaceId: string) => Promise<AgentSessionInfo[]>;
  workspaces?: WorkspaceInfo[];
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [chatsExpanded, setChatsExpanded] = useState(true);
  const [pinnedContainer, setPinnedContainer] = useState<HTMLDivElement | null>(null);
  const noop = () => {};
  return (
    <LazyMotion features={domMax} strict>
      <AppSidebar
        active="direct-messages"
        beforeProjects={<div data-testid="pinned-slot" ref={setPinnedContainer} />}
        canCreateSession
        onNavigate={noop}
        onNewMessage={noop}
        onNewProfile={noop}
        onOpenWorkspace={noop}
        onPinnedChange={noop}
        pinned={pinned}
      >
        <Sidebar
          activeSessionId={activeSessionId}
          activityBySession={activityBySession}
          agents={[AGENT]}
          agentSessions={sessions}
          canCreateSession
          embedded
          maxWidth={480}
          onArchiveProjectChats={noop}
          onArchiveSession={onArchive}
          onDeleteProjectChats={noop}
          onDeleteSession={noop}
          onListArchivedSessions={onListArchived}
          onNewSession={noop}
          onNewWorkspaceSession={noop}
          onOpenSettings={noop}
          onOpenWorkspace={noop}
          onMoveSession={async (input) => {
            await onMove(input);
            const current = sessions.find((item) => item.id === input.id);
            if (!current) throw new Error("Session unavailable");
            const workspace = workspaces.find((item) => item.id === input.workspaceId);
            const next = {
              ...current,
              ...(workspace ? { workspaceId: workspace.id, cwd: workspace.rootPath } : {}),
            };
            if (input.pinned) next.pinnedAt = "2026-10-14T00:00:00Z";
            else delete next.pinnedAt;
            setSessions((items) => items.map((item) => (item.id === next.id ? next : item)));
            return next;
          }}
          onPinProject={noop}
          onPinSession={(target, pin) =>
            setSessions((items) =>
              items.map((item) => {
                if (item.id !== target.id) return item;
                const next = { ...item };
                if (pin) next.pinnedAt = "2026-10-14T00:00:00Z";
                else delete next.pinnedAt;
                return next;
              }),
            )
          }
          onRemoveProject={noop}
          onRenameProject={noop}
          onRestoreSession={onRestore}
          onRevealProject={noop}
          onSelectSession={onSelect}
          onWidthChange={noop}
          open
          pinnedContainer={pinnedContainer}
          projectsExpanded={projectsExpanded}
          chatsExpanded={chatsExpanded}
          onToggleChats={() => setChatsExpanded((value) => !value)}
          onExpandChats={() => setChatsExpanded(true)}
          onToggleProjects={() => setProjectsExpanded((value) => !value)}
          width={300}
          workspaces={workspaces}
        />
      </AppSidebar>
    </LazyMotion>
  );
}

describe("sidebar project and Agent navigation", () => {
  it.each([false, true])("highlights only the active session text (pinned=%s)", (pinned) => {
    render(
      <Navigation
        activeSessionId="Oi"
        initialSessions={[
          session("Oi", pinned ? { pinnedAt: "2026-10-14T00:00:00Z" } : {}),
          session("Other"),
        ]}
      />,
    );
    const active = screen.getByText("Oi");
    expect(active.className).toContain("text-accent");
    expect(active.closest("button")?.getAttribute("aria-current")).toBe("page");
    expect(active.closest("button")?.parentElement?.className).not.toContain("row-selected");
    expect(screen.getByText("Other").className).not.toContain("text-accent");
  });

  it("uses one Projects toggle and lists each project session exactly once", async () => {
    render(<Navigation initialSessions={[session("Oi")]} />);
    expect(screen.queryByText("Project context")).toBeNull();
    expect(screen.queryByText("Open workspace")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Open workspace" })).toHaveLength(1);
    expect(screen.getAllByText("Oi")).toHaveLength(1);
    const projects = screen.getByRole("button", { name: "Projects" });
    expect(projects.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(projects);
    await waitFor(() => expect(screen.queryByText("Dayz")).toBeNull());
    expect(projects.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "Open workspace" })).toBeTruthy();
    fireEvent.click(projects);
    expect(await screen.findByText("Oi")).toBeTruthy();
    expect(screen.getAllByText("Oi")).toHaveLength(1);
  });

  it("renders Chats and Projects as independent peer disclosures", async () => {
    render(
      <Navigation
        initialSessions={[
          session("Inbox chat", { workspaceId: CHATS_WORKSPACE_ID }),
          session("Project chat"),
        ]}
        workspaces={[WORKSPACE, CHATS_WORKSPACE]}
      />,
    );
    const chats = screen.getByTestId("sidebar-chats");
    const projects = screen.getByTestId("sidebar-projects");
    const chatsHeader = within(chats).getByRole("button", { name: "Chats" });
    const projectsHeader = within(projects).getByRole("button", { name: "Projects" });
    expect(chats.compareDocumentPosition(projects) & 4).toBe(4);
    expect(chatsHeader.getAttribute("aria-expanded")).toBe("true");
    expect(projectsHeader.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(chatsHeader);
    await waitFor(() => expect(within(chats).queryByText("Inbox chat")).toBeNull());
    expect(projectsHeader.getAttribute("aria-expanded")).toBe("true");
    expect(within(projects).getByText("Project chat")).toBeTruthy();
  });

  it("lists inbox chats only in Chats, keeps project and unavailable sessions in Projects, and selects by ID", () => {
    const onSelect = vi.fn();
    const inboxSession = session("Inbox chat", { workspaceId: CHATS_WORKSPACE_ID });
    const projectSession = session("Project chat");
    const unavailableSession = session("Unavailable", { workspaceId: "missing" });
    const pinnedInbox = session("Pinned inbox", {
      workspaceId: CHATS_WORKSPACE_ID,
      pinnedAt: "2026-10-14T00:00:00Z",
    });
    render(
      <Navigation
        initialSessions={[inboxSession, projectSession, unavailableSession, pinnedInbox]}
        onSelect={onSelect}
        workspaces={[WORKSPACE, SECOND_WORKSPACE, CHATS_WORKSPACE]}
      />,
    );

    const chats = screen.getByTestId("sidebar-chats");
    const projects = screen.getByTestId("sidebar-projects");
    expect(within(chats).getByText("Inbox chat")).toBeTruthy();
    expect(within(chats).queryByText("Project chat")).toBeNull();
    expect(within(projects).getByText("Project chat")).toBeTruthy();
    expect(within(projects).getByText("Unavailable")).toBeTruthy();
    expect(within(projects).queryByText("Inbox chat")).toBeNull();
    expect(within(screen.getByTestId("pinned-slot")).getByText("Pinned inbox")).toBeTruthy();
    expect(within(chats).queryByText("Pinned inbox")).toBeNull();
    expect(screen.getAllByText("Inbox chat")).toHaveLength(1);
    fireEvent.click(within(chats).getByRole("button", { name: "Inbox chat" }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "Inbox chat",
        workspaceId: CHATS_WORKSPACE_ID,
      }),
    );
    fireEvent.click(within(chats).getByRole("button", { name: "Pin chat" }));
    expect(within(screen.getByTestId("pinned-slot")).getByText("Inbox chat")).toBeTruthy();
    expect(within(chats).queryByText("Inbox chat")).toBeNull();
    expect(screen.getAllByText("Inbox chat")).toHaveLength(1);
  });

  it("gives Chats its own collapsible header without project actions and preserves inbox session actions and archives", async () => {
    const inbox = session("Inbox chat", { workspaceId: CHATS_WORKSPACE_ID });
    const archived = session("Archived inbox chat", {
      workspaceId: CHATS_WORKSPACE_ID,
      archivedAt: "2026-10-13T00:00:00Z",
    });
    const onArchive = vi.fn();
    const onRestore = vi.fn();
    const onListArchived = vi.fn(async () => [archived]);
    render(
      <Navigation
        initialSessions={[inbox]}
        onArchive={onArchive}
        onListArchived={onListArchived}
        onRestore={onRestore}
        workspaces={[WORKSPACE, CHATS_WORKSPACE]}
      />,
    );

    const chats = screen.getByTestId("sidebar-chats");
    const header = within(chats).getByRole("button", { name: "Chats" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(within(chats).queryByRole("button", { name: "Project actions" })).toBeNull();
    expect(within(chats).queryByRole("button", { name: "New session" })).toBeNull();
    expect(within(chats).queryByText("Pin project")).toBeNull();
    expect(within(chats).queryByText("Open in Explorer")).toBeNull();
    expect(within(chats).queryByText("Rename project")).toBeNull();
    expect(within(chats).queryByText("Remove project")).toBeNull();
    expect(within(chats).getByRole("button", { name: "Rename session" })).toBeTruthy();
    expect(within(chats).getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(within(chats).getByRole("button", { name: "Pin chat" })).toBeTruthy();
    fireEvent.click(within(chats).getByRole("button", { name: "Archived chats" }));
    expect(onListArchived).toHaveBeenCalledWith(CHATS_WORKSPACE_ID);
    expect(await within(chats).findByText("Archived inbox chat")).toBeTruthy();
    fireEvent.click(within(chats).getByRole("button", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledWith(archived);
    fireEvent.click(within(chats).getByRole("button", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledWith(inbox);

    fireEvent.click(header);
    await waitFor(() => expect(within(chats).queryByText("Inbox chat")).toBeNull());
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the inbox drop target present while empty and collapsed, with drop feedback", async () => {
    const onMove = vi.fn(async () => {});
    render(
      <Navigation
        initialSessions={[session("Project chat")]}
        onMove={onMove}
        workspaces={[WORKSPACE, CHATS_WORKSPACE]}
      />,
    );
    const chats = screen.getByTestId("sidebar-chats");
    const chatsHeader = within(chats).getByRole("button", { name: "Chats" });
    fireEvent.click(chatsHeader);
    await waitFor(() => expect(chatsHeader.getAttribute("aria-expanded")).toBe("false"));
    expect(chats.getAttribute("data-workspace-drop")).toBe(CHATS_WORKSPACE_ID);
    expect(within(chats).queryByRole("button", { name: "Chats" })).toBe(chatsHeader);
    expect(within(chats).queryByRole("button", { name: "Project chat" })).toBeNull();

    const drag = dragSession("Project chat");
    fireEvent.dragOver(chats, { dataTransfer: drag.dataTransfer });
    expect(chats.className).toContain("bg-hover");
    fireEvent.drop(chats, { dataTransfer: drag.dataTransfer });
    await waitFor(() =>
      expect(onMove).toHaveBeenCalledWith({
        id: "Project chat",
        workspaceId: CHATS_WORKSPACE_ID,
        pinned: false,
      }),
    );
  });

  it("opens Archived chats from the collapsed Chats disclosure and reports expanded states", async () => {
    const archived = session("Previously archived", {
      workspaceId: CHATS_WORKSPACE_ID,
      archivedAt: "2026-10-13T00:00:00Z",
    });
    render(
      <Navigation
        initialSessions={[session("Inbox chat", { workspaceId: CHATS_WORKSPACE_ID })]}
        onListArchived={async () => [archived]}
        workspaces={[WORKSPACE, CHATS_WORKSPACE]}
      />,
    );
    const chats = screen.getByTestId("sidebar-chats");
    const header = within(chats).getByRole("button", { name: "Chats" });
    fireEvent.click(header);
    await waitFor(() => expect(header.getAttribute("aria-expanded")).toBe("false"));
    const archivedControl = within(chats).getByRole("button", { name: "Archived chats" });
    fireEvent.click(archivedControl);
    expect(archivedControl.getAttribute("aria-expanded")).toBe("true");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(await within(chats).findByText("Previously archived")).toBeTruthy();
  });

  it("keeps pinned Agents and sessions above Projects and returns unpinned items to their project", async () => {
    const onSelect = vi.fn();
    render(
      <Navigation
        initialSessions={[
          session("Atlas", { agentId: AGENT.id, pinnedAt: "2026-10-14T00:00:00Z" }),
          session("Oi", { pinnedAt: "2026-10-14T00:00:00Z" }),
        ]}
        onSelect={onSelect}
      />,
    );
    const pinned = screen.getByTestId("pinned-slot");
    expect(within(pinned).getByText("Atlas")).toBeTruthy();
    expect(within(pinned).getByText("Oi")).toBeTruthy();
    expect(
      pinned.compareDocumentPosition(screen.getByRole("button", { name: "Projects" })) & 4,
    ).toBe(4);
    expect(screen.getAllByText("Atlas")).toHaveLength(1);
    expect(screen.getAllByText("Oi")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    await waitFor(() => expect(screen.queryByText("Dayz")).toBeNull());
    fireEvent.click(within(pinned).getByRole("button", { name: "Atlas" }));
    expect(onSelect.mock.calls[0]?.[0].agentId).toBe(AGENT.id);
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    const row = within(pinned).getByText("Oi").closest("button")?.parentElement;
    expect(row).toBeTruthy();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Unpin chat" }));
    await waitFor(() => expect(within(pinned).queryByText("Oi")).toBeNull());
    expect(screen.getAllByText("Oi")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Pin chat" }));
    expect(await within(pinned).findByText("Oi")).toBeTruthy();
    expect(screen.getAllByText("Oi")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Unpin Agent" }));
    await waitFor(() => expect(within(pinned).queryByText("Atlas")).toBeNull());
    expect(screen.getAllByText("Atlas")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Pin Agent" }));
    expect(await within(pinned).findByText("Atlas")).toBeTruthy();
    expect(screen.getAllByText("Atlas")).toHaveLength(1);
  });

  it("shows the stored animated Agent avatar beside its session and keeps ordinary session status", () => {
    render(
      <Navigation
        activityBySession={{
          Atlas: { running: true, needsInput: false, failed: false, unread: false },
        }}
        initialSessions={[session("Atlas", { agentId: AGENT.id }), session("Oi")]}
      />,
    );
    const avatar = screen.getByTestId("agent-avatar");
    expect(avatar.getAttribute("data-color")).toBe("orange");
    expect(avatar.getAttribute("data-face")).toBe("happy");
    expect(avatar.getAttribute("data-shape")).toBe("roundedSquare");
    expect(avatar.getAttribute("data-state")).toBe("working");
    expect(avatar.getAttribute("data-animated")).not.toBe("false");
    expect(screen.getByRole("button", { name: "New Agent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New profile" })).toBeNull();
    expect(screen.getAllByTitle("Idle")).toHaveLength(1);
  });

  it("does not mistake expanded Projects for a popup and preserves hover collapse state", async () => {
    render(<Navigation initialSessions={[session("Oi")]} pinned={false} />);
    const nav = screen.getByRole("navigation");
    fireEvent.mouseEnter(nav);
    expect(screen.getAllByText("Oi")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    await waitFor(() => expect(screen.queryByText("Dayz")).toBeNull());
    fireEvent.mouseLeave(nav);
    expect(nav.getAttribute("data-open")).toBe("false");
    fireEvent.mouseEnter(nav);
    expect(screen.queryByText("Dayz")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(await screen.findByText("Oi")).toBeTruthy();
    fireEvent.mouseLeave(nav);
    expect(nav.getAttribute("data-open")).toBe("false");
  });

  it.each([
    {
      activity: { running: false, needsInput: true, failed: false, unread: false },
      state: "waiting",
      status: undefined,
    },
    {
      activity: { running: false, needsInput: false, failed: true, unread: false },
      state: "idle",
      status: "Last run failed",
    },
    {
      activity: { running: false, needsInput: false, failed: false, unread: true },
      state: "idle",
      status: "Finished while in the background",
    },
  ])("preserves Agent activity $state/$status", ({ activity, state, status }) => {
    render(
      <Navigation
        initialSessions={[session("Atlas", { agentId: AGENT.id })]}
        activityBySession={{ Atlas: activity }}
      />,
    );
    expect(screen.getByTestId("agent-avatar").getAttribute("data-state")).toBe(state);
    if (status) expect(screen.getByTitle(status)).toBeTruthy();
  });

  it("keeps an Agent session usable when its profile is unavailable", () => {
    const onSelect = vi.fn();
    render(
      <Navigation
        initialSessions={[session("Legacy Agent", { agentId: "unavailable" })]}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByTestId("agent-avatar")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Legacy Agent" }));
    expect(onSelect.mock.calls[0]?.[0].id).toBe("Legacy Agent");
  });

  it("keeps unavailable-project sessions discoverable and excludes archived and child sessions", () => {
    render(
      <Navigation
        initialSessions={[
          session("Orphan", { workspaceId: "missing" }),
          session("Archived", { archivedAt: "2026-10-14T00:00:00Z" }),
          session("Child", { parentSessionId: "root" }),
        ]}
      />,
    );
    expect(screen.getAllByText("Orphan")).toHaveLength(1);
    expect(screen.queryByText("Archived")).toBeNull();
    expect(screen.queryByText("Child")).toBeNull();
  });
});

function dragSession(title: string) {
  const row = screen.getByRole("button", { name: title }).parentElement as HTMLElement;
  const dataTransfer = { setData: vi.fn(), effectAllowed: "none", dropEffect: "none" };
  fireEvent.dragStart(row, { dataTransfer });
  return { row, dataTransfer };
}

describe("sidebar session drag and drop", () => {
  it("moves an Agent into another project through the host callback, without duplicates", async () => {
    const onMove = vi.fn(async () => {});
    render(
      <Navigation initialSessions={[session("Atlas", { agentId: AGENT.id })]} onMove={onMove} />,
    );
    const drag = dragSession("Atlas");
    fireEvent.dragOver(screen.getByText("Destination"), { dataTransfer: drag.dataTransfer });
    fireEvent.drop(screen.getByText("Destination"), { dataTransfer: drag.dataTransfer });
    await waitFor(() =>
      expect(onMove).toHaveBeenCalledWith({ id: "Atlas", workspaceId: "modus", pinned: false }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Atlas" })
          .closest("[data-workspace-drop]")
          ?.getAttribute("data-workspace-drop"),
      ).toBe("modus"),
    );
    expect(screen.getAllByText("Atlas")).toHaveLength(1);
  });

  it("pins by dropping above Projects and moves back into the chosen project", async () => {
    const onMove = vi.fn(async () => {});
    render(<Navigation initialSessions={[session("Oi")]} onMove={onMove} />);
    let drag = dragSession("Oi");
    fireEvent.drop(screen.getByTestId("sidebar-pin-drop"), { dataTransfer: drag.dataTransfer });
    await waitFor(() =>
      expect(within(screen.getByTestId("pinned-slot")).getByText("Oi")).toBeTruthy(),
    );
    expect(onMove).toHaveBeenLastCalledWith({ id: "Oi", pinned: true });
    drag = dragSession("Oi");
    fireEvent.drop(screen.getByText("Destination"), { dataTransfer: drag.dataTransfer });
    await waitFor(() =>
      expect(within(screen.getByTestId("pinned-slot")).queryByText("Oi")).toBeNull(),
    );
    expect(onMove).toHaveBeenLastCalledWith({ id: "Oi", workspaceId: "modus", pinned: false });
  });

  it("persists row order only after a successful drop", async () => {
    const props = { initialSessions: [session("One"), session("Two")] };
    const view = render(<Navigation {...props} />);
    const drag = dragSession("Two");
    fireEvent.drop(screen.getByRole("button", { name: "One" }), {
      dataTransfer: drag.dataTransfer,
    });
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /^(One|Two)$/ }).map((button) => button.textContent),
      ).toEqual(["Two", "One"]),
    );
    view.unmount();
    render(<Navigation {...props} />);
    expect(
      screen.getAllByRole("button", { name: /^(One|Two)$/ }).map((button) => button.textContent),
    ).toEqual(["Two", "One"]);
  });

  it("reports a refused transfer and preserves the original project and order", async () => {
    render(
      <Navigation
        initialSessions={[session("Oi")]}
        onMove={async () => {
          throw new Error("Finish active work before moving this session.");
        }}
      />,
    );
    const drag = dragSession("Oi");
    fireEvent.drop(screen.getByText("Destination"), { dataTransfer: drag.dataTransfer });
    expect((await screen.findByRole("alert")).textContent).toContain("Finish active work");
    expect(
      screen
        .getByRole("button", { name: "Oi" })
        .closest("[data-workspace-drop]")
        ?.getAttribute("data-workspace-drop"),
    ).toBe("dayz");
    expect(localStorage.getItem("modus.sidebar.sessionOrder")).toBeNull();
  });

  it("ignores foreign drops and cancelled drags", async () => {
    const onMove = vi.fn(async () => {});
    render(<Navigation initialSessions={[session("Oi")]} onMove={onMove} />);
    fireEvent.drop(screen.getByText("Destination"), { dataTransfer: { getData: () => "Oi" } });
    const drag = dragSession("Oi");
    fireEvent.dragEnd(drag.row);
    fireEvent.drop(screen.getByText("Destination"), { dataTransfer: drag.dataTransfer });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("closes an unpinned sidebar after a successful drop even when the source row is replaced", async () => {
    render(<Navigation initialSessions={[session("Oi")]} pinned={false} />);
    const nav = screen.getByRole("navigation");
    fireEvent.mouseEnter(nav);
    const drag = dragSession("Oi");
    fireEvent.mouseLeave(nav);
    fireEvent.drop(screen.getByText("Destination"), { dataTransfer: drag.dataTransfer });
    await waitFor(() => expect(nav.getAttribute("data-open")).toBe("false"));
    fireEvent.mouseEnter(nav);
    fireEvent.mouseLeave(nav);
    expect(nav.getAttribute("data-open")).toBe("false");
  });

  it("offers the same project transfer through the keyboard-accessible menu", async () => {
    const onMove = vi.fn(async () => {});
    render(
      <Navigation initialSessions={[session("Atlas", { agentId: AGENT.id })]} onMove={onMove} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Move session" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Destination" }));
    await waitFor(() =>
      expect(onMove).toHaveBeenCalledWith({ id: "Atlas", workspaceId: "modus", pinned: false }),
    );
  });

  it("keeps an unpinned sidebar open during a drag and releases it on cancellation", () => {
    render(<Navigation initialSessions={[session("Oi")]} pinned={false} />);
    const nav = screen.getByRole("navigation");
    fireEvent.mouseEnter(nav);
    const drag = dragSession("Oi");
    fireEvent.mouseLeave(nav);
    expect(nav.getAttribute("data-open")).toBe("true");
    fireEvent.dragEnd(drag.row);
    expect(nav.getAttribute("data-open")).toBe("false");
  });
});
