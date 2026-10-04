// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

const integrationPreview = {
  id: "preview-1",
  groupId: "g-1",
  taskId: "done-task",
  taskVersion: 4,
  sourceBranch: "group/g-1/parser",
  sourceSha: "a".repeat(40),
  sourceFingerprint: "b".repeat(40),
  targetBranch: "main",
  targetSha: "c".repeat(40),
  targetFingerprint: "d".repeat(40),
  commits: [],
  omittedCommitCount: 0,
  changedFiles: [],
  omittedChangedFileCount: 0,
  diffSummary: "",
  createdAt: "2026-10-03T00:00:00.000Z",
  status: "ready" as const,
};

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
      streamText: "",
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
  const detail = {
    task: {
      id: "done-task",
      groupId: "g-1",
      title: "Parser",
      status: "done",
      stateVersion: 4,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    dependencies: [],
    dependencyOptions: [],
    omittedDependencyOptionCount: 0,
    source: { availability: "available" },
    criteria: [],
    review: { status: "not_required" },
    gate: { satisfied: true, reasonCodes: [] },
  };
  Object.assign(window, {
    modus: {
      group: {
        getProactivityMode: vi.fn(async () => "suggest"),
        setProactivityMode: vi.fn(async (_groupId: string, mode: string) => mode),
        listSuggestions: vi.fn(async () => []),
        resolveSuggestion: vi.fn(async () => undefined),
        listDecisions: vi.fn(async () => []),
        deleteDecision: vi.fn(),
        cancelTask: vi.fn(),
        getTaskDetails: vi.fn(async () => detail),
        listTaskTransitions: vi.fn(async () => []),
        updateTask: vi.fn(async () => detail.task),
        getIntegrationState: vi.fn(async () => ({})),
        previewTaskIntegration: vi.fn(async () => integrationPreview),
        applyTaskIntegration: vi.fn(async () => ({})),
        abortTaskIntegration: vi.fn(async () => ({})),
        onEvent: vi.fn(() => () => undefined),
      },
    },
  });
});

afterEach(() => cleanup());

describe("GroupActivityPanel", () => {
  it("does not apply integration on mount, task reopen, or proactivity opt-in", async () => {
    render(
      <GroupActivityPanel
        coordinating={false}
        groupId="g-1"
        hasLead
        labels={labels}
        onCancelled={vi.fn()}
        stage={undefined}
        tasks={[{ ...task("done-task", "Parser"), status: "done" }]}
        workingRows={[]}
      />,
    );
    const applyTaskIntegration = window.modus.group.applyTaskIntegration;
    const proactivity = screen.getByRole("checkbox", { name: "Automatic suggestions" });
    await waitFor(() => expect((proactivity as HTMLInputElement).disabled).toBe(false));

    expect(applyTaskIntegration).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    await screen.findByRole("button", { name: /integration/i });
    await userEvent.click(screen.getByRole("button", { name: /integration/i }));
    expect(await screen.findByRole("dialog", { name: "Integrate task" })).toBeTruthy();
    await userEvent.click(proactivity);
    await waitFor(() =>
      expect(window.modus.group.setProactivityMode).toHaveBeenCalledWith("g-1", "opt_in_auto"),
    );
    expect(applyTaskIntegration).not.toHaveBeenCalled();
  });

  it("shows live tool detail, coordination, details, and checklist branches", async () => {
    const onSetMode = vi.fn();
    render(
      <GroupActivityPanel
        coordinating
        groupId="g-1"
        hasLead
        labels={labels}
        messages={[
          {
            id: "m1",
            groupId: "g-1",
            authorKind: "agent",
            authorSessionId: "s-lead",
            kind: "message",
            body: "Plan.\nOwner: @Builder\nObjective: wire toggle\nHandoff → @Builder · wire toggle",
            mentions: ["s-build"],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ]}
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
    expect(screen.getByTestId("group-activity-details").textContent).toContain("Owner");
    expect(screen.getByTestId("group-activity-details").textContent).toContain("@Builder");
    expect(screen.getByTestId("group-activity-details").textContent).toContain("Objective");
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
