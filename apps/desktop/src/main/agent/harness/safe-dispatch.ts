import type {
  AdaptiveDecision,
  AdaptiveDecisionAction,
  BuiltinAgentRole,
} from "../../../shared/contracts";

/**
 * Safe auto-dispatch allowlist (slice 2 + Gap 1).
 *
 * Allowed without elevating permissions:
 * - retrieve_local — bounded Context Planner / CodeGraph hits already indexed
 * - verify — strengthen verifier gate / continue QA (existing Auto QA path)
 * - suggest_plan — advisory Plan/HyperPlan suggestion (already Intent-Gate safe)
 * - finish — terminal when verification already satisfied
 * - spawn_readonly_specialist — spawn a builtin read-only child via runSubagent
 *   (explore/librarian/oracle/reviewer/debugger/ui-ux only; ToolRegistry +
 *   permission profiles unchanged; deferred until Intent Gate proceeds)
 * - mcp_preflight — spawn librarian so allowlisted MCP tools are invoked only
 *   through ToolRegistry + permission broker (mcp:read-only-allowlist)
 *
 * Never auto-dispatched (advisory hints only, or blocked):
 * - suggest_oracle / replan / ask_user / avoid_retry / execute
 * - non-readonly children, worktree isolation, dangerous MCP, file writes,
 *   destructive shell
 */
export const SAFE_AUTO_DISPATCH_ACTIONS = [
  "retrieve_local",
  "verify",
  "suggest_plan",
  "finish",
  "spawn_readonly_specialist",
  "mcp_preflight",
] as const satisfies readonly AdaptiveDecisionAction[];

/** Builtin roles that may be auto-spawned (all are read-only specialists). */
export const SAFE_READONLY_SPECIALIST_ROLES = [
  "explore",
  "librarian",
  "oracle",
  "reviewer",
  "debugger",
  "ui-ux",
] as const satisfies readonly BuiltinAgentRole[];

export type SafeAutoDispatchAction = (typeof SAFE_AUTO_DISPATCH_ACTIONS)[number];
export type SafeReadonlySpecialistRole = (typeof SAFE_READONLY_SPECIALIST_ROLES)[number];

export type SafeDispatchPlan =
  | { kind: "none"; reasonCode: string }
  | { kind: "hint_only"; reasonCode: string }
  | { kind: "retrieve_local"; reasonCode: string }
  | { kind: "verify_gate"; reasonCode: string }
  | { kind: "suggest_plan"; reasonCode: string }
  | { kind: "finish"; reasonCode: string }
  | {
      kind: "spawn_readonly_specialist";
      reasonCode: string;
      specialistRole: SafeReadonlySpecialistRole;
    }
  | {
      kind: "mcp_preflight";
      reasonCode: string;
      specialistRole: "librarian";
    };

const SAFE_SET = new Set<string>(SAFE_AUTO_DISPATCH_ACTIONS);
const SAFE_ROLE_SET = new Set<string>(SAFE_READONLY_SPECIALIST_ROLES);

export function isSafeAutoDispatchAction(action: AdaptiveDecisionAction): boolean {
  return SAFE_SET.has(action);
}

export function isSafeReadonlySpecialistRole(
  role: string | undefined,
): role is SafeReadonlySpecialistRole {
  return typeof role === "string" && SAFE_ROLE_SET.has(role);
}

export function resolveSafeSpecialistRole(
  role: BuiltinAgentRole | undefined,
  fallback: SafeReadonlySpecialistRole = "oracle",
): SafeReadonlySpecialistRole {
  return isSafeReadonlySpecialistRole(role) ? role : fallback;
}

/**
 * Map a Meta Controller decision to a safe runtime plan.
 * Active mode may execute allowlisted kinds; advisory/shadow stay hint-only
 * except soft local retrieve/verify/suggest_plan.
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
    // Child/MCP spawn stays active-only.
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
    case "spawn_readonly_specialist": {
      const specialistRole = resolveSafeSpecialistRole(decision.specialistRole, "oracle");
      return {
        kind: "spawn_readonly_specialist",
        reasonCode: "active_spawn_readonly_specialist",
        specialistRole,
      };
    }
    case "mcp_preflight":
      return {
        kind: "mcp_preflight",
        reasonCode: "active_mcp_preflight_librarian",
        specialistRole: "librarian",
      };
    default:
      return { kind: "hint_only", reasonCode: "active_fallback_hint" };
  }
}

export function describeSafeDispatchAllowlist(): string {
  return SAFE_AUTO_DISPATCH_ACTIONS.join(", ");
}

export function describeSafeReadonlySpecialistRoles(): string {
  return SAFE_READONLY_SPECIALIST_ROLES.join(", ");
}
