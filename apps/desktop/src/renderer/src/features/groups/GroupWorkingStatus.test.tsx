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

const avatars = new Map<string, WorkingMemberAvatar>([
  ["s-lead", { agentId: "a-lead", face: "happy", color: "violet", archived: false }],
  ["s-build", { agentId: "a-build", face: "wink", color: "sky", archived: false }],
]);

function live(partial: Partial<GroupLiveTurnSnapshot> = {}): GroupLiveTurnSnapshot {
  const lastEventAt = partial.lastEventAt ?? Date.now();
  const phase = partial.phase ?? "Thinking";
  return {
    phase,
    thoughtPreview: "",
    tools: [],
    writingPreview: "",
    lastEventAt,
    presence: {
      state: phase === "Queued" ? "queued" : phase === "Writing" ? "writing" : "thinking",
      label: String(phase),
      startedAt: lastEventAt || Date.now(),
      lastProgressAt: lastEventAt || Date.now(),
    },
    ...partial,
  };
}

describe("GroupWorkingStatus", () => {
  it("renders nothing when no members are working", () => {
    const { container } = render(
      <GroupWorkingStatus avatars={avatars} labels={labels} rows={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows per-member Thinking / Queued rows while the group run is active", () => {
    const rows: GroupMemberWorkingRow[] = [
      { sessionId: "s-lead", mode: "running", live: live({ phase: "Thinking" }) },
      { sessionId: "s-build", mode: "queued", live: live({ phase: "Queued", lastEventAt: 0 }) },
    ];
    render(<GroupWorkingStatus avatars={avatars} labels={labels} rows={rows} />);
    const items = screen.getAllByTestId("group-member-working");
    expect(items).toHaveLength(2);
    expect(items[0]?.dataset.phase).toBe("Thinking");
    expect(items[0]?.textContent).toContain("Planner");
    expect(items[0]?.textContent).toContain("Thinking");
    expect(items[1]?.dataset.phase).toBe("Queued");
    expect(items[1]?.textContent).toContain("Builder");
  });

  it("shows writing preview under the live turn (tools stay for Activity)", () => {
    const rows: GroupMemberWorkingRow[] = [
      {
        sessionId: "s-lead",
        mode: "running",
        live: live({
          phase: "Writing",
          thoughtPreview: "Plan the toggle",
          tools: [{ id: "t1", name: "read", label: "Reading", done: true }],
          writingPreview: "I'll hand off to Builder",
        }),
      },
    ];
    render(<GroupWorkingStatus avatars={avatars} labels={labels} rows={rows} />);
    expect(screen.queryByTestId("group-live-thought")).toBeNull();
    expect(screen.queryByTestId("group-live-tools")).toBeNull();
    expect(screen.getByTestId("group-live-writing").textContent).toContain("hand off");
  });

  it("shows Still working… after silence while running", () => {
    vi.useFakeTimers();
    const last = Date.now();
    const rows: GroupMemberWorkingRow[] = [
      {
        sessionId: "s-lead",
        mode: "running",
        live: live({ phase: "Thinking", lastEventAt: last }),
      },
    ];
    render(<GroupWorkingStatus avatars={avatars} labels={labels} rows={rows} />);
    expect(screen.getByTestId("group-member-live-turn").textContent).toContain("Thinking");
    act(() => {
      vi.advanceTimersByTime(STILL_WORKING_AFTER_MS + 1_000);
    });
    expect(screen.getByTestId("group-member-live-turn").textContent).toContain("Still working");
    vi.useRealTimers();
  });
});
