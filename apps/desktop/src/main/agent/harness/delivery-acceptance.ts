import type {
  HarnessQAResult,
  HarnessTaskCriterionState,
  TodoItem,
} from "../../../shared/contracts";

export type DeliveryAcceptanceInput = {
  qa: HarnessQAResult;
  todos: readonly Pick<TodoItem, "status">[];
  criteria: readonly Pick<HarnessTaskCriterionState, "status">[];
  verificationRequired?: boolean;
};

export type DeliveryAcceptanceAssessment = {
  status: "accepted" | "incomplete" | "blocked" | "verification_failed" | "unverified";
  reasonCodes: string[];
};

/** Assess formal tracked work only; acceptance does not establish freeform semantic completion. */
export function assessDeliveryAcceptance(
  input: DeliveryAcceptanceInput,
): DeliveryAcceptanceAssessment {
  const reasons: Array<{ status: DeliveryAcceptanceAssessment["status"]; code: string }> = [];
  const qaStatuses = [input.qa.status, ...input.qa.evidence.map((item) => item.status)];
  if (qaStatuses.some((status) => status === "failed" || status === "timed_out")) {
    reasons.push({ status: "verification_failed", code: "qa_failed" });
  } else if (
    qaStatuses.some((status) => status !== "passed" && status !== "not_required") ||
    (input.qa.required && input.qa.status === "not_required")
  ) {
    reasons.push({ status: "unverified", code: "qa_unverified" });
  }
  if (
    input.verificationRequired &&
    !input.qa.evidence.some(
      (item) => item.kind === "check" && item.status === "passed" && Boolean(item.eventId),
    )
  ) {
    reasons.push({ status: "unverified", code: "verification_gate_unverified" });
  }
  if (input.todos.some((todo) => todo.status === "blocked")) {
    reasons.push({ status: "blocked", code: "todo_blocked" });
  }
  if (input.todos.some((todo) => ["pending", "in_progress", "cancelled"].includes(todo.status))) {
    reasons.push({ status: "incomplete", code: "todo_incomplete" });
  }
  if (input.criteria.some((criterion) => criterion.status === "failed")) {
    reasons.push({ status: "verification_failed", code: "criterion_failed" });
  }
  if (input.criteria.some((criterion) => criterion.status === "blocked")) {
    reasons.push({ status: "blocked", code: "criterion_blocked" });
  }
  if (input.criteria.some((criterion) => criterion.status === "pending")) {
    reasons.push({ status: "incomplete", code: "criterion_incomplete" });
  }
  if (input.criteria.some((criterion) => criterion.status === "unknown")) {
    reasons.push({ status: "unverified", code: "criterion_unverified" });
  }
  if (input.todos.length === 0 && input.criteria.length === 0) {
    reasons.push({ status: "unverified", code: "no_tracked_requirements" });
  }
  const status = (["verification_failed", "blocked", "incomplete", "unverified"] as const).find(
    (candidate) => reasons.some((reason) => reason.status === candidate),
  );
  return status
    ? { status, reasonCodes: reasons.map((reason) => reason.code) }
    : { status: "accepted", reasonCodes: ["tracked_requirements_satisfied"] };
}
