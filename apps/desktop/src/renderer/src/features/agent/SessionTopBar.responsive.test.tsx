// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionInfo, WorkspaceInfo } from "../../../../shared/contracts";
import type { WidthTier } from "../../lib/useWidthTier";
import { HeaderActions } from "./SessionHeaderActions";
import { SessionTitlePopover } from "./SessionTitlePopover";

afterEach(() => {
  cleanup();
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

const TIERS: WidthTier[] = ["lg", "md", "sm"];

function expectNoChecklistControl() {
  expect(screen.queryByRole("button", { name: /task checklist|to-dos/i })).toBeNull();
  expect(screen.queryByRole("menuitemcheckbox", { name: /task checklist/i })).toBeNull();
  expect(screen.queryByRole("button", { name: "Session actions" })).toBeNull();
}

describe("1:1 session top bar responsive (L3c)", () => {
  it("lg: truncated title with a tooltip and the sidebar icon button", () => {
    renderBar("lg");
    const title = screen.getByTestId("session-title-trigger");
    expect(title.getAttribute("title")).toBe(SESSION.title);
    expect(title.className).toContain("max-w-44");
    expect(screen.getByTestId("session-title-text").className).toContain("truncate-fade");
    expect(screen.queryByRole("button", { name: "Environment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show right sidebar" })).toBeTruthy();
  });

  it("md: narrower title, project folded into the tooltip, sidebar toggle icon-only", () => {
    renderBar("md");
    const title = screen.getByTestId("session-title-trigger");
    expect(title.getAttribute("title")).toBe(`${SESSION.title} · modus-desktop`);
    expect(title.querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show right sidebar" }).textContent).toBe("");
  });

  it("sm: the sidebar toggle stays a single icon button (no actions menu)", async () => {
    const user = userEvent.setup();
    const { onToggleInspector } = renderBar("sm", true);
    expect(screen.getByTestId("session-title-trigger").querySelector("svg")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Hide right sidebar" }));
    expect(onToggleInspector).toHaveBeenCalledTimes(1);
  });

  it.each(TIERS)("%s: no task checklist toggle in the top bar", (tier) => {
    renderBar(tier);
    expectNoChecklistControl();
    expect(document.querySelector(`[data-width-tier="${tier}"]`)).toBeTruthy();
  });
});
