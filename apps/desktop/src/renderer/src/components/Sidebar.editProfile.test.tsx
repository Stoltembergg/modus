// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionInfo, WorkspaceInfo } from "../../../shared/contracts";
import { Sidebar } from "./Sidebar";

const WORKSPACE: WorkspaceInfo = {
  id: "ws-1",
  rootPath: "/repo",
  displayName: "Repo",
  isGitRepository: true,
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
  pinned: false,
};

const base = {
  workspaceId: "ws-1",
  cwd: "/repo",
  status: "idle" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const SESSIONS: AgentSessionInfo[] = [
  { ...base, id: "s-agent", title: "Agent chat", agentId: "agent-1" },
  { ...base, id: "s-plain", title: "Plain chat" },
];

function renderSidebar(onEditAgentProfile?: (agentId: string) => void) {
  const noop = vi.fn();
  render(
    <Sidebar
      activityBySession={{}}
      agentSessions={SESSIONS}
      canCreateSession
      section="direct-messages"
      maxWidth={480}
      onArchiveProjectChats={noop}
      onArchiveSession={noop}
      onDeleteProjectChats={noop}
      onDeleteSession={noop}
      {...(onEditAgentProfile ? { onEditAgentProfile } : {})}
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
  fireEvent.click(screen.getByRole("button", { name: "Projects" }));
  return { noop };
}

afterEach(cleanup);

describe("Sidebar: edit agent profile", () => {
  function openRowMenu(title: string) {
    const row = screen.getByRole("button", { name: title }).closest("[data-session-id]");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Chat actions" }));
  }

  it("offers the action only in an agent chat's menu and passes its agent id", async () => {
    const onEdit = vi.fn();
    const { noop } = renderSidebar(onEdit);
    openRowMenu("Plain chat");
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Edit agent profile" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    openRowMenu("Agent chat");
    await userEvent
      .setup()
      .click(await screen.findByRole("menuitem", { name: "Edit agent profile" }));
    expect(onEdit).toHaveBeenCalledWith("agent-1");
    // Does not also open the chat.
    expect(noop).not.toHaveBeenCalled();
  });

  it("is hidden when no handler is given", async () => {
    renderSidebar();
    openRowMenu("Agent chat");
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Edit agent profile" })).toBeNull();
  });
});
