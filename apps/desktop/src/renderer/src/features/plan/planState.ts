import type { PlanBuildStatus, PlanRef } from "../../../../shared/contracts";

export { buildPlanMessage } from "../../../../shared/plan-message";

/**
 * Fill fields that older plan events are missing, so the rest of the UI can rely on the PlanRef
 * contract. Mirrors the store's defaults; returns the same reference when the
 * plan is already complete (the common, new-plan case) so memo identity holds.
 */
export function normalizePlan(plan: PlanRef): PlanRef {
  if (
    plan.blocks !== undefined &&
    plan.todos !== undefined &&
    plan.buildStatus !== undefined &&
    plan.overview !== undefined
  ) {
    return plan;
  }
  return {
    ...plan,
    blocks: plan.blocks ?? [{ type: "markdown", content: plan.content }],
    overview: plan.overview ?? "",
    todos: plan.todos ?? [],
    buildStatus: plan.buildStatus ?? "not_built",
  };
}

/**
 * The build status to act on, reconciling the plan's PERSISTED status against
 * the session's LIVE working state. A persisted `building` only makes sense
 * while the build turn is actually running; if the session is idle (the turn
 * was interrupted by a crash/disconnect that never emitted a terminal event),
 * `building` is stale and resolves to `not_built` so the plan can be built
 * again. Both inputs are authoritative facts, so this is reconciliation, not a
 * guess.
 */
export function effectiveBuildStatus(plan: PlanRef, sessionWorking: boolean): PlanBuildStatus {
  if (plan.buildStatus === "building" && !sessionWorking) {
    return "not_built";
  }
  return plan.buildStatus;
}
