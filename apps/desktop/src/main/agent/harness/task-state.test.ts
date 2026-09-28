import { describe, expect, it } from "vitest";
import type {
  HarnessTaskClassification,
  HarnessTaskStateSeed,
  PlanRef,
} from "../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";
import { createHarnessTaskState, transitionHarnessTaskState } from "./task-state";

const now = "2026-09-27T00:00:00.000Z";
const simpleLowRisk: HarnessTaskClassification = {
  taskType: "implementation",
  complexity: "simple",
  risk: "low",
  confidence: "high",
  reasons: [],
};
const moderateRisk: HarnessTaskClassification = {
  ...simpleLowRisk,
  complexity: "moderate",
  risk: "medium",
};
const seed: HarnessTaskStateSeed = {
  sessionId: "session-1",
  runId: "run-1",
  workspaceId: "workspace-1",
  goalMessageId: "message-1",
  classification: simpleLowRisk,
  requiredChecks: [],
  todoIds: [],
};

const taskStateWithTests = () =>
  createHarnessTaskState({ ...seed, requiredChecks: ["tests"] }, now);
const alreadyPassingPlan: PlanRef = {
  id: "plan-1",
  sessionId: "session-1",
  workspaceId: "workspace-1",
  title: "Current plan",
  overview: "Plan used to prove run-local evidence reset.",
  path: "C:/workspace/plan.md",
  hash: "plan-hash",
  blocks: [],
  content: "Private plan prose",
  spec: {
    requirements: [{ id: "requirement-1", text: "Private requirement text" }],
    acceptanceCriteria: [
      {
        id: "criterion-1",
        requirementId: "requirement-1",
        description: "Private criterion text",
        todoIds: ["todo-plan-1"],
        requiredCheckKinds: ["tests", "typecheck"],
        status: "passed",
      },
    ],
    evidence: [],
    assumptions: [],
    openQuestions: [],
  },
  todos: [
    {
      id: "todo-plan-1",
      content: "Private plan TODO",
      status: "pending",
      acceptanceCriterionIds: ["criterion-1"],
    },
  ],
  buildStatus: "built",
  createdAt: now,
  updatedAt: now,
};

describe("createHarnessTaskState", () => {
  it("keeps a simple task without requested checks not_required", () => {
    expect(createHarnessTaskState(seed, now).verificationStatus).toBe("not_required");
  });

  it("does not claim an important task without criteria is verified", () => {
    expect(
      createHarnessTaskState({ ...seed, classification: moderateRisk }, now).verificationStatus,
    ).toBe("unknown");
  });

  it("creates one pending criterion per explicit check", () => {
    expect(taskStateWithTests().criteria).toContainEqual({
      criterionId: "check:tests",
      source: "check",
      status: "pending",
      evidenceEventIds: [],
      requiredCheckKinds: ["tests"],
    });
  });

  it("does not carry a prior plan pass into a new run", () => {
    const state = createHarnessTaskState({ ...seed, plan: alreadyPassingPlan }, now);
    expect(state.criteria).toContainEqual({
      criterionId: "opaque:plan-criterion:0",
      source: "plan",
      status: "pending",
      evidenceEventIds: [],
      requiredCheckKinds: ["tests", "typecheck"],
    });
    expect(JSON.stringify(state)).not.toContain("Private criterion text");
    expect(JSON.stringify(state)).not.toContain("Private requirement text");
    expect(JSON.stringify(state)).not.toContain("requirement-1");
    expect(JSON.stringify(state)).not.toContain("Private plan TODO");
    expect(JSON.stringify(state)).not.toContain("todo-plan-1");
    expect(state.planFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses opaque aliases for model-controlled session and plan TODO IDs", () => {
    const state = createHarnessTaskState(
      { ...seed, todoIds: ["sk_test_privatecredential123"], plan: alreadyPassingPlan },
      now,
    );
    expect(state.todoIds).toEqual(["opaque:todo:0", "opaque:plan-todo:0"]);
    expect(JSON.stringify(state)).not.toContain("sk_test_privatecredential123");
    expect(JSON.stringify(state)).not.toContain("todo-plan-1");
  });

  it("fingerprints same-markdown-hash Spec and TODO revisions", () => {
    const baseline = createHarnessTaskState({ ...seed, plan: alreadyPassingPlan }, now);
    const changedSpec: PlanRef = {
      ...alreadyPassingPlan,
      spec: {
        ...alreadyPassingPlan.spec!,
        acceptanceCriteria: [
          { ...alreadyPassingPlan.spec!.acceptanceCriteria[0]!, requiredCheckKinds: ["tests"] },
        ],
      },
    };
    const changedTodo: PlanRef = {
      ...alreadyPassingPlan,
      todos: [{ ...alreadyPassingPlan.todos[0]!, content: "Changed private TODO" }],
    };
    expect(changedSpec.hash).toBe(alreadyPassingPlan.hash);
    expect(changedTodo.hash).toBe(alreadyPassingPlan.hash);
    expect(createHarnessTaskState({ ...seed, plan: changedSpec }, now).planFingerprint).not.toBe(
      baseline.planFingerprint,
    );
    const changedTodoState = createHarnessTaskState({ ...seed, plan: changedTodo }, now);
    expect(changedTodoState.planFingerprint).not.toBe(baseline.planFingerprint);
    expect(JSON.stringify(changedTodoState)).not.toContain("Changed private TODO");
  });

  it("rejects a plan that does not belong to the seed session and workspace", () => {
    expect(() =>
      createHarnessTaskState({
        ...seed,
        plan: { ...alreadyPassingPlan, sessionId: "other-session" },
      }),
    ).toThrow();
    expect(() =>
      createHarnessTaskState({
        ...seed,
        plan: { ...alreadyPassingPlan, workspaceId: "other-workspace" },
      }),
    ).toThrow();
  });

  it("rejects a Task State seed owned by the Chats workspace", () => {
    expect(() =>
      createHarnessTaskState({ ...seed, workspaceId: CHATS_WORKSPACE_ID }, now),
    ).toThrow();
  });
});

describe("transitionHarnessTaskState", () => {
  it("keeps explicit user confirmation distinct from a technical verification pass", () => {
    const confirmed = transitionHarnessTaskState(
      taskStateWithTests(),
      {
        type: "harness.qa",
        sessionId: "session-1",
        runId: "run-1",
        result: {
          required: true,
          status: "user_confirmed",
          reasonCode: "user_confirmed",
          evidence: [
            {
              id: "confirmation-1",
              kind: "user_confirmation",
              status: "user_confirmed",
              runId: "run-1",
              eventId: "event-1",
              label: "User confirmed",
            },
          ],
        },
      },
      now,
    );
    expect(confirmed.verificationStatus).toBe("user_confirmed");
    expect(confirmed.verificationStatus).not.toBe("verified");
    expect(confirmed.criteria[0]?.status).toBe("user_confirmed");
  });

  it("ignores another session or run and does not verify on completion alone", () => {
    const state = taskStateWithTests();
    expect(
      transitionHarnessTaskState(
        state,
        { type: "run.completed", sessionId: "other-session", runId: "run-1" },
        now,
      ),
    ).toBe(state);
    expect(
      transitionHarnessTaskState(
        state,
        { type: "run.completed", sessionId: "session-1", runId: "other-run" },
        now,
      ),
    ).toBe(state);
    expect(
      transitionHarnessTaskState(
        state,
        { type: "run.completed", sessionId: "session-1", runId: "run-1" },
        now,
      ).verificationStatus,
    ).toBe("unknown");
  });

  it("preserves failed and all-user-confirmed outcomes when the run completes", () => {
    const failed = transitionHarnessTaskState(
      taskStateWithTests(),
      {
        type: "harness.qa",
        sessionId: "session-1",
        runId: "run-1",
        result: {
          required: true,
          status: "failed",
          reasonCode: "required_check_failed",
          evidence: [
            {
              id: "tests-failed",
              kind: "check",
              status: "failed",
              runId: "run-1",
              eventId: "event-tests-failed",
              label: "Tests",
            },
          ],
        },
      },
      now,
    );
    expect(
      transitionHarnessTaskState(
        failed,
        {
          type: "run.completed",
          sessionId: "session-1",
          runId: "run-1",
        },
        now,
      ).verificationStatus,
    ).toBe("failed");

    const confirmed = transitionHarnessTaskState(
      taskStateWithTests(),
      {
        type: "harness.qa",
        sessionId: "session-1",
        runId: "run-1",
        result: {
          required: true,
          status: "user_confirmed",
          reasonCode: "user_confirmed",
          evidence: [
            {
              id: "confirmation-1",
              kind: "user_confirmation",
              status: "user_confirmed",
              runId: "run-1",
              eventId: "event-confirmation-1",
              label: "User confirmed",
            },
          ],
        },
      },
      now,
    );
    expect(
      transitionHarnessTaskState(
        confirmed,
        {
          type: "run.completed",
          sessionId: "session-1",
          runId: "run-1",
        },
        now,
      ).verificationStatus,
    ).toBe("user_confirmed");
  });

  it("stores only app-generated question IDs and opaque TODO refs", () => {
    const questioned = transitionHarnessTaskState(
      taskStateWithTests(),
      {
        type: "question.requested",
        sessionId: "session-1",
        request: { id: "question-request-1", runId: "run-1", questions: [] },
      },
      now,
    );
    expect(questioned.openQuestionRefs).toEqual(["question-request-1"]);
    const unsafeQuestionId = transitionHarnessTaskState(
      taskStateWithTests(),
      {
        type: "question.requested",
        sessionId: "session-1",
        request: { id: "PRIVATE question prose", runId: "run-1", questions: [] },
      },
      now,
    );
    expect(unsafeQuestionId.openQuestionRefs).toEqual([]);
    expect(JSON.stringify(unsafeQuestionId)).not.toContain("PRIVATE question prose");

    const withTodos = transitionHarnessTaskState(
      questioned,
      {
        type: "todos.updated",
        sessionId: "session-1",
        todos: [
          { id: "sk_test_privatecredential123", content: "Private TODO text", status: "pending" },
        ],
      },
      now,
    );
    expect(withTodos.todoIds).toEqual(["opaque:todo:0"]);
    expect(JSON.stringify(withTodos)).not.toContain("Private TODO text");
    expect(JSON.stringify(withTodos)).not.toContain("sk_test_privatecredential123");
    const unsafeId = transitionHarnessTaskState(
      withTodos,
      {
        type: "todos.updated",
        sessionId: "session-1",
        todos: [{ id: "PRIVATE TODO prose", content: "Private content", status: "pending" }],
      },
      now,
    );
    expect(unsafeId.todoIds).toEqual(["opaque:todo:0"]);
    expect(JSON.stringify(unsafeId)).not.toContain("PRIVATE TODO prose");
  });

  it("ignores question requests owned by a different nested session", () => {
    const state = taskStateWithTests();
    const result = transitionHarnessTaskState(
      state,
      {
        type: "question.requested",
        sessionId: "session-1",
        request: {
          id: "question-request-1",
          sessionId: "other-session",
          runId: "run-1",
          questions: [],
        },
      },
      now,
    );
    expect(result).toBe(state);
    expect(result.openQuestionRefs).toEqual([]);
  });

  it("uses only matching current-run QA evidence and invalidates it after a later action", () => {
    const withQA = transitionHarnessTaskState(
      taskStateWithTests(),
      {
        type: "harness.qa",
        sessionId: "session-1",
        runId: "run-1",
        result: {
          required: true,
          status: "passed",
          reasonCode: "required_checks_passed",
          evidence: [
            {
              id: "tests-1",
              kind: "check",
              status: "passed",
              runId: "run-1",
              eventId: "event-tests-1",
              revision: "revision-1",
              label: "Tests",
            },
          ],
        },
      },
      now,
    );
    expect(withQA.verificationStatus).toBe("verified");
    expect(withQA.revision).toBe("revision-1");
    const afterTool = transitionHarnessTaskState(
      withQA,
      {
        type: "tool.started",
        sessionId: "session-1",
        runId: "run-1",
        toolCallId: "tool-1",
        toolName: "edit",
      },
      "2026-09-27T00:01:00.000Z",
    );
    expect(afterTool.verificationStatus).toBe("unknown");
    expect(afterTool.criteria[0]?.status).not.toBe("verified");
    expect(afterTool).not.toHaveProperty("revision");

    const afterRevisionlessQA = transitionHarnessTaskState(
      withQA,
      {
        type: "harness.qa",
        sessionId: "session-1",
        runId: "run-1",
        result: {
          required: true,
          status: "missing",
          reasonCode: "required_check_missing",
          evidence: [],
        },
      },
      "2026-09-27T00:02:00.000Z",
    );
    expect(afterRevisionlessQA).not.toHaveProperty("revision");
  });

  it("requires every PlanSpec check kind to pass for the criterion", () => {
    const state = createHarnessTaskState(
      {
        ...seed,
        plan: alreadyPassingPlan,
        requiredChecks: ["tests", "typecheck"],
        todoIds: ["todo-plan-1"],
      },
      now,
    );
    const partial = transitionHarnessTaskState(
      state,
      {
        type: "harness.qa",
        sessionId: "session-1",
        runId: "run-1",
        result: {
          required: true,
          status: "missing",
          reasonCode: "required_check_missing",
          evidence: [
            {
              id: "tests-pass",
              kind: "check",
              status: "passed",
              runId: "run-1",
              eventId: "event-tests-pass",
              label: "Tests",
            },
          ],
        },
      },
      now,
    );
    expect(partial.criteria[0]?.status).not.toBe("verified");
    expect(partial.verificationStatus).toBe("unknown");

    const failed = transitionHarnessTaskState(
      state,
      {
        type: "harness.qa",
        sessionId: "session-1",
        runId: "run-1",
        result: {
          required: true,
          status: "failed",
          reasonCode: "required_check_failed",
          evidence: [
            {
              id: "tests-pass",
              kind: "check",
              status: "passed",
              runId: "run-1",
              eventId: "event-tests-pass",
              label: "Tests",
            },
            {
              id: "typecheck-fail",
              kind: "check",
              status: "failed",
              runId: "run-1",
              eventId: "event-typecheck-fail",
              label: "Typecheck",
            },
          ],
        },
      },
      now,
    );
    expect(failed.criteria[0]?.status).toBe("failed");
    expect(failed.verificationStatus).toBe("failed");

    const passed = transitionHarnessTaskState(
      state,
      {
        type: "harness.qa",
        sessionId: "session-1",
        runId: "run-1",
        result: {
          required: true,
          status: "passed",
          reasonCode: "required_checks_passed",
          evidence: [
            {
              id: "tests-pass",
              kind: "check",
              status: "passed",
              runId: "run-1",
              eventId: "event-tests-pass",
              label: "Tests",
            },
            {
              id: "typecheck-pass",
              kind: "check",
              status: "passed",
              runId: "run-1",
              eventId: "event-typecheck-pass",
              label: "Typecheck",
            },
          ],
        },
      },
      now,
    );
    expect(passed.criteria[0]?.status).toBe("verified");
    expect(passed.verificationStatus).toBe("verified");
  });

  it("settles checkpoint restore, failure, cancellation, and blocking without false verification", () => {
    const state = taskStateWithTests();
    expect(
      transitionHarnessTaskState(
        state,
        {
          type: "checkpoint.restored",
          sessionId: "session-1",
          checkpointId: "checkpoint-1",
        },
        now,
      ).verificationStatus,
    ).toBe("unknown");
    expect(
      transitionHarnessTaskState(
        state,
        {
          type: "run.failed",
          sessionId: "session-1",
          runId: "run-1",
          message: "private error",
        },
        now,
      ).verificationStatus,
    ).toBe("failed");
    expect(
      transitionHarnessTaskState(
        state,
        {
          type: "run.cancelled",
          sessionId: "session-1",
          runId: "run-1",
        },
        now,
      ).verificationStatus,
    ).toBe("unknown");
    expect(
      transitionHarnessTaskState(
        state,
        {
          type: "run.blocked",
          sessionId: "session-1",
          runId: "run-1",
          requestId: "request-1",
          reason: "private reason",
        },
        now,
      ).verificationStatus,
    ).toBe("blocked");
  });

  it("projects plan identifiers but rejects prior or foreign-run plan evidence", () => {
    const state = createHarnessTaskState({ ...seed, plan: alreadyPassingPlan }, now);
    const fromPlan = transitionHarnessTaskState(
      state,
      {
        type: "plan.updated",
        sessionId: "session-1",
        plan: alreadyPassingPlan,
      },
      now,
    );
    expect(fromPlan.planId).toBe("plan-1");
    expect(fromPlan.criteria).toContainEqual({
      criterionId: "opaque:plan-criterion:0",
      source: "plan",
      status: "pending",
      evidenceEventIds: [],
      requiredCheckKinds: ["tests", "typecheck"],
    });
    expect(JSON.stringify(fromPlan)).not.toContain("Private criterion text");
    expect(JSON.stringify(fromPlan)).not.toContain("Private plan prose");
    expect(JSON.stringify(fromPlan)).not.toContain("criterion-1");

    const foreignEvidencePlan: PlanRef = {
      ...alreadyPassingPlan,
      spec: {
        ...alreadyPassingPlan.spec!,
        evidence: [
          {
            id: "foreign-evidence",
            kind: "check",
            status: "passed",
            runId: "other-run",
            eventId: "foreign-event",
            label: "Tests",
            criterionId: "criterion-1",
          },
        ],
      },
    };
    const withForeignEvidence = transitionHarnessTaskState(
      fromPlan,
      {
        type: "plan.updated",
        sessionId: "session-1",
        plan: foreignEvidencePlan,
      },
      now,
    );
    expect(withForeignEvidence.verificationStatus).toBe("pending");
    expect(withForeignEvidence.criteria[0]?.status).not.toBe("verified");
    expect(JSON.stringify(withForeignEvidence)).not.toContain("foreign-event");
    const afterCompletion = transitionHarnessTaskState(
      withForeignEvidence,
      {
        type: "run.completed",
        sessionId: "session-1",
        runId: "run-1",
      },
      now,
    );
    expect(afterCompletion.verificationStatus).toBe("unknown");

    const secretLikeCriterionPlan: PlanRef = {
      ...alreadyPassingPlan,
      spec: {
        ...alreadyPassingPlan.spec!,
        acceptanceCriteria: [
          { ...alreadyPassingPlan.spec!.acceptanceCriteria[0]!, id: "sk_live_secret123456789" },
        ],
      },
    };
    const secretLikeCriteria = createHarnessTaskState(
      { ...seed, plan: secretLikeCriterionPlan },
      now,
    );
    expect(JSON.stringify(secretLikeCriteria)).not.toContain("sk_live_secret123456789");
    expect(secretLikeCriteria.criteria[0]?.criterionId).toBe("opaque:plan-criterion:0");
  });

  it("does not retain verified status when a plan revision removes all criteria", () => {
    const state = createHarnessTaskState(
      {
        ...seed,
        classification: moderateRisk,
        plan: alreadyPassingPlan,
      },
      now,
    );
    const verified = transitionHarnessTaskState(
      state,
      {
        type: "harness.qa",
        sessionId: "session-1",
        runId: "run-1",
        result: {
          required: true,
          status: "passed",
          reasonCode: "required_checks_passed",
          evidence: [
            {
              id: "tests-pass",
              kind: "check",
              status: "passed",
              runId: "run-1",
              eventId: "event-tests-pass",
              revision: "revision-1",
              label: "Tests",
            },
            {
              id: "typecheck-pass",
              kind: "check",
              status: "passed",
              runId: "run-1",
              eventId: "event-typecheck-pass",
              revision: "revision-1",
              label: "Typecheck",
            },
          ],
        },
      },
      now,
    );
    expect(verified.verificationStatus).toBe("verified");
    const noCriteriaPlan: PlanRef = {
      ...alreadyPassingPlan,
      spec: { ...alreadyPassingPlan.spec!, acceptanceCriteria: [] },
    };
    const revised = transitionHarnessTaskState(
      verified,
      {
        type: "plan.updated",
        sessionId: "session-1",
        plan: noCriteriaPlan,
      },
      now,
    );
    expect(revised.criteria).toEqual([]);
    expect(revised.verificationStatus).toBe("unknown");
    expect(revised).not.toHaveProperty("revision");
  });

  it("does not accept invalid evidence identifiers or mismatched check labels", () => {
    const state = taskStateWithTests();
    const invalid = transitionHarnessTaskState(
      state,
      {
        type: "harness.qa",
        sessionId: "session-1",
        runId: "run-1",
        result: {
          required: true,
          status: "passed",
          reasonCode: "required_checks_passed",
          evidence: [
            {
              id: "test",
              kind: "check",
              status: "passed",
              runId: "run-1",
              eventId: "unsafe event prose",
              label: "Tests",
            },
          ],
        },
      },
      now,
    );
    expect(invalid.verificationStatus).toBe("unknown");
    const mismatchedLabel = transitionHarnessTaskState(
      state,
      {
        type: "harness.qa",
        sessionId: "session-1",
        runId: "run-1",
        result: {
          required: true,
          status: "passed",
          reasonCode: "required_checks_passed",
          evidence: [
            {
              id: "test",
              kind: "check",
              status: "passed",
              runId: "run-1",
              eventId: "event-test",
              label: "Typecheck",
            },
          ],
        },
      },
      now,
    );
    expect(mismatchedLabel.verificationStatus).toBe("unknown");
  });
});
