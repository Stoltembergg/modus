// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionInfo, WorkspaceInfo } from "../../../../shared/contracts";
import type { WidthTier } from "../../lib/useWidthTier";
import { HeaderActions } from "./SessionHeaderActions";
import { SessionTitlePopover } from "./SessionTitlePopover";

afterEach(cleanup);

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
  const onOpenSettings = vi.fn();
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
        activeWorkspace={WORKSPACE}
        branch="main"
        environmentStats={{ added: 3, removed: 1 }}
        inspectorOpen={inspectorOpen}
        onOpenSettings={onOpenSettings}
        onToggleInspector={onToggleInspector}
        tier={tier}
      />
    </div>,
  );
  return { onToggleInspector, onOpenSettings };
}

describe("1:1 session top bar responsive (L3c)", () => {
  it("lg: truncated title with a tooltip, Environment and sidebar icon buttons", () => {
    renderBar("lg");
    const title = screen.getByTestId("session-title-trigger");
    expect(title.getAttribute("title")).toBe(SESSION.title);
    expect(title.className).toContain("max-w-44");
    expect(screen.getByTestId("session-title-text").className).toContain("truncate-fade");
    expect(screen.getByRole("button", { name: "Environment" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show right sidebar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Session actions" })).toBeNull();
  });

  it("md: narrower title, project folded into the tooltip, actions still icon-only", () => {
    renderBar("md");
    const title = screen.getByTestId("session-title-trigger");
    expect(title.getAttribute("title")).toBe(`${SESSION.title} · modus-desktop`);
    expect(title.querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Environment" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "Show right sidebar" })).toBeTruthy();
  });

  it("sm: Environment and the sidebar toggle collapse into Session actions (keyboard)", async () => {
    const user = userEvent.setup();
    const { onToggleInspector } = renderBar("sm", true);
    // sm: the title pill drops its icon; text truncates with the tooltip.
    expect(screen.getByTestId("session-title-trigger").querySelector("svg")).toBeNull();
    expect(screen.queryByRole("button", { name: "Environment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide right sidebar" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Session actions" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByTestId("session-actions-menu");
    const sidebar = within(menu).getByRole("menuitemcheckbox", { name: "Right sidebar" });
    expect(sidebar.getAttribute("aria-checked")).toBe("true");
    await user.click(sidebar);
    expect(onToggleInspector).toHaveBeenCalledTimes(1);

    // A checkbox item keeps the menu open; Environment opens its popover from here.
    await user.click(within(menu).getByRole("menuitem", { name: "Environment" }));
    expect(await screen.findByRole("button", { name: "Environment settings" })).toBeTruthy();
    // Esc closes it and focus goes back to the Session actions trigger.
    await user.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "Environment settings" })).toBeNull(),
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
