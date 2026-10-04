// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGroupWithMembers } from "../../../../shared/contracts";
import { installFixedWidthResizeObserver } from "../../lib/widthTierTestUtils";
import { GroupRoomHeader } from "./GroupRoomHeader";

const NAMES = ["Planner", "Reviewer", "Writer", "Tester"];
const GROUP: AgentGroupWithMembers = {
  id: "g-1",
  name: "Release squad with a very long name for narrow windows",
  workspaceId: "ws-1",
  mode: "free",
  leadSessionId: "s-0",
  members: NAMES.map((name, index) => ({
    groupId: "g-1",
    sessionId: `s-${index}`,
    agentId: `agent-${index}`,
    name,
    agentRole: "",
    joinedAt: "2026-01-01T00:00:00.000Z",
  })),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

let restore: (() => void) | undefined;
const onToggle = vi.fn();
const onSearchChange = vi.fn();

beforeEach(() => {
  onToggle.mockReset();
  onSearchChange.mockReset();
  (window as unknown as { modus: unknown }).modus = { agents: { list: vi.fn(async () => []) } };
});
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

function renderAt(width: number | undefined, extra: { searchQuery?: string } = {}) {
  if (width !== undefined) restore = installFixedWidthResizeObserver(width);
  return render(
    <GroupRoomHeader
      activity={{
        count: 2,
        label: "Activity, 2 open",
        onToggle,
        open: false,
        title: "Show activity",
      }}
      avatars={new Map()}
      group={GROUP}
      memberStates={new Map()}
      onDelete={vi.fn()}
      onManageMembers={vi.fn()}
      onRename={vi.fn()}
      onSearchChange={onSearchChange}
      onStop={vi.fn()}
      projectName="Repo"
      running
      searchQuery={extra.searchQuery ?? ""}
      variant="chrome"
    />,
  );
}

describe("GroupRoomHeader responsive (L3c)", () => {
  it("lg: full bar (project badge, labelled Stop / Activity, every avatar)", () => {
    renderAt(1000);
    const header = screen.getByTestId("group-room-header");
    expect(header.dataset.widthTier).toBe("lg");
    const title = screen.getByTestId("group-room-title");
    expect(title.className).toContain("truncate");
    expect(title.getAttribute("title")).toBe(GROUP.name);
    expect(screen.getByTestId("group-project-badge").getAttribute("title")).toBe("Repo");
    expect(screen.getByRole("button", { name: "Stop" }).textContent).toBe("Stop");
    expect(screen.getByTestId("group-activity-button").textContent).toContain("Activity");
    expect(screen.getByRole("searchbox", { name: "Search in conversation" })).toBeTruthy();
    expect(screen.queryByTestId("group-agent-overflow")).toBeNull();
  });

  it("unmeasured (no ResizeObserver): keeps the full layout", () => {
    const previous = globalThis.ResizeObserver;
    // @ts-expect-error: simulate an environment without ResizeObserver.
    delete globalThis.ResizeObserver;
    try {
      renderAt(undefined);
      expect(screen.getByTestId("group-room-header").dataset.widthTier).toBe("lg");
    } finally {
      globalThis.ResizeObserver = previous;
    }
  });

  it("md: project folds into the title tooltip, Stop / Activity icon-only, +N avatars", () => {
    renderAt(600);
    expect(screen.getByTestId("group-room-header").dataset.widthTier).toBe("md");
    expect(screen.queryByTestId("group-project-badge")).toBeNull();
    expect(screen.getByTestId("group-room-title").getAttribute("title")).toBe(
      `${GROUP.name} · Repo`,
    );
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop.textContent).toBe("");
    const activity = screen.getByRole("button", { name: "Activity, 2 open" });
    expect(activity.textContent).toBe("2");
    const presence = screen.getByTestId("group-agent-presence");
    const overflow = within(presence).getByTestId("group-agent-overflow");
    expect(overflow.textContent).toBe("+2");
    expect(overflow.getAttribute("title")).toBe("Writer, Tester");
    expect(overflow.getAttribute("aria-label")).toBe("2 more agents: Writer, Tester");
  });

  it("sm: Activity moves into the Group actions menu (keyboard reachable)", async () => {
    const user = userEvent.setup();
    renderAt(400);
    expect(screen.getByTestId("group-room-header").dataset.widthTier).toBe("sm");
    expect(screen.queryByTestId("group-activity-button")).toBeNull();
    expect(screen.getByTestId("group-agent-overflow").textContent).toBe("+3");
    const trigger = screen.getByRole("button", { name: "Group actions" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const item = await screen.findByTestId("group-activity-menu-item");
    expect(item.getAttribute("role")).toBe("menuitemcheckbox");
    expect(item.textContent).toContain("Activity");
    expect(item.textContent).toContain("2");
    // The usual group actions are still there.
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    await user.click(item);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("sm: search is an icon button that opens over the title; Escape closes it", async () => {
    renderAt(400);
    expect(screen.queryByRole("searchbox")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Search in conversation" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(toggle);
    });
    const search = screen.getByRole("searchbox", { name: "Search in conversation" });
    expect(document.activeElement).toBe(search);
    expect(screen.queryByTestId("group-room-title")).toBeNull();
    expect(screen.getByTestId("group-room-header-row").hasAttribute("data-search-over-title")).toBe(
      true,
    );
    await act(async () => {
      fireEvent.keyDown(search, { key: "Escape" });
    });
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByTestId("group-room-title")).toBeTruthy();
  });

  it("sm: a non-empty query keeps the search open", () => {
    renderAt(400, { searchQuery: "deploy" });
    expect(
      (screen.getByRole("searchbox", { name: "Search in conversation" }) as HTMLInputElement).value,
    ).toBe("deploy");
  });
});
