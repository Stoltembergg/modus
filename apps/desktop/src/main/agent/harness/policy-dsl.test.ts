import { describe, expect, it } from "vitest";
import {
  applyPolicyToExecutionInput,
  compileInsightToPolicy,
  mergePolicyEffects,
  parsePolicyDocument,
} from "./policy-dsl";

describe("policy-dsl", () => {
  it("compiles each insight kind to the default allowlisted effects", () => {
    const cases = [
      {
        kind: "repeated_failures" as const,
        ops: ["add_avoid_strategies"],
        codes: ["same_edit_retry", "blind_retry"],
      },
      {
        kind: "same_path_rework" as const,
        ops: ["prefer_replan_on_qa_fail", "add_avoid_strategies"],
        codes: ["same_edit_retry"],
      },
      { kind: "context_pressure" as const, ops: ["prefer_retrieve_local"], codes: [] },
      { kind: "delegation_mismatch" as const, ops: ["cap_parallel_children"], codes: [] },
      { kind: "missing_verification" as const, ops: ["raise_min_verification"], codes: [] },
    ];

    for (const entry of cases) {
      const result = compileInsightToPolicy({
        insight: { id: `i-${entry.kind}`, kind: entry.kind },
        promotionId: "promo-1",
        promotedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.policy.effects.map((effect) => effect.op)).toEqual(entry.ops);
      expect(result.policy.source).toBe("promoted_insight");
      expect(result.policy.version).toBe(1);
      const avoid = result.policy.effects.find((effect) => effect.op === "add_avoid_strategies");
      if (entry.codes.length > 0) {
        expect(avoid && avoid.op === "add_avoid_strategies" ? avoid.codes : []).toEqual(
          entry.codes,
        );
      }
    }
  });

  it("refuses unknown kinds", () => {
    const unknown = compileInsightToPolicy({
      insight: { id: "x", kind: "totally_unknown" as never },
      promotionId: "p",
      promotedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reasonCodes).toContain("unsupported_policy_kind");
  });

  it("rejects unknown effect ops at parse time (fail closed)", () => {
    expect(
      parsePolicyDocument({
        version: 1,
        promotionId: "p1",
        insightId: "i1",
        kind: "repeated_failures",
        source: "promoted_insight",
        promotedAt: "2026-01-01T00:00:00.000Z",
        effects: [{ op: "widen_permissions", level: "admin" }],
      }),
    ).toBeUndefined();

    expect(
      parsePolicyDocument({
        version: 1,
        promotionId: "p1",
        insightId: "i1",
        kind: "missing_verification",
        source: "promoted_insight",
        promotedAt: "2026-01-01T00:00:00.000Z",
        effects: [{ op: "raise_min_verification", level: "standard" }],
      }),
    ).toMatchObject({
      kind: "missing_verification",
      effects: [{ op: "raise_min_verification", level: "standard" }],
    });
  });

  it("merges effects with max verification floor and min parallel cap", () => {
    const a = compileInsightToPolicy({
      insight: { id: "a", kind: "missing_verification" },
      promotionId: "p-a",
      promotedAt: "2026-01-01T00:00:00.000Z",
    });
    const b = compileInsightToPolicy({
      insight: { id: "b", kind: "delegation_mismatch" },
      promotionId: "p-b",
      promotedAt: "2026-01-01T00:00:00.000Z",
    });
    const c = compileInsightToPolicy({
      insight: { id: "c", kind: "repeated_failures" },
      promotionId: "p-c",
      promotedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!(a.ok && b.ok && c.ok)) return;

    const merged = mergePolicyEffects([a.policy, b.policy, c.policy]);
    expect(merged.minVerification).toBe("standard");
    expect(merged.maxParallelChildren).toBe(1);
    expect(merged.avoidStrategyCodes).toEqual(["same_edit_retry", "blind_retry"]);
    expect(merged.reasonCodes).toEqual(
      expect.arrayContaining([
        "promoted_policy_raise_min_verification",
        "promoted_policy_cap_parallel_children",
        "promoted_policy_add_avoid_strategies",
      ]),
    );
  });

  it("never raises parallelism when applying promoted caps", () => {
    const merged = mergePolicyEffects([
      {
        version: 1,
        promotionId: "p",
        insightId: "i",
        kind: "delegation_mismatch",
        source: "promoted_insight",
        promotedAt: "2026-01-01T00:00:00.000Z",
        effects: [{ op: "cap_parallel_children", max: 1 }],
      },
    ]);
    const applied = applyPolicyToExecutionInput(
      {
        verificationLevel: "none",
        maxParallelChildren: 3,
        reasonCodes: ["parallelism_moderate"],
      },
      merged,
    );
    expect(applied.maxParallelChildren).toBe(1);
    expect(applied.reasonCodes).toContain("promoted_policy_cap_parallel_children");

    const atCap = applyPolicyToExecutionInput(
      {
        verificationLevel: "light",
        maxParallelChildren: 0,
        reasonCodes: ["parallelism_at_cap"],
      },
      merged,
    );
    expect(atCap.maxParallelChildren).toBe(0);
  });
});
