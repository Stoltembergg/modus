import { describe, expect, it } from "vitest";
import type { AdaptiveDecision } from "../../../shared/contracts";
import {
  describeSafeDispatchAllowlist,
  describeSafeReadonlySpecialistRoles,
  isSafeAutoDispatchAction,
  isSafeReadonlySpecialistRole,
  planSafeDispatch,
  resolveSafeSpecialistRole,
} from "./safe-dispatch";

function decision(
  action: AdaptiveDecision["action"],
  mode: AdaptiveDecision["mode"],
  specialistRole?: AdaptiveDecision["specialistRole"],
): AdaptiveDecision {
  return {
    version: 1,
    action,
    reasonCodes: [],
    confidence: "medium",
    expectedUncertaintyReduction: 1,
    verificationLevel: "light",
    budgetTokens: 400,
    mode,
    policy: {
      version: 1,
      verificationLevel: "light",
      suggestHyperPlan: false,
      maxParallelChildren: 1,
      reasonCodes: [],
    },
    avoidStrategyCodes: [],
    ...(specialistRole ? { specialistRole } : {}),
  };
}

describe("safe-dispatch", () => {
  it("documents the allowlist including Gap 1 child/MCP actions", () => {
    expect(describeSafeDispatchAllowlist()).toContain("retrieve_local");
    expect(describeSafeDispatchAllowlist()).toContain("verify");
    expect(describeSafeDispatchAllowlist()).toContain("spawn_readonly_specialist");
    expect(describeSafeDispatchAllowlist()).toContain("mcp_preflight");
    expect(describeSafeReadonlySpecialistRoles()).toContain("oracle");
    expect(describeSafeReadonlySpecialistRoles()).toContain("librarian");
    expect(isSafeAutoDispatchAction("execute")).toBe(false);
    expect(isSafeAutoDispatchAction("suggest_oracle")).toBe(false);
    expect(isSafeReadonlySpecialistRole("oracle")).toBe(true);
    expect(isSafeReadonlySpecialistRole("custom-writer")).toBe(false);
  });

  it("never auto-dispatches non-allowlisted actions", () => {
    expect(planSafeDispatch(decision("execute", "active")).kind).toBe("hint_only");
    expect(planSafeDispatch(decision("suggest_oracle", "active")).kind).toBe("hint_only");
    expect(planSafeDispatch(decision("avoid_retry", "active")).kind).toBe("hint_only");
    expect(planSafeDispatch(decision("replan", "active")).kind).toBe("hint_only");
    expect(planSafeDispatch(decision("ask_user", "active")).kind).toBe("hint_only");
    expect(isSafeAutoDispatchAction("replan")).toBe(false);
    expect(isSafeAutoDispatchAction("ask_user")).toBe(false);
  });

  it("keeps suggest_oracle hint_only (Gap 5 must not expand allowlist)", () => {
    expect(isSafeAutoDispatchAction("suggest_oracle")).toBe(false);
    expect(planSafeDispatch(decision("suggest_oracle", "active")).kind).toBe("hint_only");
    expect(planSafeDispatch(decision("suggest_oracle", "advisory")).kind).toBe("hint_only");
  });

  it("schedules safe local retrieve and verify in advisory/active", () => {
    expect(planSafeDispatch(decision("retrieve_local", "advisory")).kind).toBe("retrieve_local");
    expect(planSafeDispatch(decision("verify", "active")).kind).toBe("verify_gate");
    expect(planSafeDispatch(decision("suggest_plan", "active")).kind).toBe("suggest_plan");
    expect(planSafeDispatch(decision("finish", "active")).kind).toBe("finish");
  });

  it("auto-dispatches read-only specialist and MCP preflight only in active mode", () => {
    const spawn = planSafeDispatch(decision("spawn_readonly_specialist", "active", "explore"));
    expect(spawn).toEqual({
      kind: "spawn_readonly_specialist",
      reasonCode: "active_spawn_readonly_specialist",
      specialistRole: "explore",
    });
    const mcp = planSafeDispatch(decision("mcp_preflight", "active"));
    expect(mcp).toEqual({
      kind: "mcp_preflight",
      reasonCode: "active_mcp_preflight_librarian",
      specialistRole: "librarian",
    });
    expect(planSafeDispatch(decision("spawn_readonly_specialist", "advisory", "oracle")).kind).toBe(
      "hint_only",
    );
    expect(planSafeDispatch(decision("mcp_preflight", "advisory")).kind).toBe("hint_only");
  });

  it("falls back to oracle when specialist role is missing or unsafe", () => {
    expect(resolveSafeSpecialistRole(undefined)).toBe("oracle");
    expect(resolveSafeSpecialistRole("oracle")).toBe("oracle");
    const spawn = planSafeDispatch(decision("spawn_readonly_specialist", "active"));
    expect(spawn.kind).toBe("spawn_readonly_specialist");
    if (spawn.kind === "spawn_readonly_specialist") {
      expect(spawn.specialistRole).toBe("oracle");
    }
  });

  it("does nothing in shadow mode", () => {
    expect(planSafeDispatch(decision("retrieve_local", "shadow")).kind).toBe("none");
    expect(planSafeDispatch(decision("spawn_readonly_specialist", "shadow", "oracle")).kind).toBe(
      "none",
    );
  });
});
