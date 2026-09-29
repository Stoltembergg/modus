import type {
  AdaptiveVerificationLevel,
  HarnessInsight,
  HarnessInsightKind,
  HarnessPolicyDocument,
  HarnessPolicyEffect,
} from "../../../shared/contracts";

const SAFE_CODE = /^[a-z][a-z0-9_]{0,95}$/;
const MAX_EFFECTS = 4;
const MAX_AVOID_CODES = 8;

const VERIFICATION_RANK: Record<AdaptiveVerificationLevel, number> = {
  none: 0,
  light: 1,
  standard: 2,
  strict: 3,
};

const KIND_EFFECTS: Record<HarnessInsightKind, HarnessPolicyEffect[]> = {
  repeated_failures: [{ op: "add_avoid_strategies", codes: ["same_edit_retry", "blind_retry"] }],
  same_path_rework: [
    { op: "prefer_replan_on_qa_fail", bias: true },
    { op: "add_avoid_strategies", codes: ["same_edit_retry"] },
  ],
  context_pressure: [{ op: "prefer_retrieve_local", bias: true }],
  delegation_mismatch: [{ op: "cap_parallel_children", max: 1 }],
  missing_verification: [{ op: "raise_min_verification", level: "standard" }],
};

export type CompileInsightToPolicyInput = {
  insight: Pick<HarnessInsight, "id" | "kind">;
  promotionId: string;
  promotedAt: string;
};

export type CompileInsightToPolicyResult =
  | { ok: true; policy: HarnessPolicyDocument }
  | { ok: false; reasonCodes: string[] };

export type MergedPolicyEffects = {
  effects: HarnessPolicyEffect[];
  minVerification?: Exclude<AdaptiveVerificationLevel, "none">;
  avoidStrategyCodes: string[];
  preferRetrieveLocal: boolean;
  preferReplanOnQaFail: boolean;
  maxParallelChildren?: 1 | 2;
  reasonCodes: string[];
};

function normalizeCode(value: string): string | undefined {
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!trimmed || !SAFE_CODE.test(trimmed)) return undefined;
  return trimmed;
}

function isInsightKind(value: string): value is HarnessInsightKind {
  return value in KIND_EFFECTS;
}

function parseEffect(raw: unknown): HarnessPolicyEffect | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const effect = raw as Record<string, unknown>;
  switch (effect.op) {
    case "raise_min_verification": {
      if (effect.level === "light" || effect.level === "standard" || effect.level === "strict") {
        return { op: "raise_min_verification", level: effect.level };
      }
      return undefined;
    }
    case "add_avoid_strategies": {
      if (!Array.isArray(effect.codes)) return undefined;
      const codes = [
        ...new Set(
          effect.codes
            .filter((code): code is string => typeof code === "string")
            .map(normalizeCode)
            .filter((code): code is string => Boolean(code)),
        ),
      ].slice(0, MAX_AVOID_CODES);
      if (codes.length === 0) return undefined;
      return { op: "add_avoid_strategies", codes };
    }
    case "prefer_retrieve_local":
      return effect.bias === true ? { op: "prefer_retrieve_local", bias: true } : undefined;
    case "prefer_replan_on_qa_fail":
      return effect.bias === true ? { op: "prefer_replan_on_qa_fail", bias: true } : undefined;
    case "cap_parallel_children": {
      if (effect.max === 1 || effect.max === 2) {
        return { op: "cap_parallel_children", max: effect.max };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Compile insight kind → allowlisted effects. Ignores free-text recommendation. */
export function compileInsightToPolicy(
  input: CompileInsightToPolicyInput,
): CompileInsightToPolicyResult {
  if (!isInsightKind(input.insight.kind)) {
    return { ok: false, reasonCodes: ["unsupported_policy_kind"] };
  }
  const effects = KIND_EFFECTS[input.insight.kind].slice(0, MAX_EFFECTS);
  if (effects.length === 0) {
    return { ok: false, reasonCodes: ["unsupported_policy_kind"] };
  }
  return {
    ok: true,
    policy: {
      version: 1,
      promotionId: input.promotionId,
      insightId: input.insight.id,
      kind: input.insight.kind,
      effects,
      source: "promoted_insight",
      promotedAt: input.promotedAt,
    },
  };
}

/**
 * Parse a stored policy document. Unknown ops / malformed shapes fail closed
 * (returns undefined) so decision-time loading never throws.
 */
export function parsePolicyDocument(raw: unknown): HarnessPolicyDocument | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) return undefined;
  if (doc.source !== "promoted_insight") return undefined;
  if (typeof doc.promotionId !== "string" || typeof doc.insightId !== "string") return undefined;
  if (typeof doc.promotedAt !== "string") return undefined;
  if (typeof doc.kind !== "string" || !isInsightKind(doc.kind)) return undefined;
  if (!Array.isArray(doc.effects)) return undefined;

  const effects: HarnessPolicyEffect[] = [];
  for (const entry of doc.effects.slice(0, MAX_EFFECTS)) {
    const parsed = parseEffect(entry);
    if (!parsed) {
      // Unknown or malformed op → fail closed for the whole document.
      return undefined;
    }
    effects.push(parsed);
  }
  if (effects.length === 0) return undefined;

  return {
    version: 1,
    promotionId: doc.promotionId,
    insightId: doc.insightId,
    kind: doc.kind,
    effects,
    source: "promoted_insight",
    promotedAt: doc.promotedAt,
  };
}

/** Fold allowlisted effects into a single soft-bias set (deduped). */
export function foldEffects(effects: HarnessPolicyEffect[]): MergedPolicyEffects {
  const avoidStrategyCodes: string[] = [];
  const reasonCodes: string[] = [];
  let minVerification: Exclude<AdaptiveVerificationLevel, "none"> | undefined;
  let preferRetrieveLocal = false;
  let preferReplanOnQaFail = false;
  let maxParallelChildren: 1 | 2 | undefined;

  for (const effect of effects) {
    switch (effect.op) {
      case "raise_min_verification": {
        const currentRank = minVerification ? VERIFICATION_RANK[minVerification] : -1;
        if (VERIFICATION_RANK[effect.level] > currentRank) {
          minVerification = effect.level;
        }
        reasonCodes.push("promoted_policy_raise_min_verification");
        break;
      }
      case "add_avoid_strategies": {
        for (const code of effect.codes) {
          if (!avoidStrategyCodes.includes(code)) avoidStrategyCodes.push(code);
        }
        reasonCodes.push("promoted_policy_add_avoid_strategies");
        break;
      }
      case "prefer_retrieve_local":
        preferRetrieveLocal = true;
        reasonCodes.push("promoted_policy_prefer_retrieve_local");
        break;
      case "prefer_replan_on_qa_fail":
        preferReplanOnQaFail = true;
        reasonCodes.push("promoted_policy_prefer_replan_on_qa_fail");
        break;
      case "cap_parallel_children": {
        maxParallelChildren =
          maxParallelChildren === undefined
            ? effect.max
            : (Math.min(maxParallelChildren, effect.max) as 1 | 2);
        reasonCodes.push("promoted_policy_cap_parallel_children");
        break;
      }
      default:
        break;
    }
  }

  return {
    effects: [...effects],
    ...(minVerification ? { minVerification } : {}),
    avoidStrategyCodes: avoidStrategyCodes.slice(0, MAX_AVOID_CODES),
    preferRetrieveLocal,
    preferReplanOnQaFail,
    ...(maxParallelChildren !== undefined ? { maxParallelChildren } : {}),
    reasonCodes: [...new Set(reasonCodes)].slice(0, 16),
  };
}

/** Merge multiple documents into a single soft-bias effect set (deduped). */
export function mergePolicyEffects(documents: HarnessPolicyDocument[]): MergedPolicyEffects {
  return foldEffects(documents.flatMap((doc) => doc.effects));
}

export function maxVerificationLevel(
  a: AdaptiveVerificationLevel,
  b: AdaptiveVerificationLevel,
): AdaptiveVerificationLevel {
  return VERIFICATION_RANK[a] >= VERIFICATION_RANK[b] ? a : b;
}

/**
 * Soft-apply merged promoted effects onto an already-selected execution policy.
 * Never raises hard parallelism caps; only lowers maxParallelChildren.
 */
export function applyPolicyToExecutionInput(
  policy: {
    verificationLevel: AdaptiveVerificationLevel;
    maxParallelChildren: number;
    reasonCodes: string[];
  },
  merged: MergedPolicyEffects,
): {
  verificationLevel: AdaptiveVerificationLevel;
  maxParallelChildren: number;
  reasonCodes: string[];
} {
  let verificationLevel = policy.verificationLevel;
  if (merged.minVerification) {
    verificationLevel = maxVerificationLevel(verificationLevel, merged.minVerification);
  }

  let maxParallelChildren = policy.maxParallelChildren;
  if (merged.maxParallelChildren !== undefined && maxParallelChildren > 0) {
    maxParallelChildren = Math.min(maxParallelChildren, merged.maxParallelChildren);
  }

  return {
    verificationLevel,
    maxParallelChildren,
    reasonCodes: [...new Set([...policy.reasonCodes, ...merged.reasonCodes])].slice(0, 32),
  };
}
