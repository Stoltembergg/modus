import { describe, expect, it } from "vitest";
import type { AdaptiveDecisionSnapshot, AdaptiveFailureAttempt } from "../../../shared/contracts";
import { decideNext, formatAdaptiveDecisionHint } from "./meta-controller";

function snapshot(overrides: Partial<AdaptiveDecisionSnapshot> = {}): AdaptiveDecisionSnapshot {
  return {
    sessionId: "s1",
    runId: "r1",
    workspaceId: "w1",
    mode: "build",
    classification: {
      taskType: "implementation",
      complexity: "simple",
      risk: "low",
      confidence: "high",
      reasons: ["clear_implementation_request"],
    },
    failureAttempts: [],
    remainingContinuationBudget: 1,
    enabledModelIds: [],
    decisionMode: "advisory",
    openQuestionCount: 0,
    unresolvedCriterionCount: 0,
    ...overrides,
  };
}

describe("meta-controller", () => {
  it("finishes when verification is satisfied", () => {
    const decision = decideNext(
      snapshot({
        taskState: {
          phase: "terminal",
          verificationStatus: "verified",
          criteria: [],
          openQuestionRefs: [],
          hypothesisRefs: [],
        },
        qaStatus: "passed",
      }),
    );
    expect(decision.action).toBe("finish");
    expect(formatAdaptiveDecisionHint(decision)).toBeUndefined();
  });

  it("avoids repeating a failed strategy at the same revision", () => {
    const attempt: AdaptiveFailureAttempt = {
      id: "a1",
      sessionId: "s1",
      runId: "r1",
      strategyCode: "same_edit_retry",
      status: "failed",
      reasonCode: "qa_failed",
      revision: "rev1",
      evidenceEventIds: [],
      createdAt: new Date().toISOString(),
    };
    const decision = decideNext(
      snapshot({
        qaStatus: "failed",
        failureAttempts: [attempt],
        impact: {
          revision: "rev1",
          blastRadius: "local",
          impactedPathCount: 1,
          confidence: "medium",
          unknownReasons: [],
          reasonCodes: [],
        },
        taskState: {
          phase: "verifying",
          verificationStatus: "failed",
          criteria: [
            {
              criterionId: "check:tests",
              source: "check",
              status: "failed",
              evidenceEventIds: [],
              requiredCheckKinds: ["tests"],
            },
          ],
          openQuestionRefs: [],
          hypothesisRefs: [],
        },
      }),
    );
    expect(decision.action).toBe("avoid_retry");
    expect(decision.avoidStrategyCodes).toContain("same_edit_retry");
    expect(decision.changeStrategy?.recommended).toBe("replan_scope");
    expect(formatAdaptiveDecisionHint(decision)).toMatch(/Do not repeat/i);
  });

  it("requests verification before finish when evidence is missing", () => {
    const decision = decideNext(
      snapshot({
        classification: {
          taskType: "implementation",
          complexity: "moderate",
          risk: "medium",
          confidence: "high",
          reasons: ["multiple_files_in_scope"],
        },
        unresolvedCriterionCount: 2,
        qaStatus: "missing",
        taskState: {
          phase: "executing",
          verificationStatus: "pending",
          criteria: [
            {
              criterionId: "check:tests",
              source: "check",
              status: "pending",
              evidenceEventIds: [],
              requiredCheckKinds: ["tests"],
            },
          ],
          openQuestionRefs: [],
          hypothesisRefs: [],
        },
      }),
    );
    expect(decision.action).toBe("verify");
    expect(decision.verificationLevel).toBe("standard");
  });

  it("suggests plan for complex scope without forcing execution change in shadow mode", () => {
    const decision = decideNext(
      snapshot({
        decisionMode: "shadow",
        classification: {
          taskType: "implementation",
          complexity: "complex",
          risk: "medium",
          confidence: "high",
          reasons: ["cross_subsystem_scope"],
        },
        impact: {
          blastRadius: "cross_module",
          impactedPathCount: 9,
          confidence: "high",
          unknownReasons: [],
          reasonCodes: ["cross_module_scope"],
        },
      }),
    );
    expect(decision.action).toBe("suggest_plan");
    expect(decision.mode).toBe("shadow");
    expect(formatAdaptiveDecisionHint(decision)).toBeUndefined();
  });

  it("asks the user when the task is awaiting clarification", () => {
    const decision = decideNext(
      snapshot({
        openQuestionCount: 1,
        taskState: {
          phase: "awaiting_user",
          verificationStatus: "pending",
          criteria: [],
          openQuestionRefs: ["q1"],
          hypothesisRefs: [],
        },
      }),
    );
    expect(decision.action).toBe("ask_user");
  });

  it("spawns a read-only oracle specialist in active mode on high-risk failure", () => {
    const decision = decideNext(
      snapshot({
        decisionMode: "active",
        qaStatus: "failed",
        classification: {
          taskType: "implementation",
          complexity: "complex",
          risk: "high",
          confidence: "high",
          reasons: ["cross_subsystem_scope"],
          suggestedRole: "oracle",
        },
        impact: {
          blastRadius: "cross_module",
          impactedPathCount: 8,
          confidence: "medium",
          unknownReasons: [],
          reasonCodes: [],
        },
        taskState: {
          phase: "verifying",
          verificationStatus: "failed",
          criteria: [],
          openQuestionRefs: [],
          hypothesisRefs: [],
        },
      }),
    );
    expect(decision.action).toBe("spawn_readonly_specialist");
    expect(decision.specialistRole).toBe("oracle");
    expect(formatAdaptiveDecisionHint(decision)).toMatch(/read-only oracle/i);
  });

  it("keeps suggest_oracle as a hint in advisory mode", () => {
    const decision = decideNext(
      snapshot({
        decisionMode: "advisory",
        classification: {
          taskType: "oracle",
          complexity: "moderate",
          risk: "low",
          confidence: "low",
          reasons: ["architecture_question"],
          suggestedRole: "oracle",
        },
      }),
    );
    expect(decision.action).toBe("suggest_oracle");
  });

  it("schedules MCP preflight librarian in active mode for librarian-scoped uncertainty", () => {
    const decision = decideNext(
      snapshot({
        decisionMode: "active",
        classification: {
          taskType: "librarian",
          complexity: "complex",
          risk: "low",
          confidence: "high",
          reasons: ["needs_external_docs"],
          suggestedRole: "librarian",
        },
        impact: {
          blastRadius: "module",
          impactedPathCount: 0,
          confidence: "unknown",
          unknownReasons: ["no_typed_paths"],
          reasonCodes: [],
        },
        unresolvedCriterionCount: 1,
      }),
    );
    expect(decision.action).toBe("mcp_preflight");
    expect(decision.specialistRole).toBe("librarian");
  });

  it("applies promoted avoid strategies to prefer avoid_retry on QA fail", () => {
    const decision = decideNext(
      snapshot({
        qaStatus: "failed",
        promotedPolicies: [
          {
            version: 1,
            promotionId: "p1",
            insightId: "i1",
            kind: "repeated_failures",
            source: "promoted_insight",
            promotedAt: "2026-01-01T00:00:00.000Z",
            effects: [{ op: "add_avoid_strategies", codes: ["same_edit_retry", "blind_retry"] }],
          },
        ],
        taskState: {
          phase: "verifying",
          verificationStatus: "failed",
          criteria: [],
          openQuestionRefs: [],
          hypothesisRefs: [],
        },
      }),
    );
    expect(decision.action).toBe("avoid_retry");
    expect(decision.avoidStrategyCodes).toEqual(
      expect.arrayContaining(["same_edit_retry", "blind_retry"]),
    );
    expect(decision.reasonCodes).toContain("promoted_policy_add_avoid_strategies");
  });

  it("prefers retrieve_local under promoted context_pressure bias", () => {
    const decision = decideNext(
      snapshot({
        classification: {
          taskType: "implementation",
          complexity: "complex",
          risk: "medium",
          confidence: "high",
          reasons: ["cross_subsystem_scope"],
        },
        impact: {
          blastRadius: "cross_module",
          impactedPathCount: 9,
          confidence: "unknown",
          unknownReasons: ["no_typed_paths"],
          reasonCodes: [],
        },
        unresolvedCriterionCount: 1,
        promotedPolicies: [
          {
            version: 1,
            promotionId: "p2",
            insightId: "i2",
            kind: "context_pressure",
            source: "promoted_insight",
            promotedAt: "2026-01-01T00:00:00.000Z",
            effects: [{ op: "prefer_retrieve_local", bias: true }],
          },
        ],
      }),
    );
    expect(decision.action).toBe("retrieve_local");
    expect(decision.reasonCodes).toContain("promoted_policy_prefer_retrieve_local");
    expect(["execute", "spawn_readonly_specialist"]).not.toContain(decision.action);
  });

  it("awaits Oracle on high-risk QA fail when avoid codes apply but Oracle not consulted", () => {
    const decision = decideNext(
      snapshot({
        qaStatus: "failed",
        classification: {
          taskType: "implementation",
          complexity: "complex",
          risk: "high",
          confidence: "high",
          reasons: ["cross_subsystem_scope"],
        },
        impact: {
          blastRadius: "cross_module",
          impactedPathCount: 8,
          confidence: "medium",
          unknownReasons: [],
          reasonCodes: [],
        },
        promotedPolicies: [
          {
            version: 1,
            promotionId: "p3",
            insightId: "i3",
            kind: "same_path_rework",
            source: "promoted_insight",
            promotedAt: "2026-01-01T00:00:00.000Z",
            effects: [
              { op: "prefer_replan_on_qa_fail", bias: true },
              { op: "add_avoid_strategies", codes: ["same_edit_retry"] },
            ],
          },
        ],
        taskState: {
          phase: "verifying",
          verificationStatus: "failed",
          criteria: [],
          openQuestionRefs: [],
          hypothesisRefs: [],
        },
      }),
    );
    // Gap 5: high-risk + avoided + Oracle not consulted → advisory suggest_oracle (active → spawn).
    // prefer_replan_on_qa_fail still shapes changeStrategy.recommended.
    expect(decision.action).toBe("suggest_oracle");
    expect(decision.changeStrategy?.recommended).toBe("replan_scope");
  });

  it("after Oracle findings, does not spawn again and recommends replan_scope", () => {
    const attempt: AdaptiveFailureAttempt = {
      id: "a1",
      sessionId: "s1",
      runId: "r1",
      strategyCode: "same_edit_retry",
      status: "failed",
      reasonCode: "qa_failed",
      revision: "rev1",
      evidenceEventIds: [],
      createdAt: new Date().toISOString(),
    };
    const decision = decideNext(
      snapshot({
        decisionMode: "active",
        qaStatus: "failed",
        oracleConsulted: true,
        oracleDigestPresent: true,
        failureAttempts: [attempt],
        classification: {
          taskType: "implementation",
          complexity: "complex",
          risk: "high",
          confidence: "high",
          reasons: ["cross_subsystem_scope"],
          suggestedRole: "oracle",
        },
        impact: {
          revision: "rev1",
          blastRadius: "cross_module",
          impactedPathCount: 8,
          confidence: "medium",
          unknownReasons: [],
          reasonCodes: [],
        },
        taskState: {
          phase: "verifying",
          verificationStatus: "failed",
          criteria: [],
          openQuestionRefs: [],
          hypothesisRefs: [],
        },
      }),
    );
    expect(decision.action).toBe("replan");
    expect(decision.action).not.toBe("spawn_readonly_specialist");
    expect(decision.changeStrategy?.recommended).toBe("replan_scope");
    expect(decision.reasonCodes).toEqual(
      expect.arrayContaining(["change_strategy_replan_scope", "oracle_findings_present"]),
    );
    expect(formatAdaptiveDecisionHint(decision)).toMatch(
      /Recommended change strategy: replan scope/i,
    );
  });

  it("spawns read-only oracle in active mode when avoided and Oracle not consulted", () => {
    const attempt: AdaptiveFailureAttempt = {
      id: "a2",
      sessionId: "s1",
      runId: "r1",
      strategyCode: "same_edit_retry",
      status: "failed",
      reasonCode: "qa_failed",
      revision: "rev1",
      evidenceEventIds: [],
      createdAt: new Date().toISOString(),
    };
    const decision = decideNext(
      snapshot({
        decisionMode: "active",
        qaStatus: "failed",
        oracleConsulted: false,
        failureAttempts: [attempt],
        classification: {
          taskType: "implementation",
          complexity: "complex",
          risk: "high",
          confidence: "high",
          reasons: ["cross_subsystem_scope"],
          suggestedRole: "oracle",
        },
        impact: {
          revision: "rev1",
          blastRadius: "cross_module",
          impactedPathCount: 8,
          confidence: "medium",
          unknownReasons: [],
          reasonCodes: [],
        },
        taskState: {
          phase: "verifying",
          verificationStatus: "failed",
          criteria: [],
          openQuestionRefs: [],
          hypothesisRefs: [],
        },
      }),
    );
    expect(decision.action).toBe("spawn_readonly_specialist");
    expect(decision.specialistRole).toBe("oracle");
    expect(decision.changeStrategy?.recommended).toBe("none");
  });

  it("replans on QA fail from prefer_replan when no avoid codes apply", () => {
    const decision = decideNext(
      snapshot({
        qaStatus: "failed",
        classification: {
          taskType: "implementation",
          complexity: "complex",
          risk: "high",
          confidence: "high",
          reasons: ["cross_subsystem_scope"],
        },
        impact: {
          blastRadius: "cross_module",
          impactedPathCount: 8,
          confidence: "medium",
          unknownReasons: [],
          reasonCodes: [],
        },
        promotedPolicies: [
          {
            version: 1,
            promotionId: "p4",
            insightId: "i4",
            kind: "same_path_rework",
            source: "promoted_insight",
            promotedAt: "2026-01-01T00:00:00.000Z",
            effects: [{ op: "prefer_replan_on_qa_fail", bias: true }],
          },
        ],
        taskState: {
          phase: "verifying",
          verificationStatus: "failed",
          criteria: [],
          openQuestionRefs: [],
          hypothesisRefs: [],
        },
      }),
    );
    expect(decision.action).toBe("replan");
    expect(decision.reasonCodes).toContain("promoted_policy_prefer_replan_on_qa_fail");
  });
});
