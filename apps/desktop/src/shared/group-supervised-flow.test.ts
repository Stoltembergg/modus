import { describe, expect, it } from "vitest";
import type { AgentGroupMember, GroupTask } from "./contracts";
import { composeSupervisedFlowSection, planSupervisedCodeFlow } from "./group-supervised-flow";
import type { GroupWorkState } from "./group-work-state";

const member = (id: string, capabilityIds: string[]): AgentGroupMember => ({
  sessionId: id,
  agentId: id,
  groupId: "g",
  name: id,
  agentRole: "",
  joinedAt: "now",
  capabilityIds,
  supportedTaskKinds: ["code", "docs", "design", "review"],
});

const task: GroupTask = {
  id: "t",
  groupId: "g",
  title: "hi",
  kind: "code",
  stage: "implement",
  status: "in_progress",
  ownerSessionId: "build",
  reviewerSessionId: "review",
  createdBySessionId: "lead",
  verificationPolicy: { mode: "required", requireReview: true },
  criteria: [{ id: "c", description: "test", requiredCheckKinds: ["tests"] }],
  createdAt: "now",
  updatedAt: "now",
};

const workState: GroupWorkState = {
  groupId: "g",
  tasks: [task],
  members: [
    member("lead", ["plan"]),
    member("build", ["implement", "verify", "docs"]),
    member("review", ["review"]),
  ],
  gates: { t: { satisfied: false, reasonCodes: ["criteria-incomplete"] } },
  omitted: { tasks: 0, members: 0, criteria: 0 },
  budgets: { remainingAgentMessages: 10, remainingMemberWakes: 10, remainingInputTokens: 10000 },
};

describe("typed supervised flow", () => {
  it("plans only the current typed stage and carries task ID and gate metadata", () => {
    const plan = planSupervisedCodeFlow({ task, workState });
    expect(plan.kind).toBe("code");
    expect(plan.stages.find((s) => s.id === "implement")).toMatchObject({
      skip: false,
      blocked: false,
      ownerSessionId: "build",
    });
    expect(plan.stages.find((s) => s.id === "verify")).toMatchObject({
      skip: false,
      blocked: true,
      reason: "stage-pending",
      ownerSessionId: "build",
    });
    expect(plan.stages.find((s) => s.id === "review")).toMatchObject({
      skip: false,
      blocked: true,
      reason: "stage-pending",
      ownerSessionId: "review",
    });
    expect(plan.stages.find((s) => s.id === "deliver")).toMatchObject({
      blocked: true,
      reason: "stage-pending",
      ownerSessionId: "lead",
    });
    expect(plan.delegations).toEqual([
      expect.objectContaining({
        taskId: "t",
        stage: "implement",
        memberId: "build",
        tool: "group_assign_task",
      }),
    ]);
    expect(composeSupervisedFlowSection(plan)).toContain("taskId=t");
    expect(composeSupervisedFlowSection(plan)).toContain("criteria-incomplete");
  });

  it("reexpresses docs-only skipping from typed policy rather than title keywords", () => {
    const docsTask = {
      ...task,
      id: "docs",
      kind: "docs" as const,
      title: "anything at all",
      stage: "implement" as const,
      verificationPolicy: { mode: "none" as const, requireReview: false },
    };
    const plan = planSupervisedCodeFlow({
      task: docsTask,
      workState: { ...workState, tasks: [docsTask] },
    });
    expect(plan.stages.find((s) => s.id === "implement")).toMatchObject({
      skip: false,
      blocked: false,
      ownerSessionId: "build",
    });
    expect(plan.stages.find((s) => s.id === "review")).toMatchObject({
      skip: true,
      reason: "stage-not-required",
    });
    expect(plan.stages.find((s) => s.id === "verify")).toMatchObject({
      skip: true,
      reason: "stage-not-required",
    });
    expect(plan.delegations).toEqual([
      expect.objectContaining({ taskId: "docs", stage: "implement", memberId: "build" }),
    ]);
  });

  it("reexpresses review-only skipping from the typed review task kind", () => {
    const reviewTask = {
      ...task,
      kind: "review" as const,
      stage: "review" as const,
      status: "in_review" as const,
      verificationPolicy: { mode: "none" as const, requireReview: false },
    };
    const plan = planSupervisedCodeFlow({
      task: reviewTask,
      workState: { ...workState, tasks: [reviewTask] },
    });
    expect(plan.stages.find((s) => s.id === "plan")).toMatchObject({ skip: true });
    expect(plan.stages.find((s) => s.id === "implement")).toMatchObject({ skip: true });
    expect(plan.stages.find((s) => s.id === "review")).toMatchObject({
      skip: false,
      blocked: false,
      ownerSessionId: "review",
    });
    expect(plan.delegations).toEqual([
      expect.objectContaining({
        taskId: "t",
        stage: "review",
        memberId: "review",
        tool: "group_request_review",
      }),
    ]);
  });

  it("blocks implementation without a capable owner instead of falling back to the Lead", () => {
    const noImplementer = {
      ...workState,
      members: workState.members.filter((row) => row.sessionId !== "build"),
    };
    const plan = planSupervisedCodeFlow({ task, workState: noImplementer });
    expect(plan.stages.find((stage) => stage.id === "implement")).toMatchObject({
      skip: false,
      blocked: true,
      reason: "owner-unavailable",
    });
    expect(plan.delegations).toEqual([]);
  });

  it("runs only the planning stage for a typed design task", () => {
    const { ownerSessionId: _ownerSessionId, ...taskWithoutOwner } = task;
    const designTask = {
      ...taskWithoutOwner,
      kind: "design" as const,
      stage: "plan" as const,
      verificationPolicy: { mode: "none" as const, requireReview: false },
    };
    const plan = planSupervisedCodeFlow({
      task: designTask,
      workState: { ...workState, tasks: [designTask] },
    });
    expect(plan.stages.find((s) => s.id === "plan")).toMatchObject({
      skip: false,
      blocked: false,
      ownerSessionId: "lead",
    });
    expect(plan.stages.find((s) => s.id === "implement")).toMatchObject({ skip: true });
    expect(plan.stages.find((s) => s.id === "review")).toMatchObject({ skip: true });
    expect(plan.stages.find((s) => s.id === "verify")).toMatchObject({ skip: true });
    expect(plan.delegations).toEqual([]);
  });

  it("reviewer_removal_blocks_review", () => {
    const plan = planSupervisedCodeFlow({
      task: { ...task, stage: "review", status: "in_review" },
      workState: {
        ...workState,
        members: workState.members.filter((m) => m.sessionId !== "review"),
      },
    });
    expect(plan.stages.find((s) => s.id === "review")).toMatchObject({
      skip: false,
      blocked: true,
      reason: "reviewer-unavailable",
    });
    expect(plan.delegations).toEqual([]);
  });
  it("PT and EN titles roles and keywords do not change typed stages or targets", () => {
    const baseline = planSupervisedCodeFlow({ task, workState });
    for (const text of ["review README", "oi", "implemente a correção".repeat(100)]) {
      const renamed = {
        ...workState,
        members: workState.members.map((m) => ({ ...m, name: text, role: text, agentRole: text })),
      };
      expect(
        planSupervisedCodeFlow({
          task: { ...task, title: text, description: text },
          workState: renamed,
        }),
      ).toEqual(baseline);
    }
  });
  it("uses verification policy instead of docs keywords", () => {
    const plan = planSupervisedCodeFlow({
      task: { ...task, kind: "docs", verificationPolicy: { mode: "none", requireReview: false } },
      workState,
    });
    expect(plan.stages.find((s) => s.id === "review")).toMatchObject({ skip: true });
    expect(plan.stages.find((s) => s.id === "verify")).toMatchObject({ skip: true });
  });
  it("blocks incomplete dependencies stopped executions and incomplete delivery gates", () => {
    for (const changed of [
      { ...task, dependencyIds: ["missing"] },
      { ...task, stage: "deliver" as const },
    ]) {
      const plan = planSupervisedCodeFlow({ task: changed, workState });
      expect(plan.delegations).toEqual([]);
      expect(plan.stages.find((s) => s.id === changed.stage)?.blocked).toBe(true);
    }
    expect(
      planSupervisedCodeFlow({
        task,
        workState: { ...workState, execution: { id: "e", stopped: true, waitingForUser: false } },
      }).delegations,
    ).toEqual([]);
  });
  it("does not apply to legacy and terminal tasks", () => {
    for (const changed of [
      { ...task, kind: "legacy" as const },
      { ...task, status: "done" as const },
      { ...task, status: "cancelled" as const },
    ]) {
      expect(
        composeSupervisedFlowSection(planSupervisedCodeFlow({ task: changed, workState })),
      ).toBe("");
    }
  });
});
