// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentGroupWithMembers,
  AgentSessionInfo,
  GroupDecision,
  GroupMemberStates,
  GroupMessage,
  GroupRuntimeEvent,
  GroupTask,
  UpdateState,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import { formatClock } from "../../lib/formatClock";
import {
  DECISIONS_EMPTY_TEXT,
  DELETE_DECISION_CONFIRM_LABEL,
  FORMER_MEMBER_TEXT,
} from "./GroupDecisions";
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
    agentId: `agent-${s.id}`,
    name: s.title,
    agentRole: "",
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
let decisions: GroupDecision[];
const group = {
  listMessages: vi.fn(async (_input: unknown) => pages.shift() ?? []),
  postMessage: vi.fn(async (input: { groupId: string; body: string }) =>
    message("posted", { body: input.body }),
  ),
  resumeExecution: vi.fn(async (_input: unknown) => undefined),
  stop: vi.fn(async (_groupId: string) => undefined),
  listTasks: vi.fn(async (_groupId: string) => tasks),
  cancelTask: vi.fn(async (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId) as GroupTask;
    return { ...task, status: "cancelled" as const };
  }),
  listDecisions: vi.fn(async (_groupId: string) => decisions),
  deleteDecision: vi.fn(async (decisionId: string) => {
    const decision = decisions.find((item) => item.id === decisionId) as GroupDecision;
    decisions = decisions.filter((item) => item.id !== decisionId);
    return decision;
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
const agents = {
  list: vi.fn(async () =>
    GROUP.members.map((member) => ({
      id: member.agentId,
      groupId: GROUP.id,
      name: member.name,
      role: member.agentRole,
      instructions: "",
      avatarFace: "happy" as const,
      avatarColor: "sky" as const,
      avatarShape: "circle" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  ),
  update: vi.fn(async () => undefined),
  generateProfile: vi.fn(async () => ({
    role: "Generalist",
    instructions: "Help.",
    generated: false,
  })),
};

beforeEach(() => {
  listeners = [];
  updateListeners = [];
  pages = [];
  updateState = { status: "idle" };
  tasks = [];
  decisions = [];
  for (const fn of [...Object.values(group), ...Object.values(update), ...Object.values(agents)])
    fn.mockClear();
  Object.assign(window, { modus: { group, update, agents } });
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

function renderRoom(
  memberStates: GroupMemberStatesById = states(),
  onOpenMember = vi.fn(),
  roomGroup: AgentGroupWithMembers = GROUP,
  onSetMode = vi.fn(),
  onChooseFolder = vi.fn(),
) {
  const view = render(
    <GroupRoom
      group={roomGroup}
      memberStates={memberStates}
      onDelete={vi.fn()}
      onOpenMember={onOpenMember}
      onRename={vi.fn()}
      onSetMode={onSetMode}
      onChooseFolder={onChooseFolder}
      onUpdateMembers={vi.fn(async () => undefined)}
      workspaces={WORKSPACES}
    />,
  );
  return { ...view, onOpenMember, onSetMode, onChooseFolder };
}

const emit = (event: GroupRuntimeEvent) =>
  act(() => {
    for (const listener of listeners) listener(event);
  });

describe("GroupRoom", () => {
  it("shows one compact presence surface while members work", async () => {
    renderRoom(states({ runningSessionIds: ["s-lead"] }));
    expect(await screen.findByTestId("group-working-status")).toBeTruthy();
    expect(screen.queryByTestId("group-working-shimmer")).toBeNull();
    expect(screen.queryByTestId("group-live-writing")).toBeNull();
  });

  it("clears reply and composer state when navigating to another group", async () => {
    pages = [[message("original", { body: "Original room message" })]];
    const view = renderRoom();
    const user = userEvent.setup();
    await screen.findByText("Original room message");
    await user.click(screen.getByTestId("group-message-reply"));
    await user.type(screen.getByRole("textbox", { name: "Message the group" }), "Private draft");
    expect(screen.getByTestId("group-composer-reply").textContent).toContain(
      "Original room message",
    );
    view.rerender(
      <GroupRoom
        group={{ ...GROUP, id: "g-2", name: "Another group" }}
        memberStates={states()}
        onDelete={vi.fn()}
        onOpenMember={vi.fn()}
        onRename={vi.fn()}
        onUpdateMembers={vi.fn(async () => undefined)}
        workspaces={WORKSPACES}
      />,
    );
    await screen.findByText("Another group");
    expect(screen.queryByTestId("group-composer-reply")).toBeNull();
    expect(
      (screen.getByRole("textbox", { name: "Message the group" }) as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("explicitly resumes an interrupted task by execution id", async () => {
    pages = [
      [
        message("interrupted", {
          authorKind: "agent",
          authorSessionId: "s-lead",
          body: "Saved progress",
          status: "interrupted",
          error: "App restarted",
          turnId: "exec-1",
        }),
      ],
    ];
    renderRoom();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Resume task" }));
    expect(group.resumeExecution).toHaveBeenCalledWith({
      groupId: "g-1",
      executionId: "exec-1",
    });
    expect(group.postMessage).not.toHaveBeenCalled();
    expect(screen.getByText("Interrupted")).toBeTruthy();
    expect(screen.getByText("Saved progress")).toBeTruthy();
  });

  it("shows the header (name, Project badge, Agents control) and the empty state", async () => {
    renderRoom();
    expect(await screen.findByText(GROUP_ROOM_EMPTY_TEXT)).toBeTruthy();
    const header = screen.getByTestId("group-room-header");
    expect(within(header).getByText("Release squad")).toBeTruthy();
    expect(screen.getByTestId("group-project-badge").textContent).toBe("Repo");
    expect(screen.getByTestId("group-agents-button").textContent).toContain("Agents");
    expect(screen.getByTestId("group-agents-button").textContent).toContain("3");
    expect(screen.queryByTestId("group-member-chip")).toBeNull();
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
    expect(within(userRow as HTMLElement).getByText("You")).toBeTruthy();
    expect(within(userRow as HTMLElement).getByText("Human")).toBeTruthy();
    expect(within(userRow as HTMLElement).getByTestId("group-user-avatar")).toBeTruthy();
    expect(within(userRow as HTMLElement).getByTestId("mention-chip").textContent).toBe("@Planner");
    expect(within(memberRow as HTMLElement).getByText("Planner")).toBeTruthy();
    // The author's avatar (A3): still in a list, the member's face and color.
    const authorAvatar = within(memberRow as HTMLElement).getByTestId("agent-avatar");
    expect(authorAvatar.dataset.size).toBe("20");
    expect(authorAvatar.dataset.animated).toBe("false");
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

  it("keeps the room header on a single compact row", async () => {
    renderRoom();
    await screen.findByText(GROUP_ROOM_EMPTY_TEXT);
    const header = screen.getByTestId("group-room-header");
    expect(header.dataset.singleRow).toBe("true");
    const row = screen.getByTestId("group-room-header-row");
    expect(within(row).getByText("Release squad")).toBeTruthy();
    expect(within(row).getByTestId("group-project-badge")).toBeTruthy();
    expect(within(row).getByTestId("group-agents-button")).toBeTruthy();
    expect(within(row).getByText("Activity")).toBeTruthy();
    // No dedicated second header row for member chips / stage.
    expect(header.querySelectorAll('[data-testid="group-room-header-row"]')).toHaveLength(1);
    expect(screen.queryByTestId("group-member-chip")).toBeNull();
    expect(screen.queryByTestId("group-stage-chip")).toBeNull();
  });

  it("portals the header into window chrome (no second internal bar)", async () => {
    function Harness() {
      const [host, setHost] = useState<HTMLElement | null>(null);
      return (
        <div>
          <div data-testid="fake-window-chrome" ref={setHost} />
          {host ? (
            <GroupRoom
              chromeHost={host}
              group={GROUP}
              memberStates={states()}
              onDelete={vi.fn()}
              onOpenMember={vi.fn()}
              onRename={vi.fn()}
              onSetMode={vi.fn()}
              onChooseFolder={vi.fn()}
              onUpdateMembers={vi.fn(async () => undefined)}
              workspaces={WORKSPACES}
            />
          ) : null}
        </div>
      );
    }
    render(<Harness />);
    await screen.findByText(GROUP_ROOM_EMPTY_TEXT);
    const chrome = screen.getByTestId("fake-window-chrome");
    const header = within(chrome).getByTestId("group-room-header");
    expect(header.dataset.variant).toBe("chrome");
    const room = screen.getByTestId("group-room");
    expect(within(room).queryByTestId("group-room-header")).toBeNull();
  });

  it("status lines format inline code only; active Waiting for you lines are amber", async () => {
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
    // Only s-rev-1 is actively waiting — historical Waiting lines stay faint.
    // Worktree ops stay off the main transcript (Activity / Details).
    renderRoom(states({ waitingSessionIds: ["s-rev-1"] }));
    const rows = (await screen.findAllByTestId("group-message")) as HTMLElement[];
    expect(rows).toHaveLength(3);
    expect(screen.queryByText("modus/group/p1")).toBeNull();
    expect(rows[0]?.dataset.waitingActive).toBe("true");
    expect(rows[0]?.querySelector(".text-amber-400")).toBeTruthy();
    expect(rows[0]?.getAttribute("data-prompt-kit")).toBe("system-message");
    // System limit line has no authorSessionId → not active amber from member wait.
    expect(rows[1]?.dataset.waitingActive).toBeUndefined();
    expect(rows[2]?.querySelector(".text-amber-400")).toBeNull();
  });

  it("does not amber-highlight stale Waiting for you when the member is idle", async () => {
    pages = [
      [
        message("1", {
          authorKind: "agent",
          authorSessionId: "s-lead",
          kind: "status",
          body: "Waiting for you",
        }),
      ],
    ];
    renderRoom(states()); // no waitingSessionIds
    const row = (await screen.findByTestId("group-message")) as HTMLElement;
    expect(row.dataset.waitingStale).toBe("true");
    expect(row.querySelector(".text-amber-400")).toBeNull();
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
    await vi.waitFor(() => expect(screen.getAllByTestId("group-message")).toHaveLength(61));
    const rows = screen.getAllByTestId("group-message");
    expect(rows).toHaveLength(61);
    expect(rows.at(-1)?.textContent).toContain("live one");
    expect(rows.at(-1)?.dataset.kind).toBe("user");
  });

  it("join / leave lines arrive live through group.message, without a reload (A3)", async () => {
    pages = [[message("1", { body: "hello" })]];
    renderRoom();
    expect(await screen.findAllByTestId("group-message")).toHaveLength(1);
    const joined = message("2", {
      authorKind: "system",
      kind: "status",
      body: "Cy joined as Scribe",
    });
    const left = message("3", { authorKind: "system", kind: "status", body: "Cy left the group" });
    emit({ type: "group.message", groupId: "g-1", message: joined });
    emit({ type: "group.message", groupId: "g-1", message: left });
    await vi.waitFor(() => expect(screen.getAllByTestId("group-message")).toHaveLength(3));
    const rows = screen.getAllByTestId("group-message");
    expect(rows.map((row) => row.textContent)).toEqual([
      "YYouHumanhello",
      "Cy joined as Scribe",
      "Cy left the group",
    ]);
    expect(rows.slice(1).map((row) => row.dataset.kind)).toEqual(["status", "status"]);
    expect(rows[0]?.dataset.kind).toBe("user");
    // Only the first page was fetched: the lines came from the push.
    expect(group.listMessages).toHaveBeenCalledTimes(1);
  });

  it("Agents popover lists members with Lead, status and open-chat action", async () => {
    const user = userEvent.setup();
    const onOpenAgentChat = vi.fn();
    render(
      <GroupRoom
        group={{
          ...GROUP,
          members: GROUP.members.map((member, index) =>
            index === 1
              ? { ...member, avatarFace: "wink", avatarColor: "lime", archived: true }
              : { ...member, avatarFace: "happy", avatarColor: "sky" },
          ),
        }}
        memberStates={states({ runningSessionIds: ["s-lead"], waitingSessionIds: ["s-rev-2"] })}
        onDelete={vi.fn()}
        onOpenAgentChat={onOpenAgentChat}
        onOpenMember={vi.fn()}
        onRename={vi.fn()}
        onUpdateMembers={vi.fn(async () => undefined)}
        workspaces={WORKSPACES}
      />,
    );
    expect(screen.getByTestId("group-activity-dots")).toBeTruthy();
    await user.click(screen.getByTestId("group-agents-button"));
    const panel = await screen.findByTestId("group-agents-popover");
    const rows = within(panel).getAllByTestId("group-agents-member");
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText("Lead")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(/archived/)).toBeTruthy();
    await user.click(within(rows[1] as HTMLElement).getByTestId("group-agent-open-chat"));
    expect(onOpenAgentChat).toHaveBeenCalledWith("agent-s-rev-1");
  });

  it("keeps Stop available while a member waits or runs, and stops the group", async () => {
    const user = userEvent.setup();
    const view = renderRoom(states({ waitingSessionIds: ["s-lead"] }));
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    view.rerender(
      <GroupRoom
        group={GROUP}
        memberStates={states({ runningSessionIds: ["s-lead"] })}
        onDelete={vi.fn()}
        onOpenMember={vi.fn()}
        onRename={vi.fn()}
        onUpdateMembers={vi.fn(async () => undefined)}
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
    expect(screen.getByTestId("group-update-banner").textContent).toContain(
      "Pending tasks resume after restart",
    );
    expect(screen.getByTestId("group-update-banner").textContent).toContain(
      "Interrupted runs stay visible",
    );
    await user.type(screen.getByRole("textbox", { name: "Message the group" }), "later{Enter}");
    expect(group.postMessage).toHaveBeenCalledWith({ groupId: "g-1", body: "later" });
    act(() => {
      for (const listener of updateListeners) listener({ status: "idle" });
    });
    expect(screen.queryByTestId("group-update-banner")).toBeNull();
  });

  it("task panel: closed by default with a counter, checklist + Spring Check, cancelled hidden", async () => {
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
    expect(screen.queryByTestId("group-activity-panel")).toBeNull();
    await vi.waitFor(() => expect(screen.getByTestId("group-task-count").textContent).toBe("3"));
    await user.click(screen.getByRole("button", { name: "Activity (3 active)" }));
    const panel = screen.getByTestId("group-activity-panel");
    expect(within(panel).getByTestId("task-checklist-progress").textContent).toContain("1/4 done");
    expect(within(panel).getByTestId("task-checklist")).toBeTruthy();
    // Cancelled starts hidden.
    expect(within(panel).queryByText("Task 5")).toBeNull();
    await user.click(within(panel).getByRole("button", { name: /Show cancelled/ }));
    expect(within(panel).getByText("Task 5")).toBeTruthy();

    const rows = within(panel).getAllByTestId("group-task");
    const review = rows.find((row) => row.textContent?.includes("Task 3")) as HTMLElement;
    expect(review.dataset.status).toBe("in_review");
    expect(within(review).getByTestId("task-status-badge").textContent).toBe("In review");
    expect(review.textContent).toContain("Planner");
    const done = rows.find((row) => row.textContent?.includes("Task 4")) as HTMLElement;
    expect(within(done).getByTestId("spring-check").querySelector("input")?.checked).toBe(true);
    // Done and cancelled tasks have no cancel action.
    for (const id of ["4", "5"]) {
      const row = rows.find((item) => item.textContent?.includes(`Task ${id}`)) as HTMLElement;
      expect(within(row).queryByRole("button", { name: "Cancel task" })).toBeNull();
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
    await user.click(screen.getByRole("button", { name: /^Activity/ }));
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    expect(group.cancelTask).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: CANCEL_TASK_CONFIRM_LABEL }));
    expect(group.cancelTask).toHaveBeenCalledWith("t-1");
    await vi.waitFor(() => expect(screen.getByTestId("group-task-count").textContent).toBe("0"));
    // Cancelled is hidden until expanded.
    expect(screen.queryByText("Parser")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Show cancelled/ }));
    const row = screen.getByTestId("group-task");
    expect(row.dataset.status).toBe("cancelled");
  });
});

describe("GroupRoom decisions", () => {
  const decision = (id: string, text: string, extra: Partial<GroupDecision> = {}) => ({
    id,
    groupId: "g-1",
    text,
    createdAt: `2026-01-0${id}T10:00:00.000Z`,
    ...extra,
  });

  async function openPanel(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /^Activity/ }));
    return screen.getByTestId("group-activity-panel");
  }

  it("shows Decisions (newest first) with a counter above the checklist; the header stays Activity N", async () => {
    const user = userEvent.setup();
    decisions = [
      decision("3", "Ship on Fridays", { authorSessionId: "s-rev-1" }),
      decision("2", "Use SQLite", { authorSessionId: "s-lead" }),
      decision("1", "Keep the API stable"),
      decision("0", "Pin deps", { authorSessionId: "s-gone" }),
    ];
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
    // Decisions load only with the panel.
    expect(group.listDecisions).not.toHaveBeenCalled();
    const panel = await openPanel(user);
    expect(screen.getByRole("button", { name: "Activity (1 active)" }).textContent).toBe(
      "Activity1",
    );
    await vi.waitFor(() =>
      expect(within(panel).getByTestId("decision-count").textContent).toBe("4"),
    );
    expect(group.listDecisions).toHaveBeenCalledWith("g-1");
    // Coordination precedes Decisions; Decisions precedes the checklist.
    const coordination = within(panel).getByTestId("group-activity-coordination");
    const section = within(panel).getByTestId("decision-section");
    expect(panel.firstElementChild).toBe(coordination);
    expect(
      coordination.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      section.compareDocumentPosition(within(panel).getByTestId("task-checklist")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const cards = within(section).getAllByTestId("group-decision");
    expect(cards.map((card) => card.firstElementChild?.textContent)).toEqual([
      "Ship on Fridays",
      "Use SQLite",
      "Keep the API stable",
      "Pin deps",
    ]);
    const authors = within(section).getAllByTestId("decision-author");
    // A repeated title keeps its short id suffix; no author (session deleted) or an
    // author no longer in the group is a former member, faded, never "You".
    expect(authors.map((author) => author.textContent)).toEqual([
      "Reviewer · srev1",
      "Planner",
      FORMER_MEMBER_TEXT,
      FORMER_MEMBER_TEXT,
    ]);
    for (const author of authors.slice(2)) {
      expect(author.querySelector(".text-fg-faint")?.textContent).toBe(FORMER_MEMBER_TEXT);
    }
    expect(within(authors[0] as HTMLElement).getByTestId("member-id-suffix")).toBeTruthy();
    const time = cards[1]?.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-01-02T10:00:00.000Z");
    expect(time?.textContent).toBe(formatClock(Date.parse("2026-01-02T10:00:00.000Z")));

    // Collapsible (starts open).
    const toggle = within(section).getByRole("button", { name: /Decisions/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(section).queryAllByTestId("group-decision")).toHaveLength(0);
    expect(within(section).getByTestId("decision-count").textContent).toBe("4");
    await user.click(toggle);
    expect(within(section).getAllByTestId("group-decision")).toHaveLength(4);
  });

  it(`shows "${DECISIONS_EMPTY_TEXT}" when the group has none`, async () => {
    const user = userEvent.setup();
    renderRoom();
    const panel = await openPanel(user);
    await vi.waitFor(() => expect(group.listDecisions).toHaveBeenCalled());
    const section = within(panel).getByTestId("decision-section");
    expect(within(section).getByText(DECISIONS_EMPTY_TEXT)).toBeTruthy();
    expect(within(section).getByTestId("decision-count").textContent).toBe("0");
  });

  it('"Delete" needs two clicks, removes the decision and posts nothing', async () => {
    const user = userEvent.setup();
    decisions = [decision("2", "Use SQLite", { authorSessionId: "s-lead" }), decision("1", "Old")];
    renderRoom();
    const panel = await openPanel(user);
    await vi.waitFor(() => expect(within(panel).getAllByTestId("group-decision")).toHaveLength(2));
    const [first] = within(panel).getAllByTestId("group-decision");
    await user.click(within(first as HTMLElement).getByRole("button", { name: "Delete" }));
    expect(group.deleteDecision).not.toHaveBeenCalled();
    await user.click(
      within(first as HTMLElement).getByRole("button", { name: DELETE_DECISION_CONFIRM_LABEL }),
    );
    expect(group.deleteDecision).toHaveBeenCalledWith("2");
    await vi.waitFor(() =>
      expect(within(panel).getByTestId("decision-count").textContent).toBe("1"),
    );
    expect(within(panel).queryByText("Use SQLite")).toBeNull();
    expect(within(panel).getByText("Old")).toBeTruthy();
    expect(group.postMessage).not.toHaveBeenCalled();
  });

  it("a failed delete shows the error and keeps the decision", async () => {
    const user = userEvent.setup();
    decisions = [decision("1", "Use SQLite")];
    group.deleteDecision.mockImplementationOnce(async () => {
      throw new Error("[group-error:decision-not-found] Group decision not found: 1");
    });
    renderRoom();
    const panel = await openPanel(user);
    await vi.waitFor(() => expect(within(panel).getByText("Use SQLite")).toBeTruthy());
    await user.click(within(panel).getByRole("button", { name: "Delete" }));
    await user.click(within(panel).getByRole("button", { name: DELETE_DECISION_CONFIRM_LABEL }));
    expect(await within(panel).findByText("That decision no longer exists.")).toBeTruthy();
    expect(within(panel).getByText("Use SQLite")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("reloads on group.message and group.activity of this group only", async () => {
    const user = userEvent.setup();
    renderRoom();
    const panel = await openPanel(user);
    await vi.waitFor(() => expect(group.listDecisions).toHaveBeenCalledTimes(1));
    decisions = [decision("1", "Use SQLite", { authorSessionId: "s-lead" })];
    await emit({ type: "group.message", groupId: "g-1", message: message("9") });
    await vi.waitFor(() => expect(within(panel).getByText("Use SQLite")).toBeTruthy());
    decisions = [decision("2", "Ship weekly"), ...decisions];
    await emit({ type: "group.activity", groupId: "g-2" } as GroupRuntimeEvent);
    expect(group.listDecisions).toHaveBeenCalledTimes(2);
    await emit({ type: "group.activity", groupId: "g-1" } as GroupRuntimeEvent);
    await vi.waitFor(() =>
      expect(within(panel).getByTestId("decision-count").textContent).toBe("2"),
    );
  });
});

describe("GroupRoom coordinator mode", () => {
  async function openMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Group actions" }));
    return screen.findByRole("menuitemcheckbox", { name: /Coordinator mode/ });
  }

  it("the menu toggle turns it on; Coordinator stays out of the primary header", async () => {
    const user = userEvent.setup();
    const { onSetMode } = renderRoom();
    expect(screen.queryByTestId("group-coordinator-badge")).toBeNull();
    const toggle = await openMenu(user);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("aria-disabled")).not.toBe("true");
    await user.click(toggle);
    expect(onSetMode).toHaveBeenCalledWith("coordinator");
  });

  it("with the mode on and a Lead: Activity shows Coordinator; menu toggle turns it off", async () => {
    const user = userEvent.setup();
    const { onSetMode } = renderRoom(states(), vi.fn(), { ...GROUP, mode: "coordinator" });
    expect(screen.queryByTestId("group-coordinator-badge")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Activity/ }));
    expect(screen.getByTestId("group-activity-coordinator-status").textContent).toBe(
      "Coordinator on",
    );
    const toggle = await openMenu(user);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    expect(onSetMode).toHaveBeenCalledWith("free");
  });

  it("without a Lead the stored flag is ignored: Free in Activity, toggle off and disabled", async () => {
    const user = userEvent.setup();
    const { leadSessionId: _lead, ...leaderless } = GROUP;
    const { onSetMode } = renderRoom(states(), vi.fn(), { ...leaderless, mode: "coordinator" });
    expect(screen.queryByTestId("group-coordinator-badge")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Activity/ }));
    expect(screen.getByTestId("group-activity-coordinator-status").textContent).toBe(
      "Free collaboration",
    );
    const toggle = await openMenu(user);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.textContent).toContain("Needs a Lead");
    await user.click(toggle);
    expect(onSetMode).not.toHaveBeenCalled();
  });
});

describe("GroupRoom blocked groups", () => {
  it.each([
    ["no workspace", undefined],
    ["the Chats inbox", "modus-inbox-chats"],
  ])("a group with %s shows 'Choose a folder to continue this group' instead of the composer", async (_label, workspaceId) => {
    const user = userEvent.setup();
    const { workspaceId: _drop, ...rest } = GROUP;
    const roomGroup: AgentGroupWithMembers = { ...rest, ...(workspaceId ? { workspaceId } : {}) };
    const { onChooseFolder } = renderRoom(states(), vi.fn(), roomGroup);
    const banner = await screen.findByTestId("group-blocked-banner");
    expect(banner.textContent).toContain("Choose a folder to continue this group");
    expect(screen.queryByRole("textbox", { name: /message/i })).toBeNull();
    await user.click(within(banner).getByRole("button", { name: "Choose folder" }));
    expect(onChooseFolder).toHaveBeenCalledTimes(1);
    expect(group.postMessage).not.toHaveBeenCalled();
  });

  it("a group left with one agent shows 'Add a member to continue' and opens Manage members", async () => {
    const user = userEvent.setup();
    renderRoom(states(), vi.fn(), { ...GROUP, members: GROUP.members.slice(0, 1) });
    const banner = await screen.findByTestId("group-blocked-banner");
    expect(banner.textContent).toContain("Add a member to continue");
    await user.click(within(banner).getByRole("button", { name: "Add agent" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("a working group (Project and 2+ agents) has the composer and no banner", async () => {
    renderRoom();
    await screen.findByTestId("group-room");
    expect(screen.queryByTestId("group-blocked-banner")).toBeNull();
  });
});
