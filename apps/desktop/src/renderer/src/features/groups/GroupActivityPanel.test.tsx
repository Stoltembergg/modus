// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupTask } from "../../../../shared/contracts";
import { GroupActivityPanel } from "./GroupActivityPanel";
import type { MemberLabel } from "./memberLabels";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";

const labels = new Map<string, MemberLabel>([
  ["s-lead", { title: "Planner" }],
  ["s-build", { title: "Builder" }],
]);

const task = (id: string, title: string, branch?: string): GroupTask => ({
  id,
  groupId: "g-1",
  title,
  status: "in_progress",
  ownerSessionId: "s-lead",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...(branch ? { branch } : {}),
});

function liveRow(partial: Partial<GroupMemberWorkingRow> = {}): GroupMemberWorkingRow {
  return {
    sessionId: "s-build",
    mode: "running",
    live: {
      phase: "Exploring",
      thoughtPreview: "Looking at the parser",
      tools: [{ id: "t1", name: "read", label: "Reading", done: false }],
      writingPreview: "",
      lastEventAt: Date.now(),
      collapsed: false,
      presence: {
        state: "exploring",
        label: "Exploring",
        startedAt: Date.now() - 1_000,
        lastProgressAt: Date.now(),
        activity: "Reading",
      },
    },
    ...partial,
  };
}

beforeEach(() => {
  Object.assign(window, {
    modus: {
      group: {
        listDecisions: vi.fn(async () => []),
        deleteDecision: vi.fn(),
        cancelTask: vi.fn(),
        onEvent: vi.fn(() => () => undefined),
      },
    },
  });
});

afterEach(() => cleanup());

describe("GroupActivityPanel", () => {
  it("shows live tool detail, coordination, and checklist branches", async () => {
    const onSetMode = vi.fn();
    render(
      <GroupActivityPanel
        coordinating
        groupId="g-1"
        hasLead
        labels={labels}
        onCancelled={vi.fn()}
        onSetMode={onSetMode}
        stage={{ stage: "Handoff", ownerSessionId: "s-build", ownerName: "Builder" }}
        tasks={[task("1", "Parser", "group/g-1/builder")]}
        workingRows={[liveRow()]}
      />,
    );

    expect(screen.getByTestId("group-activity-panel")).toBeTruthy();
    expect(screen.getByTestId("group-activity-live").textContent).toContain("Reading");
    expect(screen.getByTestId("group-activity-coordination")).toBeTruthy();
    expect(screen.getByTestId("group-stage-chip").textContent).toContain("Handoff");
    expect(screen.getByTestId("group-activity-coordinator-status").textContent).toBe(
      "Coordinator on",
    );
    expect(screen.getByTestId("task-branch").textContent).toBe("group/g-1/builder");

    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(onSetMode).toHaveBeenCalledWith("free");
  });

  it("hides live section when nobody is mid-tool", () => {
    render(
      <GroupActivityPanel
        coordinating={false}
        groupId="g-1"
        hasLead
        labels={labels}
        onCancelled={vi.fn()}
        stage={undefined}
        tasks={[]}
        workingRows={[]}
      />,
    );
    expect(screen.queryByTestId("group-activity-live")).toBeNull();
    expect(screen.getByTestId("group-activity-coordinator-status").textContent).toBe(
      "Free collaboration",
    );
  });
});
