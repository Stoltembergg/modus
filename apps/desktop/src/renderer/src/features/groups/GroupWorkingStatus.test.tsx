// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupWorkingStatus, type WorkingMemberAvatar } from "./GroupWorkingStatus";
import type { GroupLiveTurnSnapshot } from "./groupLiveTurn";
import { STILL_WORKING_AFTER_MS } from "./groupLiveTurn";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";

afterEach(() => cleanup());

const labels = new Map([
  ["s-lead", { title: "Planner" }],
  ["s-build", { title: "Builder" }],
]);

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

function live(partial: Partial<GroupLiveTurnSnapshot> = {}): GroupLiveTurnSnapshot {
  const lastEventAt = partial.lastEventAt ?? Date.now();
  const phase = partial.phase ?? "Thinking";
  const streamText = partial.streamText ?? partial.writingPreview ?? "";
  return {
    phase,
    thoughtPreview: partial.thoughtPreview ?? "",
    tools: partial.tools ?? [],
    streamText,
    writingPreview: streamText,
    lastEventAt,
    collapsed: partial.collapsed ?? false,
    presence: partial.presence ?? {
      state: phase === "Queued" ? "queued" : phase === "Writing" ? "writing" : "thinking",
      label: String(phase),
      startedAt: lastEventAt || Date.now(),
      lastProgressAt: lastEventAt || Date.now(),
    },
  };
}

function renderStatus(rows: readonly GroupMemberWorkingRow[]) {
  return render(
    <GroupWorkingStatus
      avatars={avatars}
      groupId="g-1"
      labels={labels}
      members={members}
      rows={rows}
    />,
  );
}

describe("GroupWorkingStatus", () => {
  it("renders nothing when no members are working", () => {
    const { container } = renderStatus([]);
    expect(container.firstChild).toBeNull();
  });

  it("shows per-member Waiting on model / Queued rows while the group run is active", () => {
    const rows: GroupMemberWorkingRow[] = [
      { sessionId: "s-lead", mode: "running", live: live({ phase: "Waiting on model" }) },
      { sessionId: "s-build", mode: "queued", live: live({ phase: "Queued", lastEventAt: 0 }) },
    ];
    renderStatus(rows);
    const items = screen.getAllByTestId("group-member-working");
    expect(items).toHaveLength(2);
    expect(items[0]?.dataset.phase).toBe("Waiting on model");
    expect(items[0]?.textContent).toContain("Planner");
    expect(items[0]?.textContent).toContain("Waiting on model");
    expect(items[1]?.dataset.phase).toBe("Queued");
    expect(items[1]?.textContent).toContain("Builder");
  });

  it("shows only compact Writing presence and never duplicates public stream text", () => {
    const rows: GroupMemberWorkingRow[] = [
      {
        sessionId: "s-lead",
        mode: "running",
        live: live({
          phase: "Writing",
          thoughtPreview: "Plan the toggle",
          tools: [{ id: "t1", name: "read", label: "Reading", done: true }],
          streamText: "I'll hand off to Builder",
        }),
      },
    ];
    renderStatus(rows);
    expect(screen.getByTestId("group-live-status").textContent).toContain("Writing");
    expect(screen.queryByTestId("group-live-thought")).toBeNull();
    expect(screen.queryByTestId("group-live-tools")).toBeNull();
    expect(screen.queryByTestId("group-live-writing")).toBeNull();
    expect(screen.queryByTestId("group-message")).toBeNull();
    expect(screen.queryByText(/hand off|Plan the toggle|Reading/)).toBeNull();
  });

  it("shows Exploring… inline before any writing arrives", () => {
    const rows: GroupMemberWorkingRow[] = [
      {
        sessionId: "s-lead",
        mode: "running",
        live: live({
          phase: "Exploring",
          presence: {
            state: "exploring",
            label: "Exploring",
            startedAt: Date.now(),
            lastProgressAt: Date.now(),
          },
        }),
      },
    ];
    renderStatus(rows);
    expect(screen.getByTestId("group-live-status").textContent).toContain("Exploring");
    expect(screen.queryByTestId("group-live-writing")).toBeNull();
  });

  it("keeps concurrent agent presence independent without a second transcript", () => {
    const rows: GroupMemberWorkingRow[] = [
      {
        sessionId: "s-lead",
        mode: "running",
        live: live({ phase: "Writing", streamText: "Planner draft A" }),
      },
      {
        sessionId: "s-build",
        mode: "running",
        live: live({
          phase: "Exploring",
          streamText: "",
          presence: {
            state: "exploring",
            label: "Exploring",
            startedAt: Date.now(),
            lastProgressAt: Date.now(),
          },
        }),
      },
    ];
    renderStatus(rows);
    const items = screen.getAllByTestId("group-member-working");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Writing");
    expect(items[0]?.textContent).not.toContain("Planner draft A");
    expect(items[0]?.textContent).not.toContain("Exploring");
    expect(items[1]?.textContent).toContain("Exploring");
    expect(items[1]?.textContent).not.toContain("Planner draft A");
  });

  it("hides collapsed empty streams", () => {
    const rows: GroupMemberWorkingRow[] = [
      {
        sessionId: "s-lead",
        mode: "running",
        live: live({ phase: "Done", collapsed: true, streamText: "should not show" }),
      },
    ];
    renderStatus(rows);
    expect(screen.queryByTestId("group-working-status")).toBeNull();
    expect(screen.queryByText("should not show")).toBeNull();
  });

  it("shows Still working… after silence", () => {
    vi.useFakeTimers();
    const last = Date.now();
    const rows: GroupMemberWorkingRow[] = [
      {
        sessionId: "s-lead",
        mode: "running",
        live: live({ phase: "Waiting on model", lastEventAt: last }),
      },
    ];
    renderStatus(rows);
    expect(screen.getByTestId("group-live-status").textContent).toContain("Waiting on model");
    act(() => {
      vi.advanceTimersByTime(STILL_WORKING_AFTER_MS + 50);
    });
    expect(screen.getByTestId("group-live-status").textContent).toContain("Still working");
    vi.useRealTimers();
  });
});
