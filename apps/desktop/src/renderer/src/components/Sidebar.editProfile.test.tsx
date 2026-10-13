// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
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
  return { noop };
}

afterEach(cleanup);

describe("Sidebar: edit agent profile", () => {
  it("shows the action only on an agent's chat and passes its agent id", async () => {
    const onEdit = vi.fn();
    const { noop } = renderSidebar(onEdit);
    const buttons = screen.getAllByRole("button", { name: "Edit agent profile" });
    expect(buttons).toHaveLength(1);
    await userEvent.setup().click(buttons[0] as HTMLElement);
    expect(onEdit).toHaveBeenCalledWith("agent-1");
    // Does not also open the chat.
    expect(noop).not.toHaveBeenCalled();
  });

  it("is hidden when no handler is given", () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: "Edit agent profile" })).toBeNull();
  });
});
