# Verifier-First Task State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the run-scoped, rehydratable Task State foundation that distinguishes verified work from missing, stale, blocked, failed, or inapplicable verification.

**Status:** Draft; this plan requires user approval before implementation.

**Architecture:** Implement a pure reducer over typed run/plan/TODO/QA events, persist bounded snapshots in the existing `agent_events` store, and connect it to the existing `PiSdkRuntime` run tracker. `PlanSpec`, TODO storage, Auto QA, the permission broker, and run lifecycle remain authoritative; Task State adds references and derived status rather than copying prompts or creating another task store.

**Tech Stack:** TypeScript, Vitest, existing SQLite adapter, Pi SDK runtime, existing AgentEvent/PlanSpec/Auto QA contracts.

**Spec:** `docs/superpowers/specs/2026-09-27-modus-adaptive-harness-core-design.md`, especially “Verifier-First Task State” and “Security, privacy, reliability, and non-goals”.

## Global Constraints

- Preserve PiSdkRuntime, ToolRegistry, permission broker, Plan/Spec/TODO, Auto QA, Context Planner, CodeGraph, and current continuation limits.
- Do not duplicate TODO or PlanSpec content; store stable references/statuses only.
- Task State must not copy raw prompts, model output, shell commands, command output, credentials, or arbitrary errors.
- Bind every state/event to its owning run and session; reject mismatched ownership when rehydrating.
- Simple, low-risk tasks with no required criteria remain `not_required`; important tasks without applicable criteria/evidence remain `unknown`, never `verified`.
- Only main-authored, current-run evidence can mark criteria verified; stale or post-change evidence cannot false-pass.
- No permission bypass, automatic Build consent, external retrieval, or subagent dispatch is introduced in this phase.
- Phase 2 Gate 2 remains formally open under the user's prior override; this plan does not claim it closed.
- No new dependencies or new database/table.
- Treat TODO and PlanSpec IDs as model-controlled regardless of shape: persist ordinal opaque aliases (`opaque:todo:<index>`, `opaque:plan-todo:<index>`, `opaque:plan-criterion:<index>`), never their supplied values. App-generated owner/event/question IDs may pass the safe-ID validator.

---

## File Map

- Create `apps/desktop/src/main/agent/harness/task-state.ts`: pure Task State initialization, state transition, and terminal verification rules.
- Create `apps/desktop/src/main/agent/harness/task-state.test.ts`: pure reducer tests, no Electron runtime or disk database.
- Modify `apps/desktop/src/shared/contracts.ts`: bounded Task State types and a main-authored `harness.task_state` AgentEvent.
- Modify `apps/desktop/src/main/agent/agent-event-store.ts` and `.test.ts`: exact-run Task State rehydration, post-run-start checkpoint-restore boundary query, and real-SQLite ownership/privacy/QA-scope tests.
- Modify `apps/desktop/src/main/agent/pi-sdk-runtime.ts` and `.test.ts`: seed Task State only after the authoritative fresh-run boundary, observe runtime events, and pass the current restore boundary into all QA summaries without changing permission or continuation behavior.
- Modify `apps/desktop/src/main/git/git-service.ts` and `.test.ts`: add a strict change-scope read that distinguishes a successful empty diff from failed Git commands or truncated paths, while preserving the tolerant summary API for other callers.
- Modify `apps/desktop/src/main/ipc/register-app-ipc.test.ts`: prove the existing checkpoint-restore IPC path persists and publishes the `checkpoint.restored` event consumed by the store-derived boundary.

No renderer/UI or IPC surface is added in Phase 1. The live state is an internal main-process projection consumed by later Meta Controller work; existing timeline consumers ignore the new event type.

## Interfaces

Task 1 defines these shared shapes in `shared/contracts.ts`:

```ts
export type HarnessTaskPhase =
  | "preflight"
  | "awaiting_user"
  | "planning"
  | "executing"
  | "verifying"
  | "terminal";

export type HarnessTaskVerificationStatus =
  | "not_required"
  | "pending"
  | "verified"
  | "user_confirmed"
  | "failed"
  | "unknown"
  | "blocked";

export type HarnessTaskCheckKind = "tests" | "typecheck" | "lint" | "build";

export type HarnessTaskCriterionState = {
  criterionId: string;
  source: "plan" | "check";
  status: "pending" | "verified" | "failed" | "unknown" | "blocked" | "user_confirmed";
  evidenceEventIds: string[];
  requiredCheckKinds?: HarnessTaskCheckKind[];
};

export type HarnessTaskEvidenceRef = {
  eventId: string;
  kind: "check" | "user_confirmation";
  status: VerificationEvidenceStatus;
  revision?: string;
  criterionId?: string;
};

export type HarnessTaskState = {
  version: 1;
  sessionId: string;
  runId: string;
  workspaceId: string;
  goalMessageId: string;
  planId?: string;
  planFingerprint?: string;
  classification: HarnessTaskClassification;
  phase: HarnessTaskPhase;
  verificationStatus: HarnessTaskVerificationStatus;
  criteria: HarnessTaskCriterionState[];
  constraintRefs: string[];
  openQuestionRefs: string[];
  todoIds: string[];
  hypothesisRefs: string[];
  evidenceRefs: HarnessTaskEvidenceRef[];
  revision?: string;
  updatedAt: string;
};
```

The event envelope is `AgentEvent = ... | { type: "harness.task_state"; sessionId: string; runId: string; state: HarnessTaskState }`. Its `state` fields are stable identifiers/statuses only; it carries no prompt or output text.

`createHarnessTaskState()` receives an optional PlanRef projection, never the raw user prompt:

```ts
export type HarnessTaskStateSeed = {
  sessionId: string;
  runId: string;
  workspaceId: string;
  goalMessageId: string;
  classification: HarnessTaskClassification;
  requiredChecks: HarnessTaskCheckKind[];
  /** Source IDs are in-memory inputs only; the initializer emits opaque ordinal aliases. */
  todoIds: string[];
  /** Plan content/IDs are read in memory for projection only, never copied to Task State. */
  plan?: Pick<PlanRef, "id" | "sessionId" | "workspaceId" | "spec" | "todos" | "hash">;
  revision?: string;
};

export function createHarnessTaskState(input: HarnessTaskStateSeed, now?: string): HarnessTaskState;
export function transitionHarnessTaskState(
  state: HarnessTaskState,
  event: AgentEvent,
  now?: string,
): HarnessTaskState;
```

The pure module defines `SAFE_TASK_STATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/` for app-generated
owner/event/question IDs,
`MAX_TASK_STATE_CRITERIA = 128`, `MAX_TASK_STATE_REFS = 256`,
`MAX_TASK_STATE_EVIDENCE = 256`, `MAX_TASK_STATE_EVIDENCE_PER_CRITERION = 16`,
`MAX_TASK_STATE_SCAN = 256`, and `MAX_TASK_STATE_EVENT_BYTES = 262144`. A seed PlanRef must match both
`sessionId` and `workspaceId`; compute `planFingerprint` from its Markdown hash plus the structured
requirements, acceptance-criterion IDs/text/check kinds/TODO links, assumptions/open questions, and TODO
IDs/content/linkage. Exclude mutable statuses/evidence/timestamps from the fingerprint, then store only
the digest. Map every model-controlled criterion/TODO ID to its ordinal opaque alias before state
construction; never persist raw input IDs, even if they match the safe-ID regex.

Compute the fingerprint with this pure implementation in `task-state.ts`; it deliberately includes
structured prose only as hash input and excludes mutable evidence/status fields:

```ts
import { createHash } from "node:crypto";

function taskPlanFingerprint(
  plan: Pick<PlanRef, "id" | "hash" | "spec" | "todos">,
): string {
  const spec = plan.spec
    ? {
        requirements: plan.spec.requirements.map(({ id, text }) => ({ id, text })),
        acceptanceCriteria: plan.spec.acceptanceCriteria.map(
          ({ id, requirementId, description, todoIds, requiredCheckKinds }) => ({
            id,
            requirementId,
            description,
            todoIds,
            requiredCheckKinds: [...(requiredCheckKinds ?? [])].sort(),
          }),
        ),
        assumptions: plan.spec.assumptions,
        openQuestions: plan.spec.openQuestions,
      }
    : undefined;
  const todos = plan.todos.map(({ id, content, acceptanceCriterionIds }) => ({
    id,
    content,
    acceptanceCriterionIds: acceptanceCriterionIds ?? [],
  }));
  return createHash("sha256")
    .update(JSON.stringify({ id: plan.id, markdownHash: plan.hash, spec, todos }), "utf8")
    .digest("hex");
}
```

The resulting digest detects same-Markdown-hash `PlanSpec`/TODO edits without persisting their text.

The exact-run store API produced by Task 2 is:

```ts
export function getLatestHarnessTaskState(
  sessionId: string,
  runId: string,
): HarnessTaskState | undefined;
```

## Task 1: Define Task State and Pure Verifier-First Reducer

**Files:**
- Modify `apps/desktop/src/shared/contracts.ts`.
- Create `apps/desktop/src/main/agent/harness/task-state.ts`.
- Create `apps/desktop/src/main/agent/harness/task-state.test.ts`.

**Consumes:** `HarnessTaskClassification`, `PlanRef`, `PlanAcceptanceCriterion`, `HarnessQAResult`, `AgentEvent`, and `VerificationEvidenceStatus` from existing shared contracts.

**Produces:** `HarnessTaskState`, `HarnessTaskStateSeed`, the new `harness.task_state` event, `createHarnessTaskState()`, and `transitionHarnessTaskState()` as defined above.

- [ ] **Step 1: Write RED tests for initialization and required-evidence defaults.** In `task-state.test.ts`, define these shared fixtures at module scope, then add separate tests for simple, important-without-criteria, explicit-check, and pre-existing-plan-evidence states.

```ts
import { describe, expect, it } from "vitest";
import type {
  HarnessTaskClassification,
  HarnessTaskStateSeed,
  PlanRef,
} from "../../../shared/contracts";
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
  todos: [{
    id: "todo-plan-1",
    content: "Private plan TODO",
    status: "pending",
    acceptanceCriterionIds: ["criterion-1"],
  }],
  buildStatus: "built",
  createdAt: now,
  updatedAt: now,
};

describe("createHarnessTaskState", () => {
  it("keeps a simple task without requested checks not_required", () => {
    const state = createHarnessTaskState(seed, now);
    expect(state.verificationStatus).toBe("not_required");
  });

  it("does not claim an important task without criteria is verified", () => {
    const state = createHarnessTaskState({ ...seed, classification: moderateRisk }, now);
    expect(state.verificationStatus).toBe("unknown");
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
    const state = createHarnessTaskState({
      ...seed,
      todoIds: ["sk_test_privatecredential123"],
      plan: alreadyPassingPlan,
    }, now);
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
        acceptanceCriteria: [{
          ...alreadyPassingPlan.spec!.acceptanceCriteria[0]!,
          requiredCheckKinds: ["tests"],
        }],
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
});
```

- [ ] **Step 2: Test user confirmation as distinct from technical verification.** In a separate test, seed the check state with `taskStateWithTests()`, feed a main-authored confirmation result to the reducer, and assert it does not become a test pass:

```ts
it("keeps explicit user confirmation distinct from a technical verification pass", () => {
  const confirmed = transitionHarnessTaskState(taskStateWithTests(), {
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
  }, now);
  expect(confirmed.verificationStatus).toBe("user_confirmed");
  expect(confirmed.verificationStatus).not.toBe("verified");
  expect(confirmed.criteria[0]?.status).toBe("user_confirmed");
});
```

- [ ] **Step 3: Run the pure test file and confirm the missing exports fail.** From `apps/desktop`, run `npx vitest run --root ../.. apps/desktop/src/main/agent/harness/task-state.test.ts`. Expected RED: `createHarnessTaskState` and `transitionHarnessTaskState` are not exported.
- [ ] **Step 4: Add the shared types and initializer.** Add the interfaces/constants above. Require any seed PlanRef to match the seed session/workspace; store `planId` and `taskPlanFingerprint(plan)`, never PlanSpec text. Create one pending plan criterion with its `requiredCheckKinds` per accepted PlanSpec criterion, resetting prior `PlanAcceptanceCriterion.status` and evidence; name every plan criterion `opaque:plan-criterion:<index>`, never its supplied ID. Assign `opaque:plan-todo:<index>` aliases to plan TODOs and `opaque:todo:<index>` aliases to session TODOs, never storing their supplied IDs. Create one pending `check:<kind>` criterion with `requiredCheckKinds: [kind]` per explicit required check. For moderate/complex or medium/high-risk work with no applicable criteria, initialize `verificationStatus: "unknown"`; for simple/low-risk work with no criteria/checks, use `not_required`.
- [ ] **Step 5: Verify initialization GREEN.** Rerun the pure test file and assert `check:tests` is added exactly once, prior `PlanSpec` pass statuses do not pre-verify a new run, and `goalMessageId` is referenced without storing prompt text.
- [ ] **Step 6: Add failing reducer transition tests.** Add these focused cases in `task-state.test.ts` using the module-scope fixtures from Step 1. The event shapes below are from the existing `AgentEvent` contract:

```ts
describe("transitionHarnessTaskState", () => {
  it("ignores another session or run and does not verify on completion alone", () => {
    const state = taskStateWithTests();
    expect(
      transitionHarnessTaskState(state, {
        type: "run.completed",
        sessionId: "other-session",
        runId: "run-1",
      }, now),
    ).toBe(state);
    expect(
      transitionHarnessTaskState(state, {
        type: "run.completed",
        sessionId: "session-1",
        runId: "other-run",
      }, now),
    ).toBe(state);
    expect(
      transitionHarnessTaskState(state, {
        type: "run.completed",
        sessionId: "session-1",
        runId: "run-1",
      }, now).verificationStatus,
    ).toBe("unknown");
  });

  it("stores only app-generated question IDs and opaque TODO refs", () => {
    const questioned = transitionHarnessTaskState(taskStateWithTests(), {
      type: "question.requested",
      sessionId: "session-1",
      request: { id: "question-request-1", runId: "run-1", questions: [] },
    }, now);
    expect(questioned.openQuestionRefs).toEqual(["question-request-1"]);
    const unsafeQuestionId = transitionHarnessTaskState(taskStateWithTests(), {
      type: "question.requested",
      sessionId: "session-1",
      request: { id: "PRIVATE question prose", runId: "run-1", questions: [] },
    }, now);
    expect(unsafeQuestionId.openQuestionRefs).toEqual([]);
    expect(JSON.stringify(unsafeQuestionId)).not.toContain("PRIVATE question prose");

    const withTodos = transitionHarnessTaskState(questioned, {
      type: "todos.updated",
      sessionId: "session-1",
      todos: [{ id: "sk_test_privatecredential123", content: "Private TODO text", status: "pending" }],
    }, now);
    expect(withTodos.todoIds).toEqual(["opaque:todo:0"]);
    expect(JSON.stringify(withTodos)).not.toContain("Private TODO text");
    expect(JSON.stringify(withTodos)).not.toContain("sk_test_privatecredential123");
    const unsafeId = transitionHarnessTaskState(withTodos, {
      type: "todos.updated",
      sessionId: "session-1",
      todos: [{ id: "PRIVATE TODO prose", content: "Private content", status: "pending" }],
    }, now);
    expect(unsafeId.todoIds).toEqual(["opaque:todo:0"]);
    expect(JSON.stringify(unsafeId)).not.toContain("PRIVATE TODO prose");
  });

  it("uses only matching current-run QA evidence and invalidates it after a later action", () => {
    const withQA = transitionHarnessTaskState(taskStateWithTests(), {
      type: "harness.qa",
      sessionId: "session-1",
      runId: "run-1",
      result: {
        required: true,
        status: "passed",
        reasonCode: "required_checks_passed",
        evidence: [{
          id: "tests-1",
          kind: "check",
          status: "passed",
          runId: "run-1",
          eventId: "event-tests-1",
          revision: "revision-1",
          label: "Tests",
        }],
      },
    }, now);
    expect(withQA.verificationStatus).toBe("verified");
    expect(withQA.revision).toBe("revision-1");
    const afterTool = transitionHarnessTaskState(withQA, {
      type: "tool.started",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "edit",
    }, "2026-09-27T00:01:00.000Z");
    expect(afterTool.verificationStatus).toBe("unknown");
    expect(afterTool.criteria[0]?.status).not.toBe("verified");
  });

  it("requires every PlanSpec check kind to pass for the criterion", () => {
    const state = createHarnessTaskState({
      ...seed,
      plan: alreadyPassingPlan,
      requiredChecks: ["tests", "typecheck"],
      todoIds: ["todo-plan-1"],
    }, now);
    const partial = transitionHarnessTaskState(state, {
      type: "harness.qa",
      sessionId: "session-1",
      runId: "run-1",
      result: {
        required: true,
        status: "missing",
        reasonCode: "required_check_missing",
        evidence: [{
          id: "tests-pass",
          kind: "check",
          status: "passed",
          runId: "run-1",
          eventId: "event-tests-pass",
          label: "Tests",
        }],
      },
    }, now);
    expect(partial.criteria[0]?.status).not.toBe("verified");
    expect(partial.verificationStatus).toBe("unknown");

    const failed = transitionHarnessTaskState(state, {
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
    }, now);
    expect(failed.criteria[0]?.status).toBe("failed");
    expect(failed.verificationStatus).toBe("failed");

    const passed = transitionHarnessTaskState(state, {
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
    }, now);
    expect(passed.criteria[0]?.status).toBe("verified");
    expect(passed.verificationStatus).toBe("verified");
  });

  it("settles checkpoint restore, failure, cancellation, and blocking without false verification", () => {
    const state = taskStateWithTests();
    expect(transitionHarnessTaskState(state, {
      type: "checkpoint.restored", sessionId: "session-1", checkpointId: "checkpoint-1",
    }, now).verificationStatus).toBe("unknown");
    expect(transitionHarnessTaskState(state, {
      type: "run.failed", sessionId: "session-1", runId: "run-1", message: "private error",
    }, now).verificationStatus).toBe("failed");
    expect(transitionHarnessTaskState(state, {
      type: "run.cancelled", sessionId: "session-1", runId: "run-1",
    }, now).verificationStatus).toBe("unknown");
    expect(transitionHarnessTaskState(state, {
      type: "run.blocked", sessionId: "session-1", runId: "run-1",
      requestId: "request-1", reason: "private reason",
    }, now).verificationStatus).toBe("blocked");
  });

  it("projects plan identifiers but rejects prior or foreign-run plan evidence", () => {
    const state = createHarnessTaskState({ ...seed, plan: alreadyPassingPlan }, now);
    const fromPlan = transitionHarnessTaskState(state, {
      type: "plan.updated",
      sessionId: "session-1",
      plan: alreadyPassingPlan,
    }, now);
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
        evidence: [{
          id: "foreign-evidence",
          kind: "check",
          status: "passed",
          runId: "other-run",
          eventId: "foreign-event",
          label: "Tests",
          criterionId: "criterion-1",
        }],
      },
    };
    const withForeignEvidence = transitionHarnessTaskState(fromPlan, {
      type: "plan.updated",
      sessionId: "session-1",
      plan: foreignEvidencePlan,
    }, now);
    expect(withForeignEvidence.verificationStatus).toBe("pending");
    expect(withForeignEvidence.criteria[0]?.status).not.toBe("verified");
    expect(JSON.stringify(withForeignEvidence)).not.toContain("foreign-event");
    const afterCompletion = transitionHarnessTaskState(withForeignEvidence, {
      type: "run.completed",
      sessionId: "session-1",
      runId: "run-1",
    }, now);
    expect(afterCompletion.verificationStatus).toBe("unknown");

    const secretLikeCriterionPlan: PlanRef = {
      ...alreadyPassingPlan,
      spec: {
        ...alreadyPassingPlan.spec!,
        acceptanceCriteria: [{
          ...alreadyPassingPlan.spec!.acceptanceCriteria[0]!,
          id: "sk_live_secret123456789",
        }],
      },
    };
    const secretLikeCriteria = createHarnessTaskState({ ...seed, plan: secretLikeCriterionPlan }, now);
    expect(JSON.stringify(secretLikeCriteria)).not.toContain("sk_live_secret123456789");
    expect(secretLikeCriteria.criteria[0]?.criterionId).toBe("opaque:plan-criterion:0");
  });
});
```

The `run.completed` expectation is `unknown` for this important/check-required state, never `verified`.
- [ ] **Step 7: Implement `transitionHarnessTaskState`.** Use the event envelope as the ownership boundary, then update only stable IDs/status/revision fields. The first lines of the reducer must be equivalent to:

```ts
export function transitionHarnessTaskState(
  state: HarnessTaskState,
  event: AgentEvent,
  now = new Date().toISOString(),
): HarnessTaskState {
  if (event.sessionId !== state.sessionId) return state;
  if ("runId" in event && typeof event.runId === "string" && event.runId !== state.runId) {
    return state;
  }
  return reduceHarnessTaskEvent(state, event, now);
}
```

Define `reduceHarnessTaskEvent(state, event, now)` in the same module as a switch over the supported
event variants, with a default no-op. Session-only `question.*` and `todos.updated` events may change
only safe request/TODO references, never evidence or verification status; when `question.requested`
contains `request.runId`, it must match the active state run. A `plan.updated` event may
change references only when plan ID, session, workspace, and `planFingerprint` match; it never verifies from
`PlanAcceptanceCriterion.status` or `PlanSpec.evidence`, and never copies evidence IDs from the plan.
The runtime must pass a plan event to the reducer only if rereading the owning PlanStore confirms the
event hash is still current. If the current authoritative plan hash changes during the run, update
`planFingerprint`, rebuild criterion references from the new PlanSpec, and clear prior plan-criterion
evidence/statuses before processing further QA.
For `harness.qa`, require the outer run to match, accept only `kind: "check"` evidence with matching
`runId`, safe `eventId`, and the mapped label (`tests` → `Tests`, `typecheck` → `Typecheck`, `lint` →
`Lint`, `build` → `Build`). A check criterion is verified only by its own passed evidence. A plan
criterion with required check kinds is verified only when every required kind has a distinct matching
passed evidence event; a partial pass remains `unknown`, any failed required check is `failed`, and
missing/unavailable/skipped/foreign-run evidence never passes. Never infer criterion coverage from the
overall QA status alone. Copy a bounded evidence revision only from this current-run QA event. Model
`user_confirmed` separately and never count it as `verified`. Any later `tool.started` or checkpoint
restore clears prior verified criterion evidence and settles required verification as `unknown` until
fresh QA. On `run.completed`, retain `verified` only if every applicable criterion still has all matching
current-run evidence; otherwise settle required work as `unknown`. `run.failed` becomes `failed`,
`run.blocked` becomes `blocked`, and `run.cancelled` becomes `unknown`. Do not copy message text,
question answers, TODO/plan prose, paths, command args/output, error messages, or event payloads into
the projection.
- [ ] **Step 8: Run transition tests GREEN and format the pure module.** Run the pure task-state suite and Biome on `shared/contracts.ts`, `task-state.ts`, and `task-state.test.ts`; then run `git diff --check` from the worktree root.
- [ ] **Step 9: Commit Task 1.** Stage only the contracts and pure state module/tests; commit as `feat(agent): add verifier-first task state reducer`.

## Task 2: Persist State and Enforce Post-Restore Evidence Boundaries

**Files:**
- Modify `apps/desktop/src/main/agent/agent-event-store.ts`.
- Modify `apps/desktop/src/main/agent/agent-event-store.test.ts`.

**Consumes:** `HarnessTaskState` and the `harness.task_state` event from Task 1; existing `recordAgentEvent()` and `getDatabase()`.

**Produces:** `getLatestHarnessTaskState(sessionId, runId)`, `recordAgentEvent(event): number` returning the inserted SQLite rowid, `getLatestCheckpointRestoreRowId(sessionId, runStartedRowId)`, and `getRunToolEvidence(sessionId, runId, afterRowId?)` for evidence strictly after a restore boundary.

- [ ] **Step 1: Add DB-backed RED cases.** Reuse `insertSession()`/`insertSessionInWorkspace()` and `createAgentRun()` in `agent-event-store.test.ts`. Persist two snapshots for one run and assert the latest exact-owner state is returned; add a sibling-session forged event and a later malformed version, both of which must return `undefined`. Assert returned state JSON excludes the run prompt. Add the restore-boundary case below: a pre-restore successful check must not pass end-of-turn QA until its tool pair is rerun after the boundary.

```ts
const taskStateClassification: HarnessTaskClassification = {
  taskType: "implementation",
  complexity: "simple",
  risk: "low",
  confidence: "high",
  reasons: [],
};

function taskStateFixture(
  sessionId: string,
  workspaceId: string,
  runId: string,
  updatedAt: string,
): HarnessTaskState {
  return {
    version: 1,
    sessionId,
    runId,
    workspaceId,
    goalMessageId: "message-1",
    classification: taskStateClassification,
    phase: "executing",
    verificationStatus: "not_required",
    criteria: [],
    constraintRefs: [],
    openQuestionRefs: [],
    todoIds: [],
    hypothesisRefs: [],
    evidenceRefs: [],
    updatedAt,
  };
}

describe("getLatestHarnessTaskState", () => {
  it("returns only the latest valid snapshot owned by the exact session and run", () => {
    const sessionId = `state-${crypto.randomUUID()}`;
    const siblingSessionId = `sibling-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const workspaceId = `workspace-${sessionId}`;
    insertSessionInWorkspace(siblingSessionId, workspaceId);
    const run = createAgentRun({ sessionId, prompt: "PRIVATE_PROMPT" });
    const otherRun = createAgentRun({ sessionId, prompt: "OTHER_PRIVATE_PROMPT" });
    const earlier = taskStateFixture(sessionId, workspaceId, run.id, "2026-09-27T00:00:00.000Z");
    const latest = taskStateFixture(sessionId, workspaceId, run.id, "2026-09-27T00:01:00.000Z");
    recordAgentEvent({ type: "harness.task_state", sessionId, runId: run.id, state: earlier });
    recordAgentEvent({ type: "harness.task_state", sessionId, runId: run.id, state: latest });
    recordAgentEvent({
      type: "harness.task_state",
      sessionId: siblingSessionId,
      runId: run.id,
      state: taskStateFixture(siblingSessionId, workspaceId, run.id, "2026-09-27T00:02:00.000Z"),
    });
    recordAgentEvent({
      type: "harness.task_state",
      sessionId,
      runId: otherRun.id,
      state: taskStateFixture(sessionId, workspaceId, otherRun.id, "2026-09-27T00:03:00.000Z"),
    });

    expect(getLatestHarnessTaskState(sessionId, run.id)).toEqual(latest);
    expect(JSON.stringify(getLatestHarnessTaskState(sessionId, run.id))).not.toContain("PRIVATE_PROMPT");
    expect(getLatestHarnessTaskState(siblingSessionId, run.id)).toBeUndefined();
    expect(getLatestHarnessTaskState(sessionId, otherRun.id)).toEqual(
      taskStateFixture(sessionId, workspaceId, otherRun.id, "2026-09-27T00:03:00.000Z"),
    );
  });

  it("fails closed on malformed latest snapshots instead of returning an older pass", () => {
    const cases = [
      {
        suffix: "invalid-json",
        payload: (_sessionId: string, _runId: string, _state: HarnessTaskState) => "{",
      },
      {
        suffix: "missing-run-id",
        payload: (sessionId: string, _runId: string, state: HarnessTaskState) =>
          JSON.stringify({ type: "harness.task_state", sessionId, state }),
      },
      {
        suffix: "invalid-state",
        payload: (sessionId: string, runId: string, state: HarnessTaskState) =>
          JSON.stringify({
            type: "harness.task_state",
            sessionId,
            runId,
            state: { ...state, version: 9 },
          }),
      },
      {
        suffix: "unexpected-field",
        payload: (sessionId: string, runId: string, state: HarnessTaskState) =>
          JSON.stringify({
            type: "harness.task_state",
            sessionId,
            runId,
            state: { ...state, prompt: "PRIVATE_PROMPT" },
          }),
      },
      {
        suffix: "oversized",
        payload: (sessionId: string, runId: string, state: HarnessTaskState) =>
          JSON.stringify({ type: "harness.task_state", sessionId, runId, state }).padEnd(262145, " "),
      },
    ] as const;

    for (const invalid of cases) {
      const sessionId = `malformed-${invalid.suffix}-${crypto.randomUUID()}`;
      insertSession(sessionId);
      const workspaceId = `workspace-${sessionId}`;
      const run = createAgentRun({ sessionId, prompt: "PRIVATE_PROMPT" });
      const earlier = taskStateFixture(sessionId, workspaceId, run.id, "2026-09-27T00:00:00.000Z");
      recordAgentEvent({ type: "harness.task_state", sessionId, runId: run.id, state: earlier });
      const payload = invalid.payload(sessionId, run.id, earlier);
      getDatabase()
        .prepare(
          "insert into agent_events (id, session_id, type, payload_json, created_at) values (?, ?, ?, ?, ?)",
        )
        .run(
          `malformed-state-${invalid.suffix}-${crypto.randomUUID()}`,
          sessionId,
          "harness.task_state",
          payload,
          new Date().toISOString(),
        );
      expect(getLatestHarnessTaskState(sessionId, run.id)).toBeUndefined();
    }
  });

  it("rejects a snapshot whose workspace does not match the owning session", () => {
    const sessionId = `workspace-state-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const workspaceId = `workspace-${sessionId}`;
    const run = createAgentRun({ sessionId, prompt: "PRIVATE_PROMPT" });
    const state = taskStateFixture(sessionId, workspaceId, run.id, "2026-09-27T00:00:00.000Z");
    recordAgentEvent({
      type: "harness.task_state",
      sessionId,
      runId: run.id,
      state: { ...state, workspaceId: "foreign-workspace" },
    });
    expect(getLatestHarnessTaskState(sessionId, run.id)).toBeUndefined();
  });
});

describe("post-restore QA evidence", () => {
  it("rejects a passing check from before restore and accepts a rerun afterward", () => {
    const sessionId = `restore-state-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "Run tests" });
    recordAgentEvent({
      type: "checkpoint.restored",
      sessionId,
      checkpointId: "restore-before-run",
    });
    const runStartedRowId = recordAgentEvent({
      type: "run.started",
      sessionId,
      runId: run.id,
      userMessageId: "message-1",
      delivery: "normal",
    });
    const recordPassingTests = (toolCallId: string) => {
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId,
        toolName: "bash",
        args: { command: "npm test" },
      });
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId,
        toolName: "bash",
        isError: false,
        exitCode: 0,
      });
    };

    recordPassingTests("before-restore");
    const restoreRowId = recordAgentEvent({
      type: "checkpoint.restored",
      sessionId,
      checkpointId: "checkpoint-1",
    });
    expect(getLatestCheckpointRestoreRowId(sessionId, runStartedRowId)).toBe(restoreRowId);
    expect(restoreRowId).toBeGreaterThan(0);
    expect(getRunToolEvidence(sessionId, run.id, restoreRowId)).toEqual([]);
    expect(summarizeRunQA({
      sessionId,
      runId: run.id,
      changedPaths: [],
      requiredChecks: ["tests"],
      events: getRunToolEvidence(sessionId, run.id, restoreRowId),
    }).status).toBe("missing");

    recordPassingTests("after-restore");
    expect(summarizeRunQA({
      sessionId,
      runId: run.id,
      changedPaths: [],
      requiredChecks: ["tests"],
      events: getRunToolEvidence(sessionId, run.id, restoreRowId),
    }).status).toBe("passed");
  });
});
```

Add `import type { HarnessTaskClassification, HarnessTaskState } from "../../shared/contracts";`
and add `getLatestHarnessTaskState` to the existing dynamic import from `agent-event-store.ts`.
Add `getLatestCheckpointRestoreRowId` to the event-store dynamic import; add `summarizeRunQA` to the
dynamic import from `harness/qa-evidence.ts`; use the existing `getRunToolEvidence` import for the
restore-boundary test.
- [ ] **Step 2: Run the event-store test and confirm the new APIs fail.** From `apps/desktop`, run `npx vitest run --root ../.. apps/desktop/src/main/agent/agent-event-store.test.ts`. Expected RED: `getLatestHarnessTaskState` is not exported, `recordAgentEvent()` does not return its inserted rowid, and `getRunToolEvidence()` ignores the restore boundary.
- [ ] **Step 3: Implement bounded fail-closed snapshot scanning and an ordered QA boundary.** Do not call SQLite `json_extract()` on untrusted Task State `payload_json`. First select only the newest 256 `harness.task_state` row IDs, byte lengths, and session workspace IDs for the requested session:

```sql
select e.rowid as event_rowid,
       length(cast(e.payload_json as blob)) as payload_bytes,
       s.workspace_id
from agent_events e
join agent_sessions s on s.id = e.session_id
where e.session_id = ?
  and e.type = 'harness.task_state'
order by e.rowid desc
limit 256;
```

Use `MAX_TASK_STATE_SCAN` in place of the SQL literal in implementation. Iterate newest-first. Reject
immediately if a candidate exceeds `MAX_TASK_STATE_EVENT_BYTES`; fetch its payload only after the byte
check:

```sql
select payload_json from agent_events where rowid = ?;
```

Parse JSON in `try/catch` as `unknown`; require exact event type, only the `type`, `sessionId`, `runId`,
and `state` envelope keys, and safe session/run IDs. Skip a well-formed event whose run ID differs from
the requested run. If a candidate cannot be attributed safely (invalid JSON, missing/unsafe run ID,
wrong envelope session), return `undefined` rather than falling through to an older pass. For the first
exact-run event, require a valid state shape and `state.workspaceId === row.workspace_id`, then confirm
ownership with this prompt-free query:

```sql
select 1 from agent_runs where id = ? and session_id = ? limit 1;
```

Reconstruct and return only the allowlisted `HarnessTaskState` fields; reject unknown top-level or nested
keys, malformed classification/phase/status/criterion/evidence enums, unsafe IDs, invalid timestamps,
and any array/count/length overflow. Validate at most 128 criteria, 256 strings in each reference array,
256 evidence refs total, 16 evidence IDs per criterion, and 32 classification reason codes of at most
128 characters each. Validate only the `check` and `user_confirmation` evidence kinds in this phase. A malformed exact-run latest snapshot returns
`undefined` and must never fall back to an older passing snapshot. Never select `agent_runs.prompt` or
call `listAgentEvents()`.

Change `recordAgentEvent()` to return `Number(insertResult.lastInsertRowid)`. Add an optional `afterRowId`
parameter to `getRunToolEvidence()` and apply `e.rowid > afterRowId` to the existing tool-event query
before pairing `tool.started`/`tool.ended`; omitting the parameter preserves the existing behavior. This
excludes both halves of any QA call started before a checkpoint restore, including a call that ends
after restore. The restore-boundary test in Step 1 must prove pre-restore pass → restore → no rerun yields
`missing`, while a new tool pair after the boundary yields `passed`.

Implement the durable row ID return with this exact mutation of `recordAgentEvent()`:

```ts
export function recordAgentEvent(event: AgentEvent): number {
  const insertResult = getDatabase()
    .prepare(
      `insert into agent_events (id, session_id, type, payload_json, created_at)
       values (?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), event.sessionId, event.type, JSON.stringify(event), new Date().toISOString());
  return Number(insertResult.lastInsertRowid);
}
```

Keep the existing bounded event-row order and add the nullable boundary predicate:

```sql
and (? is null or e.rowid > ?)
```

Bind `afterRowId ?? null` twice; when present, require it to be a positive safe integer or return an
empty evidence list. The two-argument `getRunToolEvidence(sessionId, runId)` call remains backward
compatible.

Derive the boundary from the actual IPC-persisted restore event with this bounded query:

```sql
select rowid
from agent_events
where session_id = ?
  and type = 'checkpoint.restored'
  and rowid > ?
order by rowid desc
limit 1;
```

Export `getLatestCheckpointRestoreRowId(sessionId, runStartedRowId)` returning that rowid or
`undefined`. The `checkpoint.restored` IPC handler in `register-app-ipc.ts` records/publishes directly,
so relying on `PiSdkRuntime.emitToWindow()` to observe it is insufficient. Use the captured `run.started`
rowid to exclude restores from prior tasks in the same session.
- [ ] **Step 4: Verify the database regressions and formatting.** Rerun the agent-event-store suite; then run Biome on `agent-event-store.ts`, `.test.ts`, and `shared/contracts.ts`, plus `git diff --check`. Expect exact-owner rehydration and malformed-state fail-closed tests to pass.
- [ ] **Step 5: Commit Task 2.** Stage only the event-store/contracts files and commit as `feat(agent): persist verifier-first task state`.

## Task 3: Integrate State with the Existing Run Lifecycle

**Files:**
- Modify `apps/desktop/src/main/agent/pi-sdk-runtime.ts`.
- Modify `apps/desktop/src/main/agent/pi-sdk-runtime.test.ts`.
- Modify `apps/desktop/src/main/git/git-service.ts` and `.test.ts` for authoritative change-scope reads.
- Modify `apps/desktop/src/main/ipc/register-app-ipc.test.ts` to exercise the actual checkpoint restore IPC route.
- Modify `apps/desktop/src/main/agent/harness/task-state.ts` and its test only if runtime integration exposes an uncovered pure transition.

**Consumes:** Task 1's pure API and Task 2's event-store query; existing `RunOutputTracker`, fresh-run boundary, `IntentGate`, `specBuildPlan()`, `requiredChecksForRun()`, QA emission, `PlanSpec`, and terminal `AgentEvent`s.

**Produces:** A live run-owned Task State snapshot persisted through `recordAgentEvent()` and rehydratable by Task 2. It is initialized only for a fresh run after queued/steer input is proven not to start a new run. No renderer presentation or policy dispatch is added in this phase.

**Scope evidence contract:** Keep existing tolerant `getChangeStatsSince()` behavior for UI/change-card callers. Add `getChangeStatsSinceStrict(cwd, base)` for verification; it must use throwing `runGit()` calls for base resolution, tracked diff, tree paths, and untracked paths, returning `undefined` on any failed command. A valid zero-change result is a defined stats object with an empty `files` array. The runtime treats scope as known only when the strict result exists and `truncated === false`; if checks are required and scope is unknown/truncated, `summarizeHarnessQA()` must return `unavailable` and must not preserve any passing or user-confirmed check evidence. Cover valid-empty versus invalid-base/non-repository results in `git-service.test.ts`.

- [ ] **Step 1: Write a RED fresh-run integration test.** Add `getLatestHarnessTaskState`, `listAgentEvents`, and `recordAgentEvent` to the existing dynamic import from `agent-event-store.ts`; then use `createMockPiSession()`, `createWindowStub()`, and database `insertSession()` helpers in `pi-sdk-runtime.test.ts`. Capture the active run ID from the mocked prompt and verify the persisted state refers to the run/message, but contains no prompt text:

```ts
const sessionId = `task-state-${crypto.randomUUID()}`;
const workspaceId = `workspace-${crypto.randomUUID()}`;
insertSession(sessionId, workspaceId, join(userData, "missing-session.jsonl"));
let runId = "";
const session = createMockPiSession({
  prompt: () => {
    const run = getActiveAgentRun(sessionId);
    if (!run) throw new Error("expected active run for Task State integration");
    runId = run.id;
    mocks.emitPiEvent({
      type: "message_update",
      message: { id: "assistant-message", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Completed." },
    });
  },
});
mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
await new PiSdkRuntime().prompt(createWindowStub(), {
  context: [],
  delivery: "normal",
  message: "Fix a typo",
  sessionId,
  userMessageId: "message-1",
});

const state = getLatestHarnessTaskState(sessionId, runId);
expect(state).toMatchObject({
  sessionId,
  runId,
  goalMessageId: "message-1",
  phase: "terminal",
  verificationStatus: "not_required",
});
expect(JSON.stringify(state)).not.toContain("Fix a typo");
const snapshots = listAgentEvents(sessionId).filter(
  ({ event }) => event.type === "harness.task_state" && event.runId === runId,
);
expect(snapshots).toHaveLength(4);
expect(snapshots.map(({ event }) =>
  event.type === "harness.task_state" ? event.state.phase : "invalid",
)).toEqual(["preflight", "executing", "verifying", "terminal"]);
```

- [ ] **Step 2: Run the targeted runtime test and confirm RED.** From `apps/desktop`, run `npx vitest run --root ../.. apps/desktop/src/main/agent/pi-sdk-runtime.test.ts`; expected RED: `getLatestHarnessTaskState()` returns `undefined` because no Task State is emitted.
- [ ] **Step 3: Initialize only at the authoritative fresh-run boundary.** Immediately after the existing streaming/queued-input guards create a run and install its `RunOutputTracker`, derive `TaskClassificationInput` from the same message/mode/context paths used by `evaluateIntentGate()`, call `classifyHarnessTask()`, read the owned `specBuildPlan()`, compute `requiredChecksForRun()`, and read `getLatestSessionTodos(sessionId)`. Type `requiredChecksForRun()` as `HarnessTaskCheckKind[]`; its existing outputs are the four explicit supported literals. Treat the TODO result as untrusted persisted data: deduplicate object entries by source ID in memory, then pass their raw IDs only as input to `createHarnessTaskState()`, which must replace each with an opaque ordinal alias before persistence. Apply the same aliasing to `specBuildPlan()?.todos`; never copy TODO IDs or content into Task State. Validate run/session/workspace/message IDs and skip Task State emission if a required app-generated owner ID is unsafe, without failing the run. Build Task State with the new `run.id` and `userMessageId`; after emitting `run.started`, attach it to that tracker and emit the initial `preflight` snapshot before Intent Gate can request clarification or block. Reuse the already-read PlanRef/check list later in the existing turn instead of reading them again. Do not create a run/state on either existing queued-input return path.
- [ ] **Step 4: Add a queued-input and Intent Gate regression.** In `pi-sdk-runtime.test.ts`, extend the existing deferred queued-input and confirmation-cancel tests. For a live run, capture its run ID and assert one `run.started` event and snapshots for exactly that one run ID after a follow-up joins—no second run or Task State owner is created. For the cancel case, assert a persisted `harness.task_state` for the captured run ends with `phase: "terminal"` and `verificationStatus: "blocked"`, with no verified criteria.
- [ ] **Step 5: Observe progress and persist safe snapshots.** Add `taskState?: HarnessTaskState` and `runStartedRowId?: number` to `RunOutputTracker`. Extend the `emitToWindow()` event closure to capture `const rowId = recordAgentEvent(event)` and, for a `run.started` event matching the active tracker, store it as `runStartedRowId`. In `summarizeHarnessQA()`, query `getLatestCheckpointRestoreRowId(sessionId, runStartedRowId)` and pass the resulting rowid (if any) to `getRunToolEvidence()`; if `runStartedRowId` is absent/invalid, supply no tool evidence (fail closed). This discovers restores recorded directly by the existing IPC handler, including when they bypass `emitToWindow()`. The store query filters both tool-start and tool-end rows, so a check started before restore cannot pass even if it ends afterward; a fresh pair after the boundary can. The intermediate continuation QA call and final `emitHarnessQA()` must use the same run-start/restore boundary. The observer then—only if the event is not already `harness.task_state`—finds the currently owned tracker by `event.sessionId`, checks any explicit `runId`, and transitions supported events. `harness.qa` is the only event that can verify and moves phase to `verifying`; require its exact current `runId` and per-criterion evidence coverage. For session-only `todos.updated` and app-generated `question.*`, update only opaque/safe references. For `plan.updated`, require matching plan/session/workspace, recompute `taskPlanFingerprint(event.plan)`, and reread the PlanStore to confirm the structured fingerprint is still current; plan statuses/evidence never verify. On a changed authoritative fingerprint, rebuild opaque criterion aliases and required check kinds and clear prior plan evidence/statuses. Any later `tool.started` also clears prior verified evidence. After Intent Gate proceeds, transition phase to `executing` and persist before the first model prompt; question resolution does the same after `awaiting_user`. After each material state change, emit exactly one `harness.task_state` snapshot through the same `emitToWindow()` closure. The snapshot is persisted once and ignored by the observer; unchanged projections return the same state object, so there is no recursion, double write, or no-op snapshot. Keep only app-generated IDs, opaque aliases, statuses, reason codes, fingerprints, and bounded revision refs—never prompts, model-authored IDs, criterion/TODO text, paths, command args/output, answers, or error strings.
- **Terminal QA settlement:** Add `lastQaRestoreRowId?: number` to `RunOutputTracker`. Each `emitHarnessQA()` stores the exact restore boundary used for its result. In the successful terminal branch, after the awaited `captureTurnEnd()`, query the latest restore row again. If it differs from `lastQaRestoreRowId`, call `emitHarnessQA()` again so the final status uses post-restore evidence, then synchronously settle the run and emit `run.completed` with no intervening `await`. Apply the same “final QA follows all awaited settlement work” ordering in failure/cancel branches. This closes the interval where a restore may complete after a passing QA event but during turn-end checkpoint capture.
- [ ] **Step 6: Add verification, provenance, restore, and emission regressions.** Assert a fresh Spec Build with every required current-run check passed reaches `verified`; partial PlanSpec check coverage stays `unknown`, any failed required check is `failed`, unavailable/missing evidence is `unknown`, and post-check restore or any later tool action invalidates. In `register-app-ipc.test.ts`, add `restoreCheckpoint`, `recordAgentEvent`, and `fromWebContents` to the existing `vi.hoisted` mocks; make the Electron `BrowserWindow.fromWebContents` mock delegate to `mocks.fromWebContents`; add mock factories for `checkpoint-service` and `agent-event-store` (including `getWorkspaceHarnessInsightEvidence`); reset those mocks in the suite `beforeEach`; then test the real registered handler:

```ts
it("records and publishes the checkpoint restore event through the IPC handler", async () => {
  const checkpoint = {
    id: "checkpoint-1",
    sessionId: "session-1",
    cwd: "C:/workspace",
    commitHash: "abc123",
    kind: "auto" as const,
    createdAt: "2026-09-27T00:00:00.000Z",
  };
  const send = vi.fn();
  mocks.restoreCheckpoint.mockResolvedValue(checkpoint);
  mocks.fromWebContents.mockReturnValue({ webContents: { send } });
  const handler = mocks.handlers.get(IPC_CHANNELS.checkpointRestore);
  if (!handler) throw new Error("Checkpoint restore IPC handler was not registered.");

  await handler(trustedEvent as never, { checkpointId: checkpoint.id } as never);
  const restoredEvent = {
    type: "checkpoint.restored",
    sessionId: checkpoint.sessionId,
    checkpointId: checkpoint.id,
  };
  expect(mocks.recordAgentEvent).toHaveBeenCalledWith(restoredEvent);
  expect(send).toHaveBeenCalledWith(IPC_CHANNELS.agentEvent, restoredEvent);
});
```

In the live runtime test, record a successful test start/end pair, then persist the same restore-event
payload after the captured `run.started` row without rerunning tests; assert the runtime discovers it
through `getLatestCheckpointRestoreRowId()`, emits end-of-turn `harness.qa: missing`, and settles Task
State as `unknown`. Add the complementary post-restore rerun case, which may become `verified`. Assert
failure is `failed`, cancellation is `unknown`, Intent Gate cancellation is `blocked`, and simple
no-check work stays `not_required`. Send a delayed `harness.qa` for a prior run and a `plan.updated` event
whose Markdown hash is unchanged but structured Spec/TODO fingerprint is stale; neither may change
current-run verification. `user_confirmed` stays distinct; `run.completed` alone never creates evidence.
In the simple-task test, count persisted Task State events with `listAgentEvents(sessionId)`: exactly one
initial, one executing-phase, one `verifying`-phase, and one terminal-phase snapshot are expected;
re-observing each `harness.task_state` must not add another row.

In `git-service.test.ts`, import `getChangeStatsSinceStrict` and prove a successful no-change diff
returns defined empty stats while a missing repository and an invalid base return `undefined`:

```ts
it("distinguishes a known-empty change scope from failed Git reads", async () => {
  const base = (await git(["rev-parse", "HEAD"])).trim();
  await expect(getChangeStatsSinceStrict(repo, base)).resolves.toMatchObject({
    files: [],
    fileCount: 0,
    truncated: false,
  });
  await expect(getChangeStatsSinceStrict(join(repo, "missing-repo"), base)).resolves.toBeUndefined();
  await expect(getChangeStatsSinceStrict(repo, "missing-base")).resolves.toBeUndefined();
});
```

In `pi-sdk-runtime.test.ts`, keep the scoped check tool pair successful but make the strict scope read
return `undefined`; assert persisted QA is `unavailable` and the Task State never becomes `verified`.

Add the terminal-settlement race separately: defer the mocked turn-end `createCheckpoint()` promise;
wait until the runtime emits `harness.qa: passed`; while the promise is pending, run the checkpoint
restore IPC handler (or persist its exact `checkpoint.restored` event), then resolve the checkpoint
promise. Assert the event order is `harness.qa(passed) → checkpoint.restored → harness.qa(missing) →
run.completed`, and the final Task State is `unknown`. The implementation must perform this recheck
after the awaited turn-end capture; a test that restores only before the first QA summary does not cover
this race.
- [ ] **Step 7: Run GREEN on the Task State, Git-scope, runtime, event-store, and IPC suites.** From `apps/desktop`, run `npx vitest run --root ../.. apps/desktop/src/main/agent/harness/task-state.test.ts apps/desktop/src/main/agent/agent-event-store.test.ts apps/desktop/src/main/agent/pi-sdk-runtime.test.ts apps/desktop/src/main/agent/git-service.test.ts apps/desktop/src/main/ipc/register-app-ipc.test.ts`. Expected: Task State transitions pass and all existing run ownership/continuation/permission, Git summary, and trusted-sender tests remain unchanged.
- [ ] **Step 8: Run integration checks and commit Task 3.** Run `npm run typecheck` and `npm run build` from `apps/desktop`; run Biome on all touched Phase 1 files, including `git-service.ts` and `.test.ts`, and `git diff --check` from the worktree root. Commit as `feat(agent): bind task state to verifier evidence`.

## Phase 1 Self-Review

- **Spec coverage:** Task State references goal, constraints, hypotheses, criteria, TODOs, and evidence without a second TODO store. Verifier status requires fresh current-run evidence; post-QA action/checkpoint restore invalidates evidence; simple tasks remain `not_required`; blocked/failed/unknown/user-confirmed states stay distinct. Persistence is bounded and rehydratable from existing local event storage.
- **Privacy:** new snapshots store references/statuses only. The reducer ignores raw message/tool bodies and never copies prompt, output, command, error, file path, or TODO/criterion prose.
- **Authority:** Intent Gate, PlanSpec/PlanStore, TODO store, Auto QA, permission broker, and Pi run lifecycle remain authoritative. No Meta Controller, automatic preflight, external MCP, new UI, or learning promotion enters Phase 1.
- **Scope:** Failure Intelligence signatures and Project Model construction are reserved for Phase 2; Meta Controller and Context Engine remain later dependent specs. This plan does not close Gate 2 or relax the one-continuation limit.
- **Placeholder scan:** no TBD/FIXME or underspecified test commands; function signatures, event name, persisted projection, state transitions, owner checks, and acceptance tests are defined above.

## Phase 1 Completion Gate

Before any Phase 2 work begins, complete a separate read-only architecture/security review against the
approved design, require all Task 1–3 acceptance tests to pass with zero false-verified regressions, and
have the user review the resulting implementation and gate evidence. This plan does not authorize
Phase 2 implementation or close the separately open Gate 2.
