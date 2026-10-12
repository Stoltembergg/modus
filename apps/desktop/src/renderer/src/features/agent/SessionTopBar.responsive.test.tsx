// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionInfo, WorkspaceInfo } from "../../../../shared/contracts";
import { reloadTaskChecklistPreference, TASK_CHECKLIST_STORAGE_KEY } from "../../lib/taskChecklist";
import type { WidthTier } from "../../lib/useWidthTier";
import { HeaderActions } from "./SessionHeaderActions";
import { SessionTitlePopover } from "./SessionTitlePopover";

afterEach(() => {
  cleanup();
  localStorage.clear();
  reloadTaskChecklistPreference();
});

const SESSION: AgentSessionInfo = {
  id: "s-1",
  workspaceId: "ws-1",
  title: "Refactor the billing webhook retry loop",
  cwd: "/repo",
  status: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const WORKSPACE: WorkspaceInfo = {
  id: "ws-1",
  rootPath: "/repo",
  displayName: "modus-desktop",
  isGitRepository: true,
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
  pinned: false,
};

function renderBar(tier: WidthTier, inspectorOpen = false) {
  const onToggleInspector = vi.fn();
  render(
    <div>
      <SessionTitlePopover
        branch="main"
        contextUsage={undefined}
        modelId="m"
        models={[]}
        session={SESSION}
        tier={tier}
        workspace={WORKSPACE}
      />
      <HeaderActions
        inspectorOpen={inspectorOpen}
        onToggleInspector={onToggleInspector}
        tier={tier}
      />
    </div>,
  );
  return { onToggleInspector };
}

describe("1:1 session top bar responsive (L3c)", () => {
  it("lg: truncated title with a tooltip, task checklist and sidebar icon buttons", () => {
    renderBar("lg");
    const title = screen.getByTestId("session-title-trigger");
    expect(title.getAttribute("title")).toBe(SESSION.title);
    expect(title.className).toContain("max-w-44");
    expect(screen.getByTestId("session-title-text").className).toContain("truncate-fade");
    expect(screen.getByRole("button", { name: "Hide task checklist" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Environment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show right sidebar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Session actions" })).toBeNull();
  });

  it("md: narrower title, project folded into the tooltip, actions still icon-only", () => {
    renderBar("md");
    const title = screen.getByTestId("session-title-trigger");
    expect(title.getAttribute("title")).toBe(`${SESSION.title} · modus-desktop`);
    expect(title.querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide task checklist" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "Show right sidebar" })).toBeTruthy();
  });

  it("sm: the checklist and sidebar toggles collapse into Session actions (keyboard)", async () => {
    const user = userEvent.setup();
    const { onToggleInspector } = renderBar("sm", true);
    // sm: the title pill drops its icon; text truncates with the tooltip.
    expect(screen.getByTestId("session-title-trigger").querySelector("svg")).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide task checklist" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide right sidebar" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Session actions" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByTestId("session-actions-menu");
    const sidebar = within(menu).getByRole("menuitemcheckbox", { name: "Right sidebar" });
    expect(sidebar.getAttribute("aria-checked")).toBe("true");
    await user.click(sidebar);
    expect(onToggleInspector).toHaveBeenCalledTimes(1);

    const checklist = within(menu).getByRole("menuitemcheckbox", { name: "Task checklist" });
    expect(checklist.getAttribute("aria-checked")).toBe("true");
    await user.click(checklist);
    await vi.waitFor(() => expect(checklist.getAttribute("aria-checked")).toBe("false"));
    expect(localStorage.getItem(TASK_CHECKLIST_STORAGE_KEY)).toBe("false");
    expect(within(menu).queryByRole("menuitem", { name: "Environment" })).toBeNull();
  });
});

describe("task checklist toggle", () => {
  it("toggles, persists, and restores the checklist preference", async () => {
    const user = userEvent.setup();
    renderBar("lg");
    await user.click(screen.getByRole("button", { name: "Hide task checklist" }));
    expect(localStorage.getItem(TASK_CHECKLIST_STORAGE_KEY)).toBe("false");
    const show = screen.getByRole("button", { name: "Show task checklist" });
    expect(show.dataset.active).toBe("false");
    cleanup();
    // A fresh launch reads the persisted value.
    reloadTaskChecklistPreference();
    renderBar("lg");
    expect(screen.getByRole("button", { name: "Show task checklist" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show task checklist" }));
    expect(localStorage.getItem(TASK_CHECKLIST_STORAGE_KEY)).toBe("true");
  });
});
