// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, GroupMemberStates, GroupMessage } from "../../../../shared/contracts";
import { GroupMessageList } from "./GroupMessageList";
import type { WorkingMemberAvatar } from "./GroupWorkingStatus";
import { useGroupMemberWorking } from "./useGroupMemberWorking";
import type { GroupMemberStatesById } from "./useWorkingGroups";

const members = [
  { sessionId: "s-lead", title: "Planner" },
  { sessionId: "s-build", title: "Builder" },
];

const avatars = new Map<string, WorkingMemberAvatar>([
  [
    "s-lead",
    { agentId: "a-lead", face: "happy", color: "violet", shape: "circle", archived: false },
  ],
  [
    "s-build",
    { agentId: "a-build", face: "wink", color: "sky", shape: "squircle", archived: false },
  ],
]);

const hello: GroupMessage = {
  id: "m1",
  groupId: "g-1",
  authorKind: "user",
  kind: "message",
  body: "olá",
  mentions: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function states(entry: Partial<GroupMemberStates>): GroupMemberStatesById {
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

let agentListeners: Array<(event: AgentEvent) => void>;

function ListHarness({
  memberStates,
  messages = [hello],
}: {
  memberStates: GroupMemberStatesById;
  messages?: readonly GroupMessage[];
}) {
  const workingRows = useGroupMemberWorking("g-1", memberStates);
  return (
    <GroupMessageList
      avatars={avatars}
      cwd="/repo"
      error={undefined}
      groupId="g-1"
      hasOlder={false}
      loadOlder={async () => undefined}
      loaded
      loadingOlder={false}
      memberStates={memberStates}
      members={members}
      messages={messages}
      onOpenFile={undefined}
      workingRows={workingRows}
    />
  );
}

function renderList(
  memberStates: GroupMemberStatesById,
  messages: readonly GroupMessage[] = [hello],
) {
  return render(<ListHarness memberStates={memberStates} messages={messages} />);
}

beforeEach(() => {
  agentListeners = [];
  Object.assign(window, {
    modus: {
      agent: {
        listEvents: vi.fn(async () => []),
        listEventPage: vi.fn(async () => ({
          events: [],
          summaryEvents: [],
          activityEvents: [],
          snapshotCursor: 0,
          hasMore: false,
        })),
        onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
          agentListeners.push(listener);
          return () => {
            agentListeners = agentListeners.filter((item) => item !== listener);
          };
        }),
      },
    },
  });
});

afterEach(() => cleanup());

describe("GroupMessageList working cards", () => {
  it("shows a progress card for a running member while Stop-worthy activity is live", async () => {
    renderList(states({ runningSessionIds: ["s-lead"] }));
    expect(await screen.findByTestId("group-working-status")).toBeTruthy();
    const row = screen.getByTestId("group-member-working");
    expect(row.dataset.mode).toBe("running");
    expect(row.dataset.phase).toBe("Waiting on model");
    expect(row.textContent).toContain("Planner");
    expect(row.textContent).toContain("Waiting on model");
    expect(screen.getByTestId("group-prompt-cot")).toBeTruthy();
  });

  it("updates the room phase from semantic presence as tools run", async () => {
    renderList(states({ runningSessionIds: ["s-lead"] }));
    await screen.findByTestId("group-working-status");
    act(() => {
      for (const listener of agentListeners) {
        listener({
          type: "thinking.delta",
          sessionId: "s-lead",
          messageId: "m-think",
          delta: "Sketching the handoff",
        });
        listener({
          type: "tool.started",
          sessionId: "s-lead",
          toolCallId: "t1",
          toolName: "read",
        });
      }
    });
    const row = await screen.findByTestId("group-member-working");
    await vi.waitFor(() => expect(row.dataset.phase).toBe("Exploring"));
    expect(row.textContent).toContain("Reading");
    expect(screen.queryByTestId("group-live-thought")).toBeNull();
    expect(screen.queryByTestId("group-live-tools")).toBeNull();
  });

  it("keeps concurrent member progress separate and shows streamed text in its card", async () => {
    renderList(states({ runningSessionIds: ["s-lead", "s-build"] }));
    await screen.findByTestId("group-working-status");
    act(() => {
      for (const listener of agentListeners) {
        listener({
          type: "message.delta",
          sessionId: "s-lead",
          messageId: "m-p",
          delta: "Planner stream only",
        });
        listener({
          type: "tool.started",
          sessionId: "s-build",
          toolCallId: "t-b",
          toolName: "grep",
        });
      }
    });
    const items = await screen.findAllByTestId("group-member-working");
    expect(items).toHaveLength(2);
    await vi.waitFor(() => expect(items[0]?.textContent).toContain("Writing"));
    expect(items[0]?.textContent).toContain("Planner stream only");
    expect(items[0]?.textContent).not.toContain("Exploring");
    expect(items[1]?.textContent).toContain("Searching");
    expect(items[1]?.textContent).not.toContain("Planner stream only");
    expect(screen.getAllByTestId("group-message")).toHaveLength(3);
  });

  it("transitions from live tool progress to Writing text inside the same card", async () => {
    renderList(states({ runningSessionIds: ["s-lead"] }));
    await screen.findByTestId("group-working-status");
    act(() => {
      for (const listener of agentListeners)
        listener({ type: "tool.started", sessionId: "s-lead", toolCallId: "t1", toolName: "read" });
    });
    await vi.waitFor(() =>
      expect(screen.getByTestId("group-live-status").textContent).toContain("Reading"),
    );
    act(() => {
      for (const listener of agentListeners)
        listener({
          type: "message.delta",
          sessionId: "s-lead",
          messageId: "m-w",
          delta: "Unpersisted prose",
        });
    });
    await vi.waitFor(() =>
      expect(screen.getByTestId("group-live-status").textContent).toContain("Writing"),
    );
    expect(screen.getByTestId("group-live-writing").textContent).toContain("Unpersisted prose");
    expect(screen.getAllByTestId("group-message")).toHaveLength(2);
  });

  it("shows canonical text exactly once and clears presence when the member stops", async () => {
    const { rerender } = renderList(states({ runningSessionIds: ["s-lead"] }));
    await screen.findByTestId("group-working-status");
    act(() => {
      for (const listener of agentListeners) {
        listener({
          type: "message.delta",
          sessionId: "s-lead",
          messageId: "m-w",
          delta: "Different stream text",
        });
        listener({ type: "run.completed", sessionId: "s-lead", runId: "r1" });
      }
    });
    const persisted: GroupMessage = {
      id: "persisted-1",
      groupId: "g-1",
      authorKind: "agent",
      authorSessionId: "s-lead",
      kind: "message",
      body: "Canonical final reply",
      mentions: [],
      createdAt: "2026-01-01T00:01:00.000Z",
    };
    rerender(
      <ListHarness
        memberStates={states({ runningSessionIds: [] })}
        messages={[hello, persisted]}
      />,
    );
    expect(screen.queryByTestId("group-working-status")).toBeNull();
    expect(screen.queryByTestId("group-live-writing")).toBeNull();
    expect(screen.queryByText("Different stream text")).toBeNull();
    expect(await screen.findByText("Canonical final reply")).toBeTruthy();
    expect(screen.getAllByTestId("group-message")).toHaveLength(2);
  });

  it("shows Queued for members waiting on a wake slot", async () => {
    renderList(states({ queuedSessionIds: ["s-build"] }));
    expect(await screen.findByTestId("group-working-status")).toBeTruthy();
    const row = screen.getByTestId("group-member-working");
    expect(row.dataset.mode).toBe("queued");
    expect(row.dataset.phase).toBe("Queued");
  });

  it("hides the strip when the group is idle", async () => {
    renderList(new Map());
    expect(await screen.findByText("olá")).toBeTruthy();
    expect(screen.queryByTestId("group-working-status")).toBeNull();
  });
});
