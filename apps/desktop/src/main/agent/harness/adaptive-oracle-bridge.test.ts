import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingOracleEnvelope,
  installAdaptiveOracleBridge,
  joinAdaptiveOracleFindings,
  peekPendingOracleEnvelope,
  resetAdaptiveOracleBridgeForTests,
} from "./adaptive-oracle-bridge";
import { decideNext, formatAdaptiveDecisionHint } from "./meta-controller";

afterEach(() => {
  resetAdaptiveOracleBridgeForTests();
  clearPendingOracleEnvelope();
});

function baseFailedSnapshot() {
  return {
    sessionId: "s1",
    runId: "r1",
    workspaceId: "w1",
    mode: "build" as const,
    classification: {
      taskType: "implementation" as const,
      complexity: "complex" as const,
      risk: "high" as const,
      confidence: "high" as const,
      reasons: ["test"],
      suggestedRole: "oracle" as const,
    },
    failureAttempts: [
      {
        id: "a1",
        sessionId: "s1",
        runId: "r1",
        strategyCode: "same_edit_retry",
        status: "failed" as const,
        reasonCode: "qa_failed",
        evidenceEventIds: [] as string[],
        createdAt: new Date().toISOString(),
      },
    ],
    remainingContinuationBudget: 0,
    enabledModelIds: [] as string[],
    decisionMode: "active" as const,
    openQuestionCount: 0,
    unresolvedCriterionCount: 0,
    qaStatus: "failed" as const,
    impact: {
      blastRadius: "cross_module" as const,
      impactedPathCount: 4,
      confidence: "medium" as const,
      unknownReasons: [] as string[],
      reasonCodes: [] as string[],
    },
    taskState: {
      phase: "verifying" as const,
      verificationStatus: "failed" as const,
      criteria: [],
      openQuestionRefs: [] as string[],
      hypothesisRefs: [] as string[],
    },
  };
}

describe("adaptive-oracle-bridge", () => {
  it("caps findings and sets oracleConsulted on bounded join success", async () => {
    const tracker: {
      adaptiveOracleChildSessionId: string;
      adaptiveOracleConsulted?: boolean;
      adaptiveOracleDigest?: string;
      taskState: { hypothesisRefs: string[] };
    } = {
      adaptiveOracleChildSessionId: "child-1",
      taskState: { hypothesisRefs: [] },
    };
    const runtime = {
      waitBackground: vi.fn(async () => ({
        timedOut: false,
        subagents: [
          {
            id: "child-1",
            status: "completed",
            output: "root cause: missing null check in parser",
          },
        ],
      })),
    };
    await joinAdaptiveOracleFindings(runtime, "parent-1", tracker);
    expect(tracker.adaptiveOracleConsulted).toBe(true);
    expect(tracker.adaptiveOracleDigest).toMatch(/null check/);
    expect(peekPendingOracleEnvelope()).toMatch(/adaptive_oracle_findings/);
    expect(tracker.taskState.hypothesisRefs[0]).toMatch(/^oracle:/);
  });

  it("records timeout without throwing", async () => {
    const tracker: {
      adaptiveOracleChildSessionId: string;
      adaptiveOracleConsulted?: boolean;
      adaptiveOracleWaitReason?: "oracle_wait_timeout" | "oracle_wait_failed";
      adaptiveOracleDigest?: string;
    } = { adaptiveOracleChildSessionId: "child-2" };
    await joinAdaptiveOracleFindings(
      {
        waitBackground: async () => ({
          timedOut: true,
          subagents: [{ id: "child-2", status: "running" }],
        }),
      },
      "parent-1",
      tracker,
    );
    expect(tracker.adaptiveOracleConsulted).toBe(true);
    expect(tracker.adaptiveOracleWaitReason).toBe("oracle_wait_timeout");
    expect(tracker.adaptiveOracleDigest).toBeUndefined();
  });

  it("installs consult augmenter so decideNext sees oracleConsulted", async () => {
    class FakeRuntime {
      runOutputTrackers = new Map();
      async waitBackground() {
        return { timedOut: false, subagents: [] as Array<{ id: string; status: string }> };
      }
      async runSubagent() {
        return { session: { id: "x" } };
      }
      async flushPendingAdaptiveSpawn() {}
      recordAdaptiveFailure() {}
    }
    // Put consult on the prototype so installAdaptiveOracleBridge can wrap it.
    (
      FakeRuntime.prototype as unknown as {
        consultAdaptiveController: (
          rs: unknown,
          tracker: unknown,
          input: unknown,
        ) => Promise<unknown>;
      }
    ).consultAdaptiveController = async () => decideNext(baseFailedSnapshot());

    installAdaptiveOracleBridge(FakeRuntime);
    const runtime = new FakeRuntime() as unknown as {
      consultAdaptiveController: (
        rs: unknown,
        tracker: unknown,
        input: unknown,
      ) => Promise<ReturnType<typeof decideNext>>;
    };
    const tracker = {
      adaptiveOracleConsulted: true,
      adaptiveOracleDigest: "digest",
    };
    const decision = await runtime.consultAdaptiveController({}, tracker, {});
    expect(decision.action).toBe("replan");
    expect(decision.changeStrategy?.recommended).toBe("replan_scope");
    expect(formatAdaptiveDecisionHint(decision)).toMatch(/replan/i);
  });
});
