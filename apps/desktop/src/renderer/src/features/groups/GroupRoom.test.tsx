// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentGroupWithMembers,
  AgentSessionInfo,
  GroupMemberStates,
  GroupMessage,
  GroupRuntimeEvent,
  GroupTask,
  UpdateState,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import { GROUP_ROOM_EMPTY_TEXT, GroupRoom } from "./GroupRoom";
import { CANCEL_TASK_CONFIRM_LABEL } from "./GroupTaskPanel";
import { GROUP_MESSAGE_PAGE } from "./useGroupMessages";
import type { GroupMemberStatesById } from "./useWorkingGroups";

function session(id: string, title: string): AgentSessionInfo {
  return {
    id,
    workspaceId: "ws-1",
    title,
    cwd: "/repo",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const SESSIONS = [
  session("s-lead", "Planner"),
  session("s-rev-1", "Reviewer"),
  session("s-rev-2", "Reviewer"),
];

const WORKSPACES: WorkspaceInfo[] = [
  {
    id: "ws-1",
    rootPath: "/repo",
    displayName: "Repo",
    isGitRepository: true,
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    pinned: false,
  },
];

const GROUP: AgentGroupWithMembers = {
  id: "g-1",
  name: "Release squad",
  workspaceId: "ws-1",
  mode: "free",
  leadSessionId: "s-lead",
  members: SESSIONS.map((s) => ({
    groupId: "g-1",
    sessionId: s.id,
    joinedAt: "2026-01-01T00:00:00.000Z",
  })),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function message(id: string, overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    id,
    groupId: "g-1",
    authorKind: "user",
    kind: "message",
    body: `message ${id}`,
    mentions: [],
    createdAt: `2026-01-01T00:00:${id.padStart(5, "0")}`,
    ...overrides,
  };
}

let listeners: Array<(event: GroupRuntimeEvent) => void>;
let updateListeners: Array<(state: UpdateState) => void>;
let pages: GroupMessage[][];
let updateState: UpdateState;
let tasks: GroupTask[];
const group = {
  listMessages: vi.fn(async (_input: unknown) => pages.shift() ?? []),
  postMessage: vi.fn(async (input: { groupId: string; body: string }) =>
    message("posted", { body: input.body }),
  ),
  stop: vi.fn(async (_groupId: string) => undefined),
  listTasks: vi.fn(async (_groupId: string) => tasks),
  cancelTask: vi.fn(async (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId) as GroupTask;
    return { ...task, status: "cancelled" as const };
  }),
  onEvent: vi.fn((listener: (event: GroupRuntimeEvent) => void) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((item) => item !== listener);
    };
  }),
};
const update = {
  getState: vi.fn(async () => updateState),
  onStateChange: vi.fn((listener: (state: UpdateState) => void) => {
    updateListeners.push(listener);
    return () => undefined;
  }),
};

beforeEach(() => {
  listeners = [];
  updateListeners = [];
  pages = [];
  updateState = { status: "idle" };
  tasks = [];
  for (const fn of [...Object.values(group), ...Object.values(update)]) fn.mockClear();
  Object.assign(window, { modus: { group, update } });
});

afterEach(() => cleanup());

function states(entry?: Partial<GroupMemberStates>): GroupMemberStatesById {
  if (!entry) return new Map();
  return new Map([
    [
      "g-1",
      {
        groupId: "g-1",
        runningSessionIds: [],
        queuedSessionIds: [],
        waitingSessionIds: [],
        ...entry,
      },
    ],
  ]);
}

function renderRoom(memberStates: GroupMemberStatesById = states(), onOpenMember = vi.fn()) {
  const view = render(
    <GroupRoom
      group={GROUP}
      memberSessionIds={new Set(SESSIONS.map((s) => s.id))}
      memberStates={memberStates}
      onDelete={vi.fn()}
      onOpenMember={onOpenMember}
      onRename={vi.fn()}
      onUpdateMembers={vi.fn(async () => undefined)}
      sessions={SESSIONS}
      workspaces={WORKSPACES}
    />,
  );
  return { ...view, onOpenMember };
}

const emit = (event: GroupRuntimeEvent) =>
  act(() => {
    for (const listener of listeners) listener(event);
  });

describe("GroupRoom", () => {
  it("shows the header (name, Project badge, chips with Lead) and the empty state", async () => {
    renderRoom();
    expect(await screen.findByText(GROUP_ROOM_EMPTY_TEXT)).toBeTruthy();
    const header = screen.getByTestId("group-room-header");
    expect(within(header).getByText("Release squad")).toBeTruthy();
    expect(screen.getByTestId("group-project-badge").textContent).toBe("Repo");
    const chips = screen.getAllByTestId("group-member-chip");
    // A repeated title gets the muted short id suffix; unique titles stay plain.
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "PlannerLead",
      "Reviewer · srev1",
      "Reviewer · srev2",
    ]);
    expect(within(chips[1] as HTMLElement).getByTestId("member-id-suffix").className).toContain(
      "text-fg-faint",
    );
    expect(within(chips[0] as HTMLElement).queryByTestId("member-id-suffix")).toBeNull();
    expect(group.listMessages).toHaveBeenCalledWith({ groupId: "g-1", limit: GROUP_MESSAGE_PAGE });
    // No member running: no Stop button.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("renders user, member and status messages, with mentions as chips", async () => {
    pages = [
      [
        message("1", { body: "@Planner ship it" }),
        message("2", {
          authorKind: "agent",
          authorSessionId: "s-lead",
          body: "On it, **bold** @s-rev-1 please review",
        }),
        message("3", {
          authorKind: "agent",
          authorSessionId: "s-rev-1",
          kind: "status",
          body: "Waiting for you",
        }),
        message("4", { authorKind: "system", kind: "status", body: "Turn failed" }),
      ],
    ];
    renderRoom();
    const rows = await screen.findAllByTestId("group-message");
    expect(rows.map((row) => row.dataset.kind)).toEqual(["user", "member", "status", "status"]);
    const [userRow, memberRow, memberStatus, systemStatus] = rows as HTMLElement[];
    expect(userRow?.className).toContain("justify-end");
    expect(within(userRow as HTMLElement).getByTestId("mention-chip").textContent).toBe("@Planner");
    expect(within(memberRow as HTMLElement).getByText("Planner")).toBeTruthy();
    expect(within(memberRow as HTMLElement).getByText("P")).toBeTruthy();
    // Same markdown renderer as the chat, mention as a chip (title + short id when repeated).
    await within(memberRow as HTMLElement).findByText("bold", {}, { timeout: 15_000 });
    expect(memberRow?.textContent).not.toContain("**");
    expect(within(memberRow as HTMLElement).getByTestId("mention-chip").textContent).toBe(
      "@Reviewer · srev1",
    );
    expect(memberStatus?.textContent).toBe("Reviewer · srev1 · Waiting for you");
    expect(systemStatus?.textContent).toBe("Turn failed");
    // The lazy markdown renderer can take a few seconds to load under a full run.
  }, 30_000);

  it("status lines format inline code only; Waiting for you lines are amber", async () => {
    pages = [
      [
        message("1", {
          authorKind: "agent",
          authorSessionId: "s-lead",
          kind: "status",
          body: "Worktree ready: `modus/group/p1` **not bold**",
        }),
        message("2", {
          authorKind: "agent",
          authorSessionId: "s-rev-1",
          kind: "status",
          body: "Waiting for you",
        }),
        message("3", {
          authorKind: "system",
          kind: "status",
          body: "Waiting for you: this chain reached its limit of 6 turns.",
        }),
        message("4", { authorKind: "system", kind: "status", body: "Turn failed" }),
      ],
    ];
    renderRoom();
    const rows = (await screen.findAllByTestId("group-message")) as HTMLElement[];
    const code = within(rows[0] as HTMLElement).getByText("modus/group/p1");
    expect(code.tagName).toBe("CODE");
    // Only inline code: the rest stays literal text.
    expect(rows[0]?.textContent).toBe("Planner · Worktree ready: modus/group/p1 **not bold**");
    const amber = rows.map((row) => Boolean(row.querySelector(".text-amber-400")));
    expect(amber).toEqual([false, true, true, false]);
  });

  it("loads older pages on scroll to top and merges live events without duplicates", async () => {
    const newest = Array.from({ length: GROUP_MESSAGE_PAGE }, (_, i) => message(String(i + 100)));
    const older = Array.from({ length: 10 }, (_, i) => message(String(i + 10)));
    pages = [newest, older];
    renderRoom();
    expect(await screen.findAllByTestId("group-message")).toHaveLength(50);
    fireEvent.scroll(screen.getByTestId("group-message-list"), { target: { scrollTop: 0 } });
    await vi.waitFor(() => expect(screen.getAllByTestId("group-message")).toHaveLength(60));
    expect(group.listMessages).toHaveBeenLastCalledWith({
      groupId: "g-1",
      before: { createdAt: newest[0]?.createdAt, id: "100" },
      limit: GROUP_MESSAGE_PAGE,
    });
    // A short page: no more loads.
    fireEvent.scroll(screen.getByTestId("group-message-list"), { target: { scrollTop: 0 } });
    expect(group.listMessages).toHaveBeenCalledTimes(2);

    const live = message("900", { body: "live one" });
    emit({ type: "group.message", groupId: "g-1", message: live });
    emit({ type: "group.message", groupId: "g-1", message: live });
    emit({ type: "group.message", groupId: "g-1", message: newest[3] as GroupMessage });
    emit({ type: "group.message", groupId: "g-other", message: message("901") });
    const rows = screen.getAllByTestId("group-message");
    expect(rows).toHaveLength(61);
    expect(rows.at(-1)?.textContent).toBe("live one");
  });

  it("chip dots follow member states; clicking a chip opens that member's chat", async () => {
    const user = userEvent.setup();
    const { onOpenMember } = renderRoom(
      states({ runningSessionIds: ["s-lead"], waitingSessionIds: ["s-rev-2"] }),
    );
    const chips = screen.getAllByTestId("group-member-chip");
    expect(chips.map((chip) => chip.dataset.state)).toEqual(["working", "idle", "waiting"]);
    expect(within(chips[2] as HTMLElement).getByTestId("waiting-dot")).toBeTruthy();
    expect(within(chips[0] as HTMLElement).getByTitle("Agent running")).toBeTruthy();
    expect(within(chips[1] as HTMLElement).queryByTitle(/running|Waiting/)).toBeNull();
    await user.click(chips[1] as HTMLElement);
    expect(onOpenMember).toHaveBeenCalledWith(SESSIONS[1]);
  });

  it("shows Stop only while a member runs, and stops the group", async () => {
    const user = userEvent.setup();
    const view = renderRoom(states({ waitingSessionIds: ["s-lead"] }));
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    view.rerender(
      <GroupRoom
        group={GROUP}
        memberSessionIds={new Set()}
        memberStates={states({ runningSessionIds: ["s-lead"] })}
        onDelete={vi.fn()}
        onOpenMember={vi.fn()}
        onRename={vi.fn()}
        onUpdateMembers={vi.fn(async () => undefined)}
        sessions={SESSIONS}
        workspaces={WORKSPACES}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(group.stop).toHaveBeenCalledWith("g-1");
  });

  it("Enter sends, Shift+Enter adds a line; @ autocompletes, a shared title inserts the id", async () => {
    const user = userEvent.setup();
    renderRoom();
    const input = screen.getByRole("textbox", { name: "Message the group" }) as HTMLTextAreaElement;
    await user.type(input, "hi @Pl");
    const list = screen.getByTestId("mention-suggestions");
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Planner"]);
    await user.keyboard("{Enter}");
    expect(input.value).toBe("hi @Planner ");
    expect(group.postMessage).not.toHaveBeenCalled();

    await user.type(input, "and @Rev");
    const options = within(screen.getByTestId("mention-suggestions")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Reviewer · srev1", "Reviewer · srev2"]);
    await user.click(options[1] as HTMLElement);
    expect(input.value).toBe("hi @Planner and @s-rev-2 ");

    await user.keyboard("{Shift>}{Enter}{/Shift}line two");
    expect(input.value).toBe("hi @Planner and @s-rev-2 \nline two");
    await user.keyboard("{Enter}");
    expect(group.postMessage).toHaveBeenCalledWith({
      groupId: "g-1",
      body: "hi @Planner and @s-rev-2 \nline two",
    });
    await vi.waitFor(() => expect(input.value).toBe(""));
  });

  it('shows "Paused while Modus updates" while an update is pending; sending still saves', async () => {
    const user = userEvent.setup();
    updateState = { status: "waiting-for-agents", version: "1.3.0" };
    renderRoom();
    expect((await screen.findByTestId("group-update-banner")).textContent).toContain(
      "Paused while Modus updates",
    );
    await user.type(screen.getByRole("textbox", { name: "Message the group" }), "later{Enter}");
    expect(group.postMessage).toHaveBeenCalledWith({ groupId: "g-1", body: "later" });
    act(() => {
      for (const listener of updateListeners) listener({ status: "idle" });
    });
    expect(screen.queryByTestId("group-update-banner")).toBeNull();
  });

  it("task panel: closed by default with a counter, grouped by status, Cancelled collapsed", async () => {
    const user = userEvent.setup();
    const task = (id: string, status: GroupTask["status"], extra: Partial<GroupTask> = {}) => ({
      id,
      groupId: "g-1",
      title: `Task ${id}`,
      status,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...extra,
    });
    tasks = [
      task("1", "open"),
      task("2", "in_progress", { ownerSessionId: "s-lead", branch: "modus/group/p1" }),
      task("3", "in_review", { ownerSessionId: "s-lead", reviewerSessionId: "s-rev-1" }),
      task("4", "done"),
      task("5", "cancelled"),
    ];
    renderRoom();
    expect(screen.queryByTestId("group-task-panel")).toBeNull();
    await vi.waitFor(() => expect(screen.getByTestId("group-task-count").textContent).toBe("3"));
    await user.click(screen.getByRole("button", { name: "Tasks (3 active)" }));
    const panel = screen.getByTestId("group-task-panel");
    expect(
      within(panel)
        .getAllByTestId("task-section")
        .map((section) => section.dataset.status),
    ).toEqual(["open", "in_progress", "in_review", "done", "cancelled"]);
    // Cancelled starts collapsed.
    expect(within(panel).queryByText("Task 5")).toBeNull();
    await user.click(within(panel).getByRole("button", { name: /Cancelled/ }));
    expect(within(panel).getByText("Task 5")).toBeTruthy();

    const cards = within(panel).getAllByTestId("group-task");
    const review = cards.find((card) => card.textContent?.includes("Task 3")) as HTMLElement;
    expect(review.textContent).toContain("OwnerPlanner");
    expect(review.textContent).toContain("ReviewerReviewer");
    const working = cards.find((card) => card.textContent?.includes("Task 2")) as HTMLElement;
    expect(within(working).getByText("modus/group/p1")).toBeTruthy();
    expect(within(working).getByRole("button", { name: "Copy branch" })).toBeTruthy();
    // Done and cancelled tasks have no action.
    for (const id of ["4", "5"]) {
      const card = cards.find((item) => item.textContent?.includes(`Task ${id}`)) as HTMLElement;
      expect(within(card).queryByRole("button", { name: "Cancel task" })).toBeNull();
    }
  });

  it('"Cancel task" needs two clicks and moves the task to Cancelled', async () => {
    const user = userEvent.setup();
    tasks = [
      {
        id: "t-1",
        groupId: "g-1",
        title: "Parser",
        status: "open",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    renderRoom();
    await vi.waitFor(() => expect(screen.getByTestId("group-task-count").textContent).toBe("1"));
    await user.click(screen.getByRole("button", { name: /^Tasks/ }));
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    expect(group.cancelTask).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: CANCEL_TASK_CONFIRM_LABEL }));
    expect(group.cancelTask).toHaveBeenCalledWith("t-1");
    await vi.waitFor(() => expect(screen.getByTestId("group-task-count").textContent).toBe("0"));
    const section = screen.getByTestId("task-section");
    expect(section.dataset.status).toBe("cancelled");
  });
});
