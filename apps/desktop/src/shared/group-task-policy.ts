import type { GroupTask, HarnessTaskCheckKind } from "./contracts";
import type {
  GroupTaskDraft,
  GroupTaskGateInput,
  GroupTaskGateResult,
  GroupTaskReview,
  GroupTaskValidationResult,
} from "./group-work-state";

// Keep these in step with the individual harness Task State bounds.
const MAX_CRITERIA = 128;
const MAX_REFS = 256;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHECK_KINDS: readonly HarnessTaskCheckKind[] = ["tests", "typecheck", "lint", "build"];

function currentReview(input: GroupTaskGateInput): GroupTaskReview | undefined {
  const review = input.review ?? input.task.review;
  if (
    review?.verdict !== "approve" ||
    review.reviewerSessionId !== input.task.reviewerSessionId ||
    review.criteriaVersion !== input.task.criteriaVersion ||
    !input.sourceFingerprint ||
    review.sourceFingerprint !== input.sourceFingerprint ||
    !review.eventId
  )
    return undefined;
  return review;
}

/** Validate a proposed task against the group's task graph without reading the store. */
export function validateGroupTaskDraft(
  draft: GroupTaskDraft,
  tasks: readonly GroupTask[],
): GroupTaskValidationResult {
  const issues: GroupTaskValidationResult["issues"] = [];
  const add = (code: string, field: string, message: string): void => {
    issues.push({ code, field, message });
  };

  if (typeof draft.title !== "string" || !draft.title.trim()) {
    add("invalid-value", "title", "Task title must not be empty.");
  }
  if (draft.description !== undefined && typeof draft.description !== "string") {
    add("invalid-value", "description", "Task description must be text.");
  }
  if (!Array.isArray(draft.criteria) || draft.criteria.length > MAX_CRITERIA) {
    add("invalid-value", "criteria", `A task may have at most ${MAX_CRITERIA} criteria.`);
  } else {
    const seen = new Set<string>();
    for (const [index, criterion] of draft.criteria.entries()) {
      if (!SAFE_ID.test(criterion.id) || seen.has(criterion.id)) {
        add("invalid-value", `criteria.${index}.id`, "Criterion ID must be safe and unique.");
      }
      seen.add(criterion.id);
      if (typeof criterion.description !== "string" || !criterion.description.trim()) {
        add(
          "invalid-value",
          `criteria.${index}.description`,
          "Criterion description must not be empty.",
        );
      }
      if (
        !Array.isArray(criterion.requiredCheckKinds) ||
        criterion.requiredCheckKinds.some((kind) => !CHECK_KINDS.includes(kind))
      ) {
        add(
          "invalid-value",
          `criteria.${index}.requiredCheckKinds`,
          "Criterion checks must use known kinds.",
        );
      } else if (
        criterion.requiredCheckKinds.length === 0 &&
        draft.verificationPolicy?.mode === "required" &&
        !draft.verificationPolicy.requireReview
      ) {
        add(
          "verification-required",
          `criteria.${index}.requiredCheckKinds`,
          "A criterion without QA checks requires reviewer approval.",
        );
      }
    }
  }

  if (draft.verificationPolicy?.mode === "required" && draft.criteria?.length === 0) {
    add("verification-required", "criteria", "Required verification needs at least one criterion.");
  }

  if (!Array.isArray(draft.dependencyIds) || draft.dependencyIds.length > MAX_REFS) {
    add("invalid-dependency", "dependencyIds", `A task may have at most ${MAX_REFS} dependencies.`);
    return { issues };
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seenDependencies = new Set<string>();
  for (const [index, id] of draft.dependencyIds.entries()) {
    const dependency = byId.get(id);
    if (
      !SAFE_ID.test(id) ||
      seenDependencies.has(id) ||
      !dependency ||
      dependency.groupId !== draft.groupId
    ) {
      add(
        "invalid-dependency",
        `dependencyIds.${index}`,
        "Dependency must identify a distinct task in this group.",
      );
    }
    seenDependencies.add(id);
  }

  // A new draft has no task ID yet, but it must not connect to a cyclic existing subgraph.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    const node = byId.get(id);
    if (!node || node.groupId !== draft.groupId) return false;
    visiting.add(id);
    for (const next of node.dependencyIds ?? []) {
      if (hasCycle(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (draft.dependencyIds.some(hasCycle)) {
    add("dependency-cycle", "dependencyIds", "Dependencies contain a cycle.");
  }
  return { issues };
}

/** Decide if the current resolved evidence, review and dependency snapshot permit completion. */
export function evaluateGroupTaskGate(input: GroupTaskGateInput): GroupTaskGateResult {
  const reasons = new Set<string>();
  const dependencyIds = input.task.dependencyIds ?? [];
  const dependencies = new Map(input.dependencies.map((dependency) => [dependency.id, dependency]));
  for (const id of dependencyIds) {
    if (dependencies.get(id)?.status !== "done") reasons.add("dependency-incomplete");
  }

  // Legacy rows had no verification policy. Their agreement path must remain available.
  if ((input.task.verificationPolicy?.mode ?? "none") === "none") {
    return { satisfied: reasons.size === 0, reasonCodes: [...reasons] };
  }

  const criteria = input.task.criteria ?? [];
  if (criteria.length === 0) reasons.add("verification-required");
  const review = currentReview(input);
  if (input.task.verificationPolicy?.requireReview && !review) reasons.add("review-required");

  for (const criterion of criteria) {
    const currentOutcomes = input.criterionOutcomes.filter(
      (outcome) =>
        outcome.criterionId === criterion.id &&
        outcome.criteriaVersion === input.task.criteriaVersion &&
        Boolean(input.sourceFingerprint) &&
        outcome.sourceFingerprint === input.sourceFingerprint,
    );
    if (criterion.requiredCheckKinds.length > 0) {
      if (!currentOutcomes.some((outcome) => outcome.status === "passed")) {
        reasons.add("criterion-unverified");
      }
    } else if (
      !input.task.verificationPolicy?.requireReview ||
      !review?.approvedCriterionIds.includes(criterion.id) ||
      !currentOutcomes.some((outcome) => outcome.status === "review_approved")
    ) {
      reasons.add("criterion-unverified");
    }
  }
  return { satisfied: reasons.size === 0, reasonCodes: [...reasons] };
}
