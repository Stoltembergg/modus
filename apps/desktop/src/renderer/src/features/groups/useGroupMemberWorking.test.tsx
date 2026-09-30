// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, GroupMemberStates } from "../../../../shared/contracts";
import { GroupWorkingStatus } from "./GroupWorkingStatus";
import { memberLabels } from "./memberLabels";
import { useGroupMemberWorking } from "./useGroupMemberWorking";
import type { GroupMemberStatesById } from "./useWorkingGroups";

const members = [{ sessionId: "s-lead", title: "Planner" }];
const labels = memberLabels(members);
const avatars = new Map([
  [
    "s-lead",
    {
      agentId: "a-lead",
      face: "happy" as const,
      color: "violet",
      shape: "circle" as const,
      archived: false,
    },
  ],
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

let agentListeners: Array<(event: AgentEvent) => void>;
let resolveListEvents: ((value: unknown[]) => void) | undefined;

function Harness({ memberStates }: { memberStates: GroupMemberStatesById }) {
  const rows = useGroupMemberWorking("g-1", memberStates);
  return (
    <GroupWorkingStatus
      avatars={avatars}
      groupId="g-1"
      labels={labels}
      members={members}
      rows={rows}
    />
  );
}

beforeEach(() => {
  agentListeners = [];
  resolveListEvents = undefined;
  Object.assign(window, {
    modus: {
      agent: {
        listEvents: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveListEvents = resolve as (value: unknown[]) => void;
            }),
        ),
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

describe("preferRicherLiveEvents", () => {
  it("keeps the live buffer when it has more assistant stream bytes than the seed", async () => {
    const { preferRicherLiveEvents } = await import("./useGroupMemberWorking");
    const seeded = [
      {
        event: {
          type: "message.started" as const,
          sessionId: "s",
          messageId: "m",
          role: "assistant" as const,
        },
      },
    ];
    const live = [
      ...seeded,
      {
        event: {
          type: "message.delta" as const,
          sessionId: "s",
          messageId: "m",
          delta: "streaming now",
        },
      },
    ];
    expect(preferRicherLiveEvents(seeded, live)).toEqual(live);
    expect(preferRicherLiveEvents(live, seeded)).toEqual(live);
  });
});

describe("useGroupMemberWorking live stream seed", () => {
  it("keeps in-flight message.delta text when a slow listEvents snapshot arrives empty", async () => {
    render(<Harness memberStates={states({ runningSessionIds: ["s-lead"] })} />);
    expect(window.modus.agent.listEvents).toHaveBeenCalled();

    act(() => {
      for (const listener of agentListeners) {
        listener({
          type: "message.started",
          sessionId: "s-lead",
          messageId: "m-a",
          role: "assistant",
        });
        listener({
          type: "message.delta",
          sessionId: "s-lead",
          messageId: "m-a",
          delta: "Live bubble text while seed is pending",
        });
      }
    });

    expect(await screen.findByTestId("group-live-writing")).toBeTruthy();
    expect(screen.getByTestId("group-live-writing").textContent).toContain("Live bubble text");

    // Stale seed: DB snapshot taken before deltas were durable / returned empty.
    await act(async () => {
      resolveListEvents?.([]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("group-live-writing").textContent).toContain("Live bubble text");
    });
    expect(screen.queryByTestId("group-live-status")).toBeNull();
    expect(screen.getByTestId("group-member-working").dataset.streaming).toBe("true");
  });

  it("grows the Message-card body as subsequent deltas arrive after seed", async () => {
    render(<Harness memberStates={states({ runningSessionIds: ["s-lead"] })} />);
    await act(async () => {
      resolveListEvents?.([]);
      await Promise.resolve();
    });

    act(() => {
      for (const listener of agentListeners) {
        listener({
          type: "message.delta",
          sessionId: "s-lead",
          messageId: "m-a",
          delta: "Hello",
        });
      }
    });
    expect((await screen.findByTestId("group-live-writing")).textContent).toContain("Hello");

    act(() => {
      for (const listener of agentListeners) {
        listener({
          type: "message.delta",
          sessionId: "s-lead",
          messageId: "m-a",
          delta: " world",
        });
      }
    });
    expect(screen.getByTestId("group-live-writing").textContent).toContain("Hello world");
  });
});
