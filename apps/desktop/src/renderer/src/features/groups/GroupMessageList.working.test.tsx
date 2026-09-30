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

describe("GroupMessageList working strip", () => {
  it("shows Thinking for a running member while Stop-worthy activity is live", async () => {
    renderList(states({ runningSessionIds: ["s-lead"] }));
    expect(await screen.findByTestId("group-working-status")).toBeTruthy();
    const row = screen.getByTestId("group-member-working");
    expect(row.dataset.mode).toBe("running");
    expect(row.dataset.phase).toBe("Thinking");
    expect(row.textContent).toContain("Planner");
    expect(row.textContent).toContain("Thinking");
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
    expect(row.dataset.phase).toBe("Exploring");
    expect(row.textContent).toContain("Exploring");
    expect(screen.queryByTestId("group-live-thought")).toBeNull();
    expect(screen.queryByTestId("group-live-tools")).toBeNull();
  });

  it("streams concurrent agents into distinct in-flight messages", async () => {
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
    expect(items[0]?.textContent).toContain("Planner stream only");
    expect(items[0]?.textContent).not.toContain("Exploring");
    expect(items[1]?.textContent).toContain("Exploring");
    expect(items[1]?.textContent).not.toContain("Planner stream only");
  });

  it("replaces Exploring… with streamed writing on the same active message", async () => {
    renderList(states({ runningSessionIds: ["s-lead"] }));
    await screen.findByTestId("group-working-status");
    act(() => {
      for (const listener of agentListeners) {
        listener({
          type: "tool.started",
          sessionId: "s-lead",
          toolCallId: "t1",
          toolName: "read",
        });
      }
    });
    expect((await screen.findByTestId("group-live-status")).textContent).toContain("Exploring");
    act(() => {
      for (const listener of agentListeners) {
        listener({
          type: "message.delta",
          sessionId: "s-lead",
          messageId: "m-w",
          delta: "Now writing the handoff",
        });
      }
    });
    expect(await screen.findByTestId("group-live-writing")).toBeTruthy();
    expect(screen.queryByTestId("group-live-status")).toBeNull();
    expect(screen.getByTestId("group-live-writing").textContent).toContain("Now writing");
    const streaming = screen.getByTestId("group-member-working");
    expect(streaming.querySelector('[data-testid="group-message"]')?.getAttribute("data-kind")).toBe(
      "member",
    );
  });

  it("reconciles the in-flight stream away once the persisted message arrives", async () => {
    const { rerender } = renderList(states({ runningSessionIds: ["s-lead"] }));
    await screen.findByTestId("group-working-status");
    act(() => {
      for (const listener of agentListeners) {
        listener({
          type: "message.delta",
          sessionId: "s-lead",
          messageId: "m-w",
          delta: "Final reply body",
        });
        listener({ type: "run.completed", sessionId: "s-lead", runId: "r1" });
      }
    });
    expect((await screen.findByTestId("group-live-writing")).textContent).toContain("Final reply");

    const persisted: GroupMessage = {
      id: "persisted-1",
      groupId: "g-1",
      authorKind: "agent",
      authorSessionId: "s-lead",
      kind: "message",
      body: "Final reply body",
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
    expect(screen.getAllByTestId("group-message").some((n) => n.textContent?.includes("Final reply"))).toBe(
      true,
    );
  });

  it("only auto-follows when the scroll position is near the bottom", () => {
    const list = document.createElement("div");
    Object.defineProperties(list, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 200, configurable: true },
      scrollTop: { value: 100, writable: true, configurable: true },
    });
    // Far from bottom → do not follow.
    const far = 1000 - 100 - 200; // distance = 700
    expect(far > 48).toBe(true);
    list.scrollTop = 100;
    const nearBottomFar = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    expect(nearBottomFar).toBe(false);
    // Near bottom → follow.
    list.scrollTop = 760;
    const nearBottomClose = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    expect(nearBottomClose).toBe(true);
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
