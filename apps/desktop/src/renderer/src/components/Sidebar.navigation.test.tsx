// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { domMax, LazyMotion } from "motion/react";
import { useState } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, AgentSessionInfo, WorkspaceInfo } from "../../../shared/contracts";
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
afterEach(cleanup);

const WORKSPACE: WorkspaceInfo = {
  id: "dayz",
  displayName: "Dayz",
  rootPath: "/dayz",
  isGitRepository: true,
  lastOpenedAt: "2026-10-14T00:00:00Z",
  pinned: false,
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
}: {
  initialSessions: AgentSessionInfo[];
  activeSessionId?: string;
  activityBySession?: Record<string, SessionActivity>;
  pinned?: boolean;
  onSelect?: (session: AgentSessionInfo) => void;
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
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
        onPinnedChange={noop}
        onToggleProjects={() => setProjectsExpanded((value) => !value)}
        pinned={pinned}
        projectsExpanded={projectsExpanded}
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
          onArchiveSession={noop}
          onDeleteProjectChats={noop}
          onDeleteSession={noop}
          onListArchivedSessions={async () => []}
          onNewSession={noop}
          onNewWorkspaceSession={noop}
          onOpenSettings={noop}
          onOpenWorkspace={noop}
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
          onRestoreSession={noop}
          onRevealProject={noop}
          onSelectSession={onSelect}
          onWidthChange={noop}
          open
          pinnedContainer={pinnedContainer}
          projectsExpanded={projectsExpanded}
          width={300}
          workspaces={[WORKSPACE]}
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
