import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupTask, GroupTaskEvidenceRef } from "../../shared/contracts";

const mocks = vi.hoisted(() => ({
  task: undefined as unknown,
  qa: undefined as unknown,
  fingerprint: "current-fingerprint",
  sourcePath: "/tmp",
  onFingerprint: null as null | (() => void),
}));

vi.mock("../agent/agent-event-store", () => ({
  getHarnessQAEventByRowId: vi.fn(() => mocks.qa),
}));
vi.mock("../git/git-service", () => ({
  getGroupSourceFingerprint: vi.fn(async () => {
    mocks.onFingerprint?.();
    mocks.onFingerprint = null;
    return mocks.fingerprint;
  }),
}));
vi.mock("./group-task-evidence", () => ({
  getGroupTaskSourcePath: vi.fn(() => mocks.sourcePath),
  resolveGroupTaskEvidence: vi.fn((task: GroupTask, sourceFingerprint: string) => ({
    task,
    criterionOutcomes: (task.criteria ?? []).map((criterion) => ({
      criterionId: criterion.id,
      criteriaVersion: task.criteriaVersion,
      sourceFingerprint,
      status:
        mocks.qa &&
        (task.evidenceRefs ?? []).some(
          (ref: GroupTaskEvidenceRef) =>
            ref.criterionId === criterion.id && ref.sourceFingerprint === sourceFingerprint,
        )
          ? "passed"
          : "missing",
    })),
    sourceFingerprint,
    dependencies: [],
  })),
}));
vi.mock("./group-task-store", () => ({
  getGroupTask: vi.fn(() => mocks.task),
  getGroupTaskRunBinding: vi.fn(() => ({
    groupId: "g-1",
    taskId: "t-1",
    taskVersion: 1,
    criteriaVersion: 1,
    sessionId: "s-owner",
    runId: "run-1",
    executionId: "execution-1",
    role: "owner",
    sourceFingerprint: "current-fingerprint",
  })),
  isGroupTaskRunAssignmentCurrent: vi.fn(() => true),
  listGroupTasks: vi.fn(() => [mocks.task]),
}));
vi.mock("./group-store", () => ({
  GroupStoreError: class GroupStoreError extends Error {
    constructor(_code: string, message: string) {
      super(message);
    }
  },
}));

const baseTask = () => ({
  id: "t-1",
  groupId: "g-1",
  title: "Parser",
  status: "in_progress",
  stateVersion: 1,
  criteriaVersion: 1,
  criteria: [{ id: "unit", description: "Unit tests pass", requiredCheckKinds: ["tests"] }],
  dependencyIds: [],
  ownerSessionId: "s-owner",
  verificationPolicy: { mode: "required", requireReview: false },
  evidenceRefs: [
    {
      criterionId: "unit",
      checkName: "tests",
      criteriaVersion: 1,
      sessionId: "s-owner",
      runId: "run-1",
      eventRowId: 11,
      evidenceId: "e-1",
      sourceFingerprint: "current-fingerprint",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  mocks.fingerprint = "current-fingerprint";
  mocks.onFingerprint = null;
  mocks.sourcePath = "/tmp";
  mocks.task = baseTask();
  mocks.qa = {
    type: "harness.qa",
    sessionId: "s-owner",
    runId: "run-1",
    result: {
      sourceFingerprint: "current-fingerprint",
      evidence: [
        {
          id: "e-1",
          checkName: "tests",
          status: "passed",
          label: "Tests passed",
          output: "secret raw output",
          stdout: "secret transcript",
        },
      ],
    },
  };
});

describe("group task detail resolver", () => {
  it("returns typed current outcomes and persisted QA links without harness output", async () => {
    const { getGroupTaskDetails } = await import("./group-task-details");
    const detail = await getGroupTaskDetails("g-1", "t-1");
    expect(detail.criteria[0]).toMatchObject({
      criterionId: "unit",
      status: "passed",
      evidence: [
        { status: "passed", sessionId: "s-owner", runId: "run-1", executionId: "execution-1" },
      ],
    });
    expect(detail.gate.satisfied).toBe(true);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("secret raw output");
    expect(serialized).not.toContain("secret transcript");
    expect(serialized).not.toContain('"stdout"');
    expect(serialized).not.toContain('"output"');
  });

  it("fails closed when source or QA event was removed", async () => {
    const { getGroupTaskDetails } = await import("./group-task-details");
    mocks.fingerprint = "newer-source";
    let detail = await getGroupTaskDetails("g-1", "t-1");
    expect(detail.criteria[0]?.status).toBe("stale");
    expect(detail.gate.satisfied).toBe(false);
    mocks.fingerprint = "current-fingerprint";
    mocks.qa = undefined;
    detail = await getGroupTaskDetails("g-1", "t-1");
    expect(detail.criteria[0]).toMatchObject({
      status: "missing",
      evidence: [{ status: "missing", reason: "The QA event was removed." }],
    });
    expect(detail.gate.satisfied).toBe(false);
  });

  it("marks a removed task source unavailable and fails the verification gate", async () => {
    const { getGroupTaskDetails } = await import("./group-task-details");
    mocks.sourcePath = "/definitely-not-a-real-modus-task-source";
    const detail = await getGroupTaskDetails("g-1", "t-1");
    expect(detail.source).toMatchObject({
      availability: "missing",
      reason: "The task source folder was removed.",
    });
    expect(detail.criteria[0]?.status).toBe("unavailable");
    expect(detail.gate.satisfied).toBe(false);
  });

  it("rejects a task identifier that belongs to another group", async () => {
    const { getGroupTaskDetails } = await import("./group-task-details");
    await expect(getGroupTaskDetails("g-other", "t-1")).rejects.toThrow(/not found/i);
  });

  it("re-reads and retries if the task changes while Git freshness is loading", async () => {
    const { getGroupTaskDetails } = await import("./group-task-details");
    mocks.onFingerprint = () => {
      mocks.task = {
        ...baseTask(),
        title: "Current task",
        stateVersion: 2,
        criteriaVersion: 2,
        evidenceRefs: [],
      };
    };
    const detail = await getGroupTaskDetails("g-1", "t-1");
    expect(detail.task).toMatchObject({
      title: "Current task",
      stateVersion: 2,
      criteriaVersion: 2,
    });
    expect(detail.criteria[0]?.status).toBe("missing");
    expect(detail.gate.satisfied).toBe(false);
  });
});
