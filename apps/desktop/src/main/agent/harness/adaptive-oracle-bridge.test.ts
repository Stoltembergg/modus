import { describe, expect, it, vi } from "vitest";
import type { AdaptiveDecisionSnapshot } from "../../../shared/contracts";
import * as bridge from "./adaptive-oracle-bridge";
import {
  ADAPTIVE_ORACLE_WAIT_MS,
  type AdaptiveOracleTrackerFields,
  joinAdaptiveOracleFindings,
} from "./adaptive-oracle-bridge";
import { decideNext, formatAdaptiveDecisionHint } from "./meta-controller";
import { ORACLE_DIGEST_MAX_BYTES } from "./oracle-findings";

// Policy storage opens the desktop database; these tests exercise caller-owned run data.
vi.mock("./promoted-policy-store", () => ({ loadPromotedPolicies: () => [] }));

function failedSnapshot(
  sessionId: string,
  tracker: AdaptiveOracleTrackerFields,
): AdaptiveDecisionSnapshot {
  return {
    sessionId,
    runId: `${sessionId}-run`,
    workspaceId: "fixture-workspace",
    mode: "build",
    classification: {
      taskType: "implementation",
      complexity: "complex",
      risk: "high",
      confidence: "high",
      reasons: ["fixture"],
      suggestedRole: "oracle",
    },
    failureAttempts: [],
    remainingContinuationBudget: 0,
    enabledModelIds: [],
    decisionMode: "active",
    openQuestionCount: 0,
    unresolvedCriterionCount: 1,
    qaStatus: "failed",
    oracleConsulted: tracker.adaptiveOracleConsulted === true,
    oracleDigestPresent: Boolean(tracker.adaptiveOracleDigest),
    promotedPolicies: [],
  };
}

describe("adaptive-oracle-bridge", () => {
  it("keeps concurrent session findings and the next run isolated", async () => {
    type Result = {
      timedOut: boolean;
      subagents: Array<{ id: string; status: string; output?: string }>;
    };
    const pending = new Map<string, (result: Result) => void>();
    const runtime = {
      waitBackground: ({ sessionId }: { sessionId: string }) =>
        new Promise<Result>((resolve) => pending.set(sessionId, resolve)),
    };
    const trackerA: AdaptiveOracleTrackerFields = {
      adaptiveOracleChildSessionId: "child-a",
      taskState: { hypothesisRefs: [], evidenceEventIds: [], verificationStatus: "failed" },
    };
    const trackerB: AdaptiveOracleTrackerFields = { adaptiveOracleChildSessionId: "child-b" };
    const joinA = joinAdaptiveOracleFindings(runtime, "session-a", trackerA);
    const joinB = joinAdaptiveOracleFindings(runtime, "session-b", trackerB);
    pending.get("session-b")?.({
      timedOut: false,
      subagents: [{ id: "child-b", status: "completed", output: "SESSION_B_ONLY" }],
    });
    await joinB;
    const decisionB = decideNext(failedSnapshot("session-b", trackerB));
    const hintB = formatAdaptiveDecisionHint(decisionB, trackerB.adaptiveOracleDigest);
    expect(hintB).toContain("SESSION_B_ONLY");
    expect(hintB).not.toContain("SESSION_A_ONLY");

    // A is still pending: B's completed advisory must not reach A's hint or decision.
    const pendingDecisionA = decideNext(failedSnapshot("session-a", trackerA));
    expect(
      formatAdaptiveDecisionHint(pendingDecisionA, trackerA.adaptiveOracleDigest),
    ).not.toContain("SESSION_B_ONLY");
    pending.get("session-a")?.({
      timedOut: false,
      subagents: [{ id: "child-a", status: "completed", output: "SESSION_A_ONLY" }],
    });
    await joinA;
    const decisionA = decideNext(failedSnapshot("session-a", trackerA));
    const hintA = formatAdaptiveDecisionHint(decisionA, trackerA.adaptiveOracleDigest);
    expect(hintA).toContain("SESSION_A_ONLY");
    expect(hintA).not.toContain("SESSION_B_ONLY");
    expect(decisionA.action).toBe("replan");
    expect(decisionB.action).toBe("replan");
    expect(trackerA.taskState).toMatchObject({
      hypothesisRefs: ["oracle:child-a"],
      evidenceEventIds: [],
      verificationStatus: "failed",
    });

    const nextRun: AdaptiveOracleTrackerFields = {};
    const nextDecision = decideNext(failedSnapshot("session-a", nextRun));
    const nextHint = formatAdaptiveDecisionHint(nextDecision);
    expect(nextDecision.action).toBe("spawn_readonly_specialist");
    expect(nextHint).not.toContain("SESSION_A_ONLY");
    expect(nextHint).not.toContain("SESSION_B_ONLY");
  });

  it("caps findings and waits only for the tracker-owned child", async () => {
    const tracker: AdaptiveOracleTrackerFields = { adaptiveOracleChildSessionId: "child-1" };
    const runtime = {
      waitBackground: vi.fn(async () => ({
        timedOut: false,
        subagents: [
          { id: "other-child", status: "completed", output: "UNRELATED" },
          { id: "child-1", status: "completed", output: "x".repeat(4000) },
        ],
      })),
    };
    await joinAdaptiveOracleFindings(runtime, "parent-1", tracker);
    expect(runtime.waitBackground).toHaveBeenCalledWith({
      sessionId: "parent-1",
      timeoutMs: ADAPTIVE_ORACLE_WAIT_MS,
      subagentIds: ["child-1"],
    });
    expect(tracker.adaptiveOracleConsulted).toBe(true);
    expect(Buffer.byteLength(tracker.adaptiveOracleDigest ?? "", "utf8")).toBeLessThanOrEqual(
      ORACLE_DIGEST_MAX_BYTES,
    );
    expect(tracker.adaptiveOracleDigest).not.toContain("UNRELATED");
  });

  it.each([
    "running",
    "error",
    "missing",
    "cancelled",
  ])("never treats %s child output as findings", async (status) => {
    const tracker: AdaptiveOracleTrackerFields = { adaptiveOracleChildSessionId: "child-1" };
    await joinAdaptiveOracleFindings(
      {
        waitBackground: async () => ({
          timedOut: false,
          subagents: [{ id: "child-1", status, output: "incomplete advice" }],
        }),
      },
      "parent-1",
      tracker,
    );
    expect(tracker.adaptiveOracleDigest).toBeUndefined();
    expect(tracker.adaptiveOracleWaitReason).toBe(
      status === "running" ? "oracle_wait_timeout" : "oracle_wait_failed",
    );
  });

  it("records timeout without throwing or promoting incomplete output", async () => {
    const tracker: AdaptiveOracleTrackerFields = { adaptiveOracleChildSessionId: "child-2" };
    await joinAdaptiveOracleFindings(
      {
        waitBackground: async () => ({
          timedOut: true,
          subagents: [{ id: "child-2", status: "completed", output: "unconfirmed" }],
        }),
      },
      "parent-1",
      tracker,
    );
    expect(tracker.adaptiveOracleConsulted).toBe(true);
    expect(tracker.adaptiveOracleWaitReason).toBe("oracle_wait_timeout");
    expect(tracker.adaptiveOracleDigest).toBeUndefined();
  });

  it("records failed waits without throwing", async () => {
    const tracker: AdaptiveOracleTrackerFields = { adaptiveOracleChildSessionId: "child-2" };
    await joinAdaptiveOracleFindings(
      {
        waitBackground: async () => {
          throw new Error("fixture wait failed");
        },
      },
      "parent-1",
      tracker,
    );
    expect(tracker.adaptiveOracleWaitReason).toBe("oracle_wait_failed");
    expect(tracker.adaptiveOracleDigest).toBeUndefined();
  });

  it("exposes no prototype installation or shared envelope state", () => {
    expect(bridge).not.toHaveProperty("installAdaptiveOracleBridge");
    expect(bridge).not.toHaveProperty("peekPendingOracleEnvelope");
    expect(bridge).not.toHaveProperty("clearPendingOracleEnvelope");
    expect(bridge).not.toHaveProperty("resetAdaptiveOracleBridgeForTests");
  });
});
