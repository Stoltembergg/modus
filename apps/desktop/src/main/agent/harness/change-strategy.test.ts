import { describe, expect, it } from "vitest";
import {
  asChangeStrategyCodes,
  hypothesisCodeForQaFailure,
  selectChangeStrategy,
  strategyCodeForQaFailure,
} from "./change-strategy";

describe("change-strategy", () => {
  it("filters unknown avoid codes to the allowlist", () => {
    expect(asChangeStrategyCodes(["same_edit_retry", "DROP TABLE", "blind_retry"])).toEqual([
      "same_edit_retry",
      "blind_retry",
    ]);
  });

  it("recommends ask_clarification when open questions remain", () => {
    const plan = selectChangeStrategy({
      avoided: ["same_edit_retry"],
      qaFailed: true,
      oracleConsulted: true,
      openQuestionCount: 2,
    });
    expect(plan.recommended).toBe("ask_clarification");
    expect(plan.reasonCodes).toContain("change_strategy_ask_clarification");
  });

  it("keeps recommended none until Oracle is consulted when same_edit_retry is avoided", () => {
    const plan = selectChangeStrategy({
      avoided: ["same_edit_retry"],
      qaFailed: true,
      oracleConsulted: false,
    });
    expect(plan.recommended).toBe("none");
    expect(plan.oracleConsulted).toBe(false);
    expect(plan.reasonCodes).toContain("change_strategy_await_oracle");
  });

  it("recommends replan_scope after Oracle findings when same_edit_retry is avoided", () => {
    const plan = selectChangeStrategy({
      avoided: ["same_edit_retry"],
      qaFailed: true,
      oracleConsulted: true,
    });
    expect(plan.recommended).toBe("replan_scope");
    expect(plan.reasonCodes).toEqual(
      expect.arrayContaining(["change_strategy_replan_scope", "oracle_findings_present"]),
    );
  });

  it("forces replan_scope from promoted prefer_replan_on_qa_fail even if Oracle pending", () => {
    const plan = selectChangeStrategy({
      avoided: ["same_edit_retry"],
      qaFailed: true,
      oracleConsulted: false,
      promotedEffects: [{ op: "prefer_replan_on_qa_fail", bias: true }],
    });
    expect(plan.recommended).toBe("replan_scope");
    expect(plan.reasonCodes).toContain("promoted_policy_prefer_replan_on_qa_fail");
  });

  it("maps continuation-without-evidence QA fails to blind_retry", () => {
    expect(strategyCodeForQaFailure({ continuationWithoutNewEvidence: true })).toBe("blind_retry");
    expect(strategyCodeForQaFailure({})).toBe("same_edit_retry");
    expect(
      hypothesisCodeForQaFailure({
        oracleDigestPresent: true,
        editedAfterOracleWithoutReplan: true,
      }),
    ).toBe("ignored_oracle");
  });
});
