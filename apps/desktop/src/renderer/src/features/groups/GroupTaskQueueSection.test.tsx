// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupTaskQueueItem } from "../../../../shared/group-work-state";
import { GroupTaskQueueSection } from "./GroupTaskQueueSection";

const initial: GroupTaskQueueItem[] = [
  {
    taskId: "task-running",
    taskTitle: "Implement parser",
    state: "running",
    sessionId: "session-builder",
    memberName: "Builder",
    jobId: "job-running",
    position: 1,
  },
  {
    taskId: "task-queued",
    taskTitle: "Add parser tests",
    state: "queued",
    sessionId: "session-builder",
    memberName: "Builder",
    jobId: "job-queued",
    position: 2,
  },
  {
    taskId: "task-backlog",
    taskTitle: "Document parser API",
    state: "backlog",
    backlogReason: "awaiting-capacity",
  },
];

const subscribers = new Set<(event: unknown) => void>();
const api = {
  getTaskQueueSnapshot: vi.fn(async () => initial),
  onEvent: vi.fn((listener: (event: unknown) => void) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  subscribers.clear();
  Object.assign(window, { modus: { group: api } });
});

afterEach(() => cleanup());

describe("GroupTaskQueueSection", () => {
  it("renders the persisted FIFO by member and separates ready backlog", async () => {
    render(<GroupTaskQueueSection groupId="group-1" />);

    const list = await screen.findByRole("list", { name: "Dispatched tasks" });
    const rows = within(list).getAllByTestId("group-task-queue-item");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Implement parserBuilder · Running",
      "Add parser testsBuilder · Queued #2",
    ]);
    expect(screen.getByTestId("group-task-backlog").textContent).toContain("Document parser API");
    expect(screen.getByText("Ready · waiting for queue capacity")).toBeTruthy();
  });

  it("refreshes on matching activity, task, and suggestion events only", async () => {
    api.getTaskQueueSnapshot
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce([
        {
          taskId: "task-queued",
          taskTitle: "Add parser tests",
          state: "running",
          sessionId: "session-builder",
          memberName: "Builder",
          jobId: "job-queued",
          position: 1,
        },
      ])
      .mockResolvedValue([
        {
          taskId: "task-running",
          taskTitle: "Implement parser",
          state: "queued",
          sessionId: "session-builder",
          memberName: "Builder",
          jobId: "job-running",
          position: 2,
        },
      ]);
    render(<GroupTaskQueueSection groupId="group-1" />);
    await screen.findByText("Implement parser");
    expect(api.getTaskQueueSnapshot).toHaveBeenCalledTimes(1);

    for (const listener of subscribers) {
      listener({
        type: "group.task-changed",
        groupId: "group-2",
        taskId: "task-1",
        stateVersion: 2,
      });
    }
    expect(api.getTaskQueueSnapshot).toHaveBeenCalledTimes(1);

    for (const listener of subscribers) {
      listener({
        type: "group.task-changed",
        groupId: "group-1",
        taskId: "task-1",
        stateVersion: 2,
      });
    }
    await waitFor(() => expect(api.getTaskQueueSnapshot).toHaveBeenCalledTimes(2));

    for (const listener of subscribers) {
      listener({
        type: "group.suggestion-changed",
        groupId: "group-1",
        actionId: "a-1",
        version: 3,
      });
    }
    await waitFor(() => expect(api.getTaskQueueSnapshot).toHaveBeenCalledTimes(3));
  });

  it("ignores snapshots from a superseded refresh or previous group", async () => {
    let resolveInitial!: (items: GroupTaskQueueItem[]) => void;
    let resolveRefresh!: (items: GroupTaskQueueItem[]) => void;
    let resolveNewGroup!: (items: GroupTaskQueueItem[]) => void;
    api.getTaskQueueSnapshot
      .mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveInitial = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRefresh = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveNewGroup = resolve)));

    const view = render(<GroupTaskQueueSection groupId="group-1" />);
    await waitFor(() => expect(api.getTaskQueueSnapshot).toHaveBeenCalledTimes(1));
    act(() => {
      for (const listener of subscribers) {
        listener({
          type: "group.activity",
          groupId: "group-1",
          runningSessionIds: [],
          queuedSessionIds: [],
          waitingSessionIds: [],
        });
      }
    });
    await waitFor(() => expect(api.getTaskQueueSnapshot).toHaveBeenCalledTimes(2));

    view.rerender(<GroupTaskQueueSection groupId="group-2" />);
    await waitFor(() => expect(api.getTaskQueueSnapshot).toHaveBeenCalledTimes(3));
    const groupTwo: GroupTaskQueueItem[] = [
      {
        taskId: "group-two",
        taskTitle: "Current group snapshot",
        state: "backlog",
        backlogReason: "needs-suggestion",
      },
    ];
    await act(async () => resolveNewGroup(groupTwo));
    expect(await screen.findByText("Current group snapshot")).toBeTruthy();

    await act(async () =>
      resolveRefresh([
        {
          taskId: "stale-refresh",
          taskTitle: "Stale refresh response",
          state: "backlog",
          backlogReason: "needs-suggestion",
        },
      ]),
    );
    await act(async () =>
      resolveInitial([
        {
          taskId: "stale-group",
          taskTitle: "Stale previous group response",
          state: "backlog",
          backlogReason: "needs-suggestion",
        },
      ]),
    );

    expect(screen.getByText("Current group snapshot")).toBeTruthy();
    expect(screen.queryByText("Stale refresh response")).toBeNull();
    expect(screen.queryByText("Stale previous group response")).toBeNull();
  });
});
