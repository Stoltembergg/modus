// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionInfo, WorkspaceInfo } from "../../../shared/contracts";
import { Sidebar } from "./Sidebar";

// Real Base UI Menu (no mocks): these tests depend on its close-on-click behaviour.

const WORKSPACE: WorkspaceInfo = {
  id: "ws-1",
  rootPath: "/repo",
  displayName: "Repo",
  isGitRepository: true,
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
  pinned: false,
};

const SESSIONS: AgentSessionInfo[] = [
  {
    id: "s-1",
    workspaceId: "ws-1",
    title: "Chat s-1",
    cwd: "/repo",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function renderSidebar() {
  const noop = vi.fn();
  const onArchiveProjectChats = vi.fn();
  const onDeleteProjectChats = vi.fn();
  render(
    <Sidebar
      activityBySession={{}}
      agentSessions={SESSIONS}
      canCreateSession
      section="direct-messages"
      maxWidth={480}
      onArchiveProjectChats={onArchiveProjectChats}
      onArchiveSession={noop}
      onDeleteProjectChats={onDeleteProjectChats}
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
      workspaces={[WORKSPACE]}
    />,
  );
  return { onArchiveProjectChats, onDeleteProjectChats };
}

async function openProjectMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Project context" }));
  await user.click(screen.getByRole("button", { name: "Project actions" }));
  return screen.findByRole("menu");
}

afterEach(() => cleanup());

describe("Project menu", () => {
  it("does not expose Limits as a sidebar destination", () => {
    renderSidebar();

    expect(screen.queryByRole("button", { name: "Limits" })).toBeNull();
  });

  it("closes on a plain item click (the real Base UI close-on-click is active)", async () => {
    const user = userEvent.setup();
    const { onArchiveProjectChats } = renderSidebar();
    const menu = await openProjectMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Archive chats" }));
    expect(onArchiveProjectChats).toHaveBeenCalledWith("ws-1");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("Delete chats: the first click shows the confirmation, the second deletes", async () => {
    const user = userEvent.setup();
    const { onDeleteProjectChats } = renderSidebar();
    const menu = await openProjectMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Delete chats" }));
    expect(onDeleteProjectChats).not.toHaveBeenCalled();
    // The menu must still be open for the confirm step.
    expect(screen.queryByRole("menu")).not.toBeNull();

    const confirm = await screen.findByRole("menuitem", { name: "Confirm delete chats" });
    await user.click(confirm);
    expect(onDeleteProjectChats).toHaveBeenCalledTimes(1);
    expect(onDeleteProjectChats).toHaveBeenCalledWith("ws-1");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("Project context chats", () => {
  it("render without a scroll-reveal blur", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole("button", { name: "Project context" }));
    const section = screen.getByTestId("sidebar-project-context");
    const title = await within(section).findByText("Chat s-1");
    for (
      let node: HTMLElement | null = title;
      node && node !== section;
      node = node.parentElement
    ) {
      expect(node.style.filter).not.toMatch(/blur/);
    }
  });
});
