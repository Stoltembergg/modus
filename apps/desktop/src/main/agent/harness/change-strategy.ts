import type {
  ChangeStrategyCode,
  ChangeStrategyPlan,
  HarnessPolicyEffect,
} from "../../../shared/contracts";

const CHANGE_STRATEGY_CODES = [
  "same_edit_retry",
  "blind_retry",
  "narrow_fix",
  "expand_tests",
  "retrieve_then_edit",
  "replan_scope",
  "ask_clarification",
] as const satisfies readonly ChangeStrategyCode[];

const CHANGE_STRATEGY_SET = new Set<string>(CHANGE_STRATEGY_CODES);

export function isChangeStrategyCode(value: string): value is ChangeStrategyCode {
  return CHANGE_STRATEGY_SET.has(value);
}

export function asChangeStrategyCodes(codes: string[]): ChangeStrategyCode[] {
  const out: ChangeStrategyCode[] = [];
  for (const code of codes) {
    if (isChangeStrategyCode(code) && !out.includes(code)) out.push(code);
  }
  return out.slice(0, 24);
}

function preferReplanFromEffects(effects: HarnessPolicyEffect[] | undefined): boolean {
  return (
    effects?.some((effect) => effect.op === "prefer_replan_on_qa_fail" && effect.bias === true) ===
    true
  );
}

function preferRetrieveFromEffects(effects: HarnessPolicyEffect[] | undefined): boolean {
  return (
    effects?.some((effect) => effect.op === "prefer_retrieve_local" && effect.bias === true) ===
    true
  );
}

/**
 * Pure change-strategy selector (Gap 5).
 * Never auto-dispatches tools — Meta Controller maps recommended codes to hint actions.
 */
export function selectChangeStrategy(input: {
  avoided: string[];
  qaFailed: boolean;
  oracleConsulted: boolean;
  openQuestionCount?: number;
  preferReplanOnQaFail?: boolean;
  preferRetrieveLocal?: boolean;
  promotedEffects?: HarnessPolicyEffect[];
}): ChangeStrategyPlan {
  const avoided = asChangeStrategyCodes(input.avoided);
  const reasonCodes: string[] = [];
  const preferReplan =
    input.preferReplanOnQaFail === true || preferReplanFromEffects(input.promotedEffects);
  const preferRetrieve =
    input.preferRetrieveLocal === true || preferRetrieveFromEffects(input.promotedEffects);
  const openQuestions = Math.max(0, input.openQuestionCount ?? 0);

  if (openQuestions > 0) {
    reasonCodes.push("change_strategy_ask_clarification");
    return {
      version: 1,
      avoided,
      recommended: "ask_clarification",
      oracleConsulted: input.oracleConsulted,
      reasonCodes,
    };
  }

  if (!input.qaFailed) {
    return {
      version: 1,
      avoided,
      recommended: "none",
      oracleConsulted: input.oracleConsulted,
      reasonCodes,
    };
  }

  if (preferReplan) {
    reasonCodes.push("change_strategy_replan_scope", "promoted_policy_prefer_replan_on_qa_fail");
    return {
      version: 1,
      avoided,
      recommended: "replan_scope",
      oracleConsulted: input.oracleConsulted,
      reasonCodes,
    };
  }

  if (input.oracleConsulted) {
    if (preferRetrieve) {
      reasonCodes.push("change_strategy_retrieve_then_edit", "oracle_findings_present");
      return {
        version: 1,
        avoided,
        recommended: "retrieve_then_edit",
        oracleConsulted: true,
        reasonCodes,
      };
    }
    if (avoided.includes("same_edit_retry") || avoided.includes("blind_retry")) {
      reasonCodes.push("change_strategy_replan_scope", "oracle_findings_present");
      return {
        version: 1,
        avoided,
        recommended: "replan_scope",
        oracleConsulted: true,
        reasonCodes,
      };
    }
    reasonCodes.push("change_strategy_narrow_fix", "oracle_findings_present");
    return {
      version: 1,
      avoided,
      recommended: "narrow_fix",
      oracleConsulted: true,
      reasonCodes,
    };
  }

  // Oracle not yet consulted: keep recommended none so Gap 1 spawn/suggest_oracle can run.
  if (avoided.includes("same_edit_retry") || avoided.includes("blind_retry")) {
    reasonCodes.push("change_strategy_await_oracle");
  }
  return {
    version: 1,
    avoided,
    recommended: "none",
    oracleConsulted: false,
    reasonCodes,
  };
}

/**
 * Map QA-failure context to a SAFE Failure Intelligence strategy code.
 * Does not embed prompt/command text.
 */
export function strategyCodeForQaFailure(input: {
  continuationWithoutNewEvidence?: boolean;
  oracleDigestPresent?: boolean;
  editedAfterOracleWithoutReplan?: boolean;
}): ChangeStrategyCode {
  if (input.continuationWithoutNewEvidence) return "blind_retry";
  if (input.editedAfterOracleWithoutReplan && input.oracleDigestPresent) return "same_edit_retry";
  return "same_edit_retry";
}

export function hypothesisCodeForQaFailure(input: {
  oracleDigestPresent?: boolean;
  editedAfterOracleWithoutReplan?: boolean;
}): string | undefined {
  if (input.editedAfterOracleWithoutReplan && input.oracleDigestPresent) return "ignored_oracle";
  return undefined;
}
