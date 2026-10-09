import { createHash } from "node:crypto";
import type {
  AgentEvent,
  HarnessEvidenceRef,
  HarnessTaskCheckKind,
  HarnessTaskCriterionState,
  HarnessTaskEvidenceRef,
  HarnessTaskState,
  HarnessTaskStateSeed,
  HarnessTaskVerificationStatus,
  PlanRef,
} from "../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";

export const SAFE_TASK_STATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MAX_TASK_STATE_CRITERIA = 128;
export const MAX_TASK_STATE_REFS = 256;
export const MAX_TASK_STATE_EVIDENCE = 256;
export const MAX_TASK_STATE_EVIDENCE_PER_CRITERION = 16;
export const MAX_TASK_STATE_SCAN = 256;
export const MAX_TASK_STATE_EVENT_BYTES = 262144;

const CHECK_KINDS: readonly HarnessTaskCheckKind[] = ["tests", "typecheck", "lint", "build"];
const CHECK_LABELS: Record<HarnessTaskCheckKind, string> = {
  tests: "Tests",
  typecheck: "Typecheck",
  lint: "Lint",
  build: "Build",
};

function taskPlanFingerprint(plan: Pick<PlanRef, "id" | "hash" | "spec" | "todos">): string {
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

function planCriteria(plan?: HarnessTaskStateSeed["plan"]): HarnessTaskCriterionState[] {
  return (plan?.spec?.acceptanceCriteria ?? [])
    .slice(0, MAX_TASK_STATE_CRITERIA)
    .map((criterion, index) => ({
      criterionId: `opaque:plan-criterion:${index}`,
      source: "plan",
      status: "pending",
      evidenceEventIds: [],
      ...(criterion.requiredCheckKinds?.length
        ? {
            requiredCheckKinds: [...new Set(criterion.requiredCheckKinds)].filter((kind) =>
              CHECK_KINDS.includes(kind),
            ),
          }
        : {}),
    }));
}

function checkCriteria(checks: HarnessTaskCheckKind[]): HarnessTaskCriterionState[] {
  return [...new Set(checks)]
    .filter((kind) => CHECK_KINDS.includes(kind))
    .slice(0, MAX_TASK_STATE_CRITERIA)
    .map((kind) => ({
      criterionId: `check:${kind}`,
      source: "check",
      status: "pending",
      evidenceEventIds: [],
      requiredCheckKinds: [kind],
    }));
}

function references(ids: string[], prefix: string): string[] {
  return ids.slice(0, MAX_TASK_STATE_REFS).map((_, index) => `opaque:${prefix}:${index}`);
}

export function createHarnessTaskState(
  input: HarnessTaskStateSeed,
  now = new Date().toISOString(),
): HarnessTaskState {
  if (
    ![input.sessionId, input.runId, input.workspaceId, input.goalMessageId].every((id) =>
      SAFE_TASK_STATE_ID.test(id),
    )
  ) {
    throw new Error("Unsafe Task State owner identifier");
  }
  if (input.workspaceId === CHATS_WORKSPACE_ID) {
    throw new Error("Task State is not supported for the Chats workspace");
  }
  if (
    input.plan &&
    (input.plan.sessionId !== input.sessionId || input.plan.workspaceId !== input.workspaceId)
  ) {
    throw new Error("Plan does not belong to Task State owner");
  }
  const criteria = [...planCriteria(input.plan), ...checkCriteria(input.requiredChecks)].slice(
    0,
    MAX_TASK_STATE_CRITERIA,
  );
  const noCriteria = criteria.length === 0;
  const important =
    input.classification.complexity !== "simple" || input.classification.risk !== "low";
  return {
    version: 1,
    sessionId: input.sessionId,
    runId: input.runId,
    workspaceId: input.workspaceId,
    goalMessageId: input.goalMessageId,
    ...(input.plan
      ? {
          planId: input.plan.id,
          planFingerprint: taskPlanFingerprint(
            input.plan as Pick<PlanRef, "id" | "hash" | "spec" | "todos">,
          ),
        }
      : {}),
    classification: input.classification,
    phase: "preflight",
    verificationStatus: noCriteria ? (important ? "unknown" : "not_required") : "pending",
    criteria,
    constraintRefs: [],
    openQuestionRefs: [],
    todoIds: [
      ...references(input.todoIds, "todo"),
      ...(input.plan?.todos
        .slice(0, MAX_TASK_STATE_REFS)
        .map((_, index) => `opaque:plan-todo:${index}`) ?? []),
    ].slice(0, MAX_TASK_STATE_REFS),
    hypothesisRefs: [],
    evidenceRefs: [],
    ...(input.revision && SAFE_TASK_STATE_ID.test(input.revision)
      ? { revision: input.revision }
      : {}),
    updatedAt: now,
  };
}

function update(
  state: HarnessTaskState,
  now: string,
  values: Partial<HarnessTaskState>,
  clearRevision = false,
): HarnessTaskState {
  const next = { ...state, ...values, updatedAt: now };
  if (clearRevision) delete next.revision;
  return next;
}

function settleEvidence(criteria: HarnessTaskCriterionState[]): HarnessTaskVerificationStatus {
  if (criteria.some(({ status }) => status === "failed")) return "failed";
  if (criteria.some(({ status }) => status === "blocked")) return "blocked";
  if (criteria.every(({ status }) => status === "verified")) return "verified";
  if (criteria.every(({ status }) => status === "user_confirmed")) return "user_confirmed";
  return "unknown";
}

function settleCompletedRun(state: HarnessTaskState): HarnessTaskVerificationStatus {
  if (!state.criteria.length) {
    return state.classification.complexity === "simple" && state.classification.risk === "low"
      ? "not_required"
      : "unknown";
  }
  return settleEvidence(state.criteria);
}

function evidenceForCheck(
  evidence: HarnessEvidenceRef[],
  kind: HarnessTaskCheckKind,
  runId: string,
) {
  return evidence.filter(
    (item) =>
      item.kind === "check" &&
      item.runId === runId &&
      item.label === CHECK_LABELS[kind] &&
      typeof item.eventId === "string" &&
      SAFE_TASK_STATE_ID.test(item.eventId),
  );
}

function reduceHarnessTaskEvent(
  state: HarnessTaskState,
  event: AgentEvent,
  now: string,
): HarnessTaskState {
  switch (event.type) {
    case "run.completed": {
      const verificationStatus = settleCompletedRun(state);
      return update(state, now, { phase: "terminal", verificationStatus });
    }
    case "run.failed":
      return update(state, now, { phase: "terminal", verificationStatus: "failed" });
    case "run.blocked":
      return update(state, now, { phase: "terminal", verificationStatus: "blocked" });
    case "run.cancelled":
      return update(state, now, { phase: "terminal", verificationStatus: "unknown" });
    case "tool.started":
    case "checkpoint.restored": {
      if (!state.criteria.length) return update(state, now, {});
      const criteria = state.criteria.map((criterion) => ({
        ...criterion,
        status: "unknown" as const,
        evidenceEventIds: [],
      }));
      return update(
        state,
        now,
        { criteria, evidenceRefs: [], verificationStatus: "unknown" },
        true,
      );
    }
    case "todos.updated":
      return update(state, now, {
        todoIds: references(
          event.todos.map(({ id }) => id),
          "todo",
        ),
      });
    case "question.requested": {
      if (
        (event.request.sessionId && event.request.sessionId !== state.sessionId) ||
        (event.request.runId && event.request.runId !== state.runId)
      )
        return state;
      const openQuestionRefs = SAFE_TASK_STATE_ID.test(event.request.id)
        ? [...new Set([...state.openQuestionRefs, event.request.id])].slice(-MAX_TASK_STATE_REFS)
        : state.openQuestionRefs;
      return update(state, now, { openQuestionRefs, phase: "awaiting_user" });
    }
    case "question.resolved":
      return update(state, now, {
        openQuestionRefs: state.openQuestionRefs.filter((id) => id !== event.requestId),
      });
    case "plan.updated": {
      const plan = event.plan;
      if (
        plan.sessionId !== state.sessionId ||
        plan.workspaceId !== state.workspaceId ||
        (state.planId !== undefined && plan.id !== state.planId) ||
        !SAFE_TASK_STATE_ID.test(plan.id)
      )
        return state;
      const fingerprint = taskPlanFingerprint(plan);
      if (fingerprint === state.planFingerprint) return state;
      const criteria = [
        ...planCriteria(plan),
        ...state.criteria.filter(({ source }) => source === "check"),
      ].slice(0, MAX_TASK_STATE_CRITERIA);
      return update(
        state,
        now,
        {
          planId: plan.id,
          planFingerprint: fingerprint,
          criteria,
          todoIds: [
            ...state.todoIds.filter((id) => id.startsWith("opaque:todo:")),
            ...plan.todos
              .slice(0, MAX_TASK_STATE_REFS)
              .map((_, index) => `opaque:plan-todo:${index}`),
          ].slice(0, MAX_TASK_STATE_REFS),
          evidenceRefs: [],
          verificationStatus: criteria.length
            ? "pending"
            : state.classification.complexity === "simple" && state.classification.risk === "low"
              ? "not_required"
              : "unknown",
        },
        true,
      );
    }
    case "harness.qa": {
      const evidence = event.result.evidence;
      const allRefs: HarnessTaskEvidenceRef[] = [];
      const criteria: HarnessTaskCriterionState[] = state.criteria.map((criterion) => {
        const kinds = criterion.requiredCheckKinds ?? [];
        if (!kinds.length)
          return { ...criterion, status: "unknown" as const, evidenceEventIds: [] };
        const matchedByKind = kinds.map((kind) => evidenceForCheck(evidence, kind, state.runId));
        const failed = matchedByKind.some((items) =>
          items.some(({ status }) => status === "failed"),
        );
        const selected = matchedByKind.map((items) =>
          items.find(({ status }) => status === "passed"),
        );
        const distinctEvents =
          event.result.status !== "cancelled" &&
          selected.every(Boolean) &&
          new Set(selected.map((item) => item?.eventId)).size === kinds.length;
        const ids = distinctEvents ? selected.map((item) => item!.eventId!) : [];
        for (const item of evidence) {
          if (item.kind !== "check" && item.kind !== "user_confirmation") continue;
          if (!item.eventId || !SAFE_TASK_STATE_ID.test(item.eventId) || item.runId !== state.runId)
            continue;
          const ref: HarnessTaskEvidenceRef = {
            eventId: item.eventId,
            kind: item.kind,
            status: item.status,
            ...(item.revision && SAFE_TASK_STATE_ID.test(item.revision)
              ? { revision: item.revision }
              : {}),
          };
          if (!allRefs.some(({ eventId }) => eventId === ref.eventId)) allRefs.push(ref);
        }
        return {
          ...criterion,
          status: failed
            ? ("failed" as const)
            : distinctEvents
              ? ("verified" as const)
              : ("unknown" as const),
          evidenceEventIds: ids.slice(0, MAX_TASK_STATE_EVIDENCE_PER_CRITERION),
        };
      });
      const confirmations = evidence.filter(
        (item) =>
          item.kind === "user_confirmation" &&
          item.status === "user_confirmed" &&
          item.runId === state.runId &&
          !!item.eventId &&
          SAFE_TASK_STATE_ID.test(item.eventId),
      );
      if (
        confirmations.length &&
        !criteria.some(({ status }) => status === "verified" || status === "failed")
      ) {
        for (const criterion of criteria) {
          criterion.status = "user_confirmed";
          criterion.evidenceEventIds = confirmations
            .slice(0, MAX_TASK_STATE_EVIDENCE_PER_CRITERION)
            .map((item) => item.eventId!);
        }
        for (const item of confirmations) {
          if (!allRefs.some(({ eventId }) => eventId === item.eventId)) {
            allRefs.push({
              eventId: item.eventId!,
              kind: "user_confirmation",
              status: "user_confirmed",
            });
          }
        }
      }
      const revision = evidence.find(
        (item) =>
          item.runId === state.runId && item.revision && SAFE_TASK_STATE_ID.test(item.revision),
      )?.revision;
      const verificationStatus = criteria.length
        ? settleEvidence(criteria)
        : state.verificationStatus === "not_required"
          ? "not_required"
          : "unknown";
      return update(
        state,
        now,
        {
          phase: "verifying",
          criteria,
          evidenceRefs: allRefs.slice(0, MAX_TASK_STATE_EVIDENCE),
          verificationStatus,
          ...(revision ? { revision } : {}),
        },
        revision === undefined,
      );
    }
    default:
      return state;
  }
}

export function transitionHarnessTaskState(
  state: HarnessTaskState,
  event: AgentEvent,
  now = new Date().toISOString(),
): HarnessTaskState {
  if (event.sessionId !== state.sessionId) return state;
  if ("runId" in event && typeof event.runId === "string" && event.runId !== state.runId)
    return state;
  return reduceHarnessTaskEvent(state, event, now);
}
