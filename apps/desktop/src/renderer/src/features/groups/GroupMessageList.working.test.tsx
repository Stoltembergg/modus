// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberStates, GroupRuntimeEvent } from "../../../../shared/contracts";
import { GroupMessageList } from "./GroupMessageList";
import type { WorkingMemberAvatar } from "./GroupWorkingStatus";
import type { GroupMemberStatesById } from "./useWorkingGroups";

const members = [
  { sessionId: "s-lead", title: "Planner" },
  { sessionId: "s-build", title: "Builder" },
];

const avatars = new Map<string, WorkingMemberAvatar>([
  ["s-lead", { agentId: "a-lead", face: "happy", color: "violet", archived: false }],
  ["s-build", { agentId: "a-build", face: "wink", color: "sky", archived: false }],
]);

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

beforeEach(() => {
  Object.assign(window, {
    modus: {
      group: {
        listMessages: vi.fn(async () => [
          {
            id: "m1",
            groupId: "g-1",
            authorKind: "user",
            kind: "message",
            body: "olá",
            mentions: [],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
        onEvent: vi.fn((_listener: (event: GroupRuntimeEvent) => void) => () => undefined),
      },
      agent: {
        listEvents: vi.fn(async () => []),
        onEvent: vi.fn(() => () => undefined),
      },
    },
  });
});

afterEach(() => cleanup());

describe("GroupMessageList working strip", () => {
  it("shows Thinking for a running member while Stop-worthy activity is live", async () => {
    render(
      <GroupMessageList
        avatars={avatars}
        cwd="/repo"
        groupId="g-1"
        memberStates={states({ runningSessionIds: ["s-lead"] })}
        members={members}
        onOpenFile={undefined}
      />,
    );
    expect(await screen.findByTestId("group-working-status")).toBeTruthy();
    const row = screen.getByTestId("group-member-working");
    expect(row.dataset.mode).toBe("running");
    expect(row.dataset.phase).toBe("Thinking");
    expect(row.textContent).toContain("Planner");
    expect(row.textContent).toContain("Thinking");
  });

  it("shows Queued for members waiting on a wake slot", async () => {
    render(
      <GroupMessageList
        avatars={avatars}
        cwd="/repo"
        groupId="g-1"
        memberStates={states({ queuedSessionIds: ["s-build"] })}
        members={members}
        onOpenFile={undefined}
      />,
    );
    expect(await screen.findByTestId("group-working-status")).toBeTruthy();
    const row = screen.getByTestId("group-member-working");
    expect(row.dataset.mode).toBe("queued");
    expect(row.dataset.phase).toBe("Queued");
  });

  it("hides the strip when the group is idle", async () => {
    render(
      <GroupMessageList
        avatars={avatars}
        cwd="/repo"
        groupId="g-1"
        memberStates={new Map()}
        members={members}
        onOpenFile={undefined}
      />,
    );
    expect(await screen.findByText("olá")).toBeTruthy();
    expect(screen.queryByTestId("group-working-status")).toBeNull();
  });
});
