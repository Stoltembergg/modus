// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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
const onManageMembers = vi.fn();

beforeEach(() => {
  onToggle.mockReset();
  onSearchChange.mockReset();
  onManageMembers.mockReset();
  (window as unknown as { modus: unknown }).modus = { agents: { list: vi.fn(async () => []) } };
});
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

function Header({ searchQuery, onSearch }: { searchQuery: string; onSearch(q: string): void }) {
  return (
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
      onManageMembers={onManageMembers}
      onRename={vi.fn()}
      onSearchChange={onSearch}
      onStop={vi.fn()}
      projectName="Repo"
      running
      searchQuery={searchQuery}
      variant="chrome"
    />
  );
}

/** Controlled search, like GroupRoom. */
function StatefulHeader() {
  const [query, setQuery] = useState("");
  return <Header onSearch={setQuery} searchQuery={query} />;
}

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
      onManageMembers={onManageMembers}
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

  it("+N chip opens a keyboard menu of the hidden members; Esc closes it back on the chip", async () => {
    const user = userEvent.setup();
    renderAt(600);
    const chip = screen.getByRole("button", { name: "2 more agents: Writer, Tester" });
    chip.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByTestId("group-agent-overflow-menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["WriterIdle", "TesterIdle"]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("TesterIdle");
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByTestId("group-agent-overflow-menu")).toBeNull());
    expect(document.activeElement).toBe(chip);
    // Space opens it too; picking a member opens Manage members.
    await user.keyboard(" ");
    await user.click(await screen.findByRole("menuitem", { name: /Tester/u }));
    expect(onManageMembers).toHaveBeenCalledTimes(1);
  });

  it("sm search: Esc closes, title back, focus on the toggle", async () => {
    const user = userEvent.setup();
    restore = installFixedWidthResizeObserver(400);
    render(<StatefulHeader />);
    await user.click(screen.getByRole("button", { name: "Search in conversation" }));
    await user.keyboard("deploy");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByTestId("group-room-title")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Search in conversation" }),
    );
  });

  it("sm search: blur with an empty field closes it; blur with text keeps it open", async () => {
    const user = userEvent.setup();
    restore = installFixedWidthResizeObserver(400);
    render(<StatefulHeader />);
    await user.click(screen.getByRole("button", { name: "Search in conversation" }));
    expect(screen.getByRole("searchbox")).toBeTruthy();
    await user.click(screen.getByTestId("group-room-header"));
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByTestId("group-room-title")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Search in conversation" }));
    await user.keyboard("deploy");
    await user.click(screen.getByTestId("group-room-header"));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("deploy");
    expect(screen.queryByTestId("group-room-title")).toBeNull();
  });
});
