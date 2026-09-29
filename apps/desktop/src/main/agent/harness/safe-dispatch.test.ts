import { describe, expect, it } from "vitest";
import type { AdaptiveDecision } from "../../../shared/contracts";
import {
  describeSafeDispatchAllowlist,
  isSafeAutoDispatchAction,
  planSafeDispatch,
} from "./safe-dispatch";

function decision(
  action: AdaptiveDecision["action"],
  mode: AdaptiveDecision["mode"],
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
  };
}

describe("safe-dispatch", () => {
  it("documents the allowlist", () => {
    expect(describeSafeDispatchAllowlist()).toContain("retrieve_local");
    expect(describeSafeDispatchAllowlist()).toContain("verify");
    expect(isSafeAutoDispatchAction("execute")).toBe(false);
    expect(isSafeAutoDispatchAction("suggest_oracle")).toBe(false);
  });

  it("never auto-dispatches non-allowlisted actions", () => {
    expect(planSafeDispatch(decision("execute", "active")).kind).toBe("hint_only");
    expect(planSafeDispatch(decision("suggest_oracle", "active")).kind).toBe("hint_only");
    expect(planSafeDispatch(decision("avoid_retry", "active")).kind).toBe("hint_only");
  });

  it("schedules safe local retrieve and verify in advisory/active", () => {
    expect(planSafeDispatch(decision("retrieve_local", "advisory")).kind).toBe("retrieve_local");
    expect(planSafeDispatch(decision("verify", "active")).kind).toBe("verify_gate");
    expect(planSafeDispatch(decision("suggest_plan", "active")).kind).toBe("suggest_plan");
    expect(planSafeDispatch(decision("finish", "active")).kind).toBe("finish");
  });

  it("does nothing in shadow mode", () => {
    expect(planSafeDispatch(decision("retrieve_local", "shadow")).kind).toBe("none");
  });
});
