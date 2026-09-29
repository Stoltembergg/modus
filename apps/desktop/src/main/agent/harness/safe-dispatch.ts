import type { AdaptiveDecision, AdaptiveDecisionAction } from "../../../shared/contracts";

/**
 * Safe auto-dispatch allowlist (slice 2).
 *
 * Allowed without elevating permissions:
 * - retrieve_local — bounded Context Planner / CodeGraph hits already indexed
 * - verify — strengthen verifier gate / continue QA (existing Auto QA path)
 * - suggest_plan — advisory Plan/HyperPlan suggestion (already Intent-Gate safe)
 * - finish — terminal when verification already satisfied
 *
 * Never auto-dispatched (advisory hints only, or blocked):
 * - suggest_oracle / replan / ask_user / avoid_retry / execute
 * - any child subagent spawn, MCP external call, file write, destructive shell
 */
export const SAFE_AUTO_DISPATCH_ACTIONS = [
  "retrieve_local",
  "verify",
  "suggest_plan",
  "finish",
] as const satisfies readonly AdaptiveDecisionAction[];

export type SafeAutoDispatchAction = (typeof SAFE_AUTO_DISPATCH_ACTIONS)[number];

export type SafeDispatchPlan =
  | { kind: "none"; reasonCode: string }
  | { kind: "hint_only"; reasonCode: string }
  | { kind: "retrieve_local"; reasonCode: string }
  | { kind: "verify_gate"; reasonCode: string }
  | { kind: "suggest_plan"; reasonCode: string }
  | { kind: "finish"; reasonCode: string };

const SAFE_SET = new Set<string>(SAFE_AUTO_DISPATCH_ACTIONS);

export function isSafeAutoDispatchAction(action: AdaptiveDecisionAction): boolean {
  return SAFE_SET.has(action);
}

/**
 * Map a Meta Controller decision to a safe runtime plan.
 * Active mode may execute allowlisted kinds; advisory/shadow stay hint-only.
 */
export function planSafeDispatch(decision: AdaptiveDecision): SafeDispatchPlan {
  if (decision.mode === "shadow") {
    return { kind: "none", reasonCode: "shadow_mode" };
  }
  if (!isSafeAutoDispatchAction(decision.action)) {
    return { kind: "hint_only", reasonCode: "action_not_allowlisted" };
  }
  if (decision.mode === "advisory") {
    // Advisory may still schedule allowlisted soft effects that only inject
    // turn context / verification policy — never tools or children.
    if (decision.action === "retrieve_local") {
      return { kind: "retrieve_local", reasonCode: "advisory_local_retrieve" };
    }
    if (decision.action === "verify") {
      return { kind: "verify_gate", reasonCode: "advisory_verify_gate" };
    }
    if (decision.action === "suggest_plan") {
      return { kind: "suggest_plan", reasonCode: "advisory_suggest_plan" };
    }
    return { kind: "hint_only", reasonCode: "advisory_hint_only" };
  }
  // active
  switch (decision.action) {
    case "retrieve_local":
      return { kind: "retrieve_local", reasonCode: "active_local_retrieve" };
    case "verify":
      return { kind: "verify_gate", reasonCode: "active_verify_gate" };
    case "suggest_plan":
      return { kind: "suggest_plan", reasonCode: "active_suggest_plan" };
    case "finish":
      return { kind: "finish", reasonCode: "active_finish" };
    default:
      return { kind: "hint_only", reasonCode: "active_fallback_hint" };
  }
}

export function describeSafeDispatchAllowlist(): string {
  return SAFE_AUTO_DISPATCH_ACTIONS.join(", ");
}
