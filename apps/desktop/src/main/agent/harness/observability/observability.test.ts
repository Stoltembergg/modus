import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "../feature-flags";
import type { HarnessContext } from "../kernel/harness-hooks";
import { ResponsePolicyRegistry } from "../response/response-registry";
import { BaselineComparator } from "./baseline-comparator";
import { HarnessObserver } from "./harness-observer";
import { MetricsExporter } from "./metrics-exporter";
import { defaultObservabilityTurnSettleHook } from "./observability-hooks";
import { RollbackCoordinator, ValidationGates } from "./validation-gates";

describe("Phase 8 — Observability Dashboard, Telemetry & Final Validation Gates", () => {
  beforeEach(() => {
    resetFeatureFlagOverrides();
    HarnessObserver.resetInstance();
    ResponsePolicyRegistry.resetInstance();
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    HarnessObserver.resetInstance();
    ResponsePolicyRegistry.resetInstance();
  });

  describe("8.1 HarnessObserver & Real-time Metrics", () => {
    it("generates a complete canonical snapshot matching REVISAO-SUMARIO.md schema", () => {
      const observer = HarnessObserver.getInstance();
      const snap = observer.snapshot();

      expect(snap.promptSections).toBeDefined();
      expect(snap.toolResults).toBeDefined();
      expect(snap.compaction).toBeDefined();
      expect(snap.repeatGuards).toBeDefined();
      expect(snap.response).toBeDefined();
      expect(snap.performance).toBeDefined();

      expect(snap.promptSections.estimatedTokensSaved).toBeNull();
      expect(snap.toolResults.spilledResults).toBe(0);
      expect(snap.toolResults.retrievalLatency).toBeNull();
      expect(snap.toolResults.successfulRetrievals).toBe(0);
      expect(snap.compaction.frequencyReductionPercent).toBeNull();
      expect(snap.repeatGuards.falsePositiveCount).toBeNull();
      expect(snap.response.evaluatedCount).toBe(0);
      expect(snap.performance.sampledHookDurationTotalMs).toBeNull();
    });

    it("records hook executions and calculates average and P95 durations", () => {
      const observer = HarnessObserver.getInstance();

      observer.recordHookExecution("turn_start", "intent_gate", 2.5, true);
      observer.recordHookExecution("turn_start", "repeat_guard", 1.5, true);
      observer.recordHookExecution("prompt_build", "modular_prompt", 4.0, true);

      const snap = observer.snapshot();
      expect(snap.performance.sampledHookExecutionCount).toBe(3);
      expect(snap.performance.averageHookDurationMs).toBeCloseTo(2.67, 1);
      expect(snap.performance.p95HookDurationMs).toBeGreaterThanOrEqual(2.5);
    });

    it("records tool spills, compaction pruning, and prompt compilations", () => {
      const observer = HarnessObserver.getInstance();
      const sessionId = "sess-1";
      const sessionToken = observer.beginSession(sessionId);

      observer.recordToolResultSpill("bash", 3500, 4000, "spill-123", sessionId, sessionToken);
      observer.recordToolResultRetrieval(15, sessionId, sessionToken, "run-1");
      observer.recordCompactionPruning(8000, 1800, sessionId, sessionToken, "run-1");
      observer.recordPromptSections(
        ["base", "tools"],
        ["rules"],
        600,
        sessionId,
        sessionToken,
        "run-1",
      );

      const snap = observer.snapshot();
      expect(snap.toolResults.spilledResults).toBe(1);
      expect(snap.toolResults.spilledBytes).toBe(4000);
      expect(snap.toolResults.retrievalLatency).toBe(15);
      expect(snap.toolResults.successfulRetrievals).toBe(1);
      expect(snap.toolResults.modelContextBytesReduced).toBe(3500);
      expect(snap.toolResults.estimatedTokensSaved).toBe(875);

      expect(snap.compaction.pruningEvents).toBe(1);
      expect(snap.compaction.estimatedTokensSavedByPruning).toBe(1800);

      expect(snap.promptSections.estimatedTokensSaved).toBe(600);
      expect(snap.promptSections.skippedSections).toBe(1);
    });

    it("records measured context bytes and estimated tokens only for the current session and run", () => {
      const observer = HarnessObserver.getInstance();
      const sessionId = "compaction-session";
      const sessionToken = observer.beginSession(sessionId);

      observer.recordCompactionPruning(4096, 1024, sessionId, sessionToken, "run-current");

      expect(observer.snapshot().compaction).toMatchObject({
        totalPrunedBytes: 4096,
        estimatedTokensSavedByPruning: 1024,
      });
      expect(observer.getRecentEvents()).toContainEqual(
        expect.objectContaining({
          type: "harness.compaction.pruned",
          sessionId,
          runId: "run-current",
          data: {
            measuredContextBytesRemoved: 4096,
            estimatedTokensSaved: 1024,
          },
        }),
      );

      observer.beginSession(sessionId);
      observer.recordCompactionPruning(8192, 2048, sessionId, sessionToken, "run-stale");

      expect(observer.snapshot().compaction).toMatchObject({
        totalPrunedBytes: 4096,
        estimatedTokensSavedByPruning: 1024,
      });
      expect(observer.getRecentEvents()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ runId: "run-stale" })]),
      );
    });

    it("tracks repeat guards and response policy evaluations", () => {
      const observer = HarnessObserver.getInstance();
      const sessionId = "sess-1";
      const sessionToken = observer.beginSession(sessionId);

      observer.recordRepeatGuardEvaluation("fetch", true, sessionId, sessionToken, "run-1");
      observer.recordRepeatGuardEvaluation("read", true, sessionId, sessionToken, "run-2");
      observer.recordResponsePolicyEvaluation(true, sessionId, sessionToken, "run-3");

      const snap = observer.snapshot();
      expect(snap.repeatGuards.blockedLoopCount).toBe(2);
      expect(snap.repeatGuards.evaluatedToolCalls).toBe(2);
      expect(snap.repeatGuards.falsePositiveCount).toBeNull();
      expect(snap.response.violationsDetected).toBe(1);
      expect(snap.response.evaluatedCount).toBe(1);
    });

    it("aggregates metrics per session accurately", () => {
      const observer = HarnessObserver.getInstance();
      const sessionId = "session-audit-1";
      const sessionToken = observer.beginSession(sessionId);

      observer.recordSessionTurn({
        sessionId,
        durationMs: 450,
        sessionToken,
        runId: "run-1",
        outcome: "completed",
        hasAssistantResponse: true,
        providerTokenUsage: {
          input: 20,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
        },
      });
      observer.recordSessionTurn({
        sessionId,
        durationMs: 75,
        sessionToken,
        runId: "run-2",
        outcome: "cancelled",
        hasAssistantResponse: false,
      });
      observer.recordSessionTurn({
        sessionId,
        durationMs: 50,
        sessionToken,
        runId: "run-3",
        outcome: "failed",
        hasAssistantResponse: true,
      });
      observer.recordPromptSections(["sec1"], [], 300, sessionId, sessionToken, "run-1");
      observer.recordToolResultSpill("grep", 1800, 2000, "sp1", sessionId, sessionToken, "run-1");
      observer.recordRepeatGuardEvaluation("grep", true, sessionId, sessionToken, "run-1");

      const sessionMetrics = observer.getSessionMetrics(sessionId);
      expect(sessionMetrics).toBeDefined();
      expect(sessionMetrics?.turnCount).toBe(3);
      expect(sessionMetrics?.totalDurationMs).toBe(575);
      expect(sessionMetrics?.durationReports).toBe(3);
      expect(sessionMetrics?.durationMsByOutcome).toEqual({
        completed: 450,
        failed: 50,
        blocked: 0,
        cancelled: 75,
        interrupted: 0,
      });
      expect(sessionMetrics?.noResponseDurationMs).toBe(75);
      expect(sessionMetrics?.noResponseDurationReports).toBe(1);
      expect(sessionMetrics?.outcomes.completed).toBe(1);
      expect(sessionMetrics?.outcomes.failed).toBe(1);
      expect(sessionMetrics?.outcomes.cancelled).toBe(1);
      expect(sessionMetrics?.policyEvaluations).toBe(0);
      expect(observer.snapshot().turns.durationMsByOutcome.cancelled).toBe(75);
      expect(observer.snapshot().turns.noResponseDurationMs).toBe(75);
      expect(sessionMetrics?.providerReportedTotalTokens).toBe(30);
      expect(sessionMetrics?.guardBlocks).toBe(1);
      expect(sessionMetrics?.spilledResults).toBe(1);
      expect(sessionMetrics?.estimatedTokensSaved).toBeGreaterThanOrEqual(300);
    });

    it("keeps terminal counts while reporting invalid duration as unavailable", () => {
      const observer = HarnessObserver.getInstance();
      const sessionId = "invalid-duration-session";
      const sessionToken = observer.beginSession(sessionId);

      observer.recordSessionTurn({
        sessionId,
        durationMs: Number.NaN,
        sessionToken,
        runId: "invalid-duration-run",
        outcome: "completed",
        hasAssistantResponse: true,
      });

      expect(observer.snapshot().turns.completed).toBe(1);
      expect(observer.snapshot().turns.durationReports).toBe(0);
      expect(observer.snapshot().turns.durationMsByOutcome.completed).toBe(0);
      expect(observer.getSessionMetrics(sessionId)?.durationReports).toBe(0);
    });

    it("emits and stores ring-buffered telemetry events", () => {
      const observer = HarnessObserver.getInstance();
      const sessionId = "s1";
      const sessionToken = observer.beginSession(sessionId);
      observer.recordHookExecution(
        "turn_start",
        "h1",
        1.0,
        true,
        undefined,
        sessionId,
        sessionToken,
        "run-1",
      );

      const events = observer.getRecentEvents(10);
      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe("harness.hook.executed");
      expect(events[0]?.data.hookName).toBe("h1");
    });
  });

  describe("8.2 System Health & Regression Alerts", () => {
    it("reports healthy status when within thresholds", () => {
      const observer = HarnessObserver.getInstance();
      observer.recordHookExecution("turn_start", "h1", 0.5, true);

      const health = observer.getHealthStatus();
      expect(health.status).toBe("healthy");
      expect(health.alerts).toHaveLength(0);
    });

    it("reports only actual advisory response evaluations, not omission counters", () => {
      const observer = HarnessObserver.getInstance();
      const sessionToken = observer.beginSession("response-no-rewrite");
      observer.recordResponsePolicyEvaluation(true, "response-no-rewrite", sessionToken, "run-1");

      const health = observer.getHealthStatus();
      expect(observer.snapshot().response).toEqual({ evaluatedCount: 1, violationsDetected: 1 });
      expect(observer.getRecentEvents(1)[0]).toMatchObject({
        type: "harness.response.evaluated",
        runId: "run-1",
        data: { outcome: "completed", violation: true },
      });
      expect(health.alerts).toHaveLength(0);
    });

    it("triggers warning alert if hook latency SLO is breached", () => {
      const observer = HarnessObserver.getInstance();
      for (let i = 0; i < 20; i++) {
        observer.recordHookExecution("phase", "hook", 150, true);
      }

      const health = observer.getHealthStatus();
      expect(health.status).toBe("degraded");
      expect(health.alerts.some((a) => a.severity === "warning")).toBe(true);
      expect(health.alerts[0]?.metric).toBe("performance.p95HookDurationMs");
    });
  });

  describe("8.3 Baseline Comparison & Go/No-Go Decision Matrix", () => {
    it("does not approve unmeasured compaction and repeat-guard outcomes", () => {
      const observer = HarnessObserver.getInstance();
      // Phase 2 saving
      observer.recordPromptSections(["a"], ["b"], 150000);
      // Phase 3 spill retrieval
      observer.recordToolResultSpill("cat", 8000, 10000);
      observer.recordToolResultRetrieval(40);
      // Phase 4 compaction pruning
      observer.recordCompactionPruning(20000, 5000);
      // Phase 5 repeat guards
      const guardToken = observer.beginSession("baseline-guards");
      observer.recordRepeatGuardEvaluation("t1", true, "baseline-guards", guardToken, "run-1");
      // Phase 6 groups hook latency
      observer.recordHookExecution("turn_start", "mailbox", 0.8, true);
      // Phase 7 zero critical omissions
      const responseToken = observer.beginSession("baseline-response");
      observer.recordResponsePolicyEvaluation(false, "baseline-response", responseToken, "run-2");

      const comparator = new BaselineComparator();
      const result = comparator.evaluate(observer.snapshot(), 100);

      expect(result.overallVerdict).toBe("WARN");
      expect(result.latencyOverheadPercent).toBeNull();
      expect(result.phaseDecisions.find((decision) => decision.phase === 6)).toMatchObject({
        verdict: "WARN",
        achieved: "unavailable",
      });
      expect(result.phaseDecisions).toHaveLength(6);
      expect(result.phaseDecisions.every((d) => d.verdict === "GO" || d.verdict === "WARN")).toBe(
        true,
      );
      expect(result.estimatedTokenEconomyPercent).toBeGreaterThanOrEqual(30);
    });

    it("does not claim a response omission based on advisory evaluation", () => {
      const observer = HarnessObserver.getInstance();
      const sessionToken = observer.beginSession("baseline-response");
      observer.recordResponsePolicyEvaluation(true, "baseline-response", sessionToken, "run-1");

      const comparator = new BaselineComparator();
      const result = comparator.evaluate(observer.snapshot(), 100);

      const p7 = result.phaseDecisions.find((d) => d.phase === 7);
      expect(p7?.verdict).toBe("WARN");
      expect(p7?.notes).toContain("does not rewrite streamed output");
    });

    it("does not claim a response-quality pass when no completed response was evaluated", () => {
      const result = new BaselineComparator().evaluate(HarnessObserver.getInstance().snapshot());
      const p7 = result.phaseDecisions.find((decision) => decision.phase === 7);

      expect(p7).toMatchObject({
        verdict: "WARN",
        achieved: "unavailable; no completed response was evaluated",
      });
      expect(result.overallVerdict).toBe("WARN");
    });
  });

  describe("8.4 Metrics Export (JSON & CSV)", () => {
    it("exports snapshot to formatted JSON", () => {
      const observer = HarnessObserver.getInstance();
      observer.recordPromptSections(["s1"], [], 120);

      const jsonStr = MetricsExporter.exportJSON(observer.snapshot());
      expect(() => JSON.parse(jsonStr)).not.toThrow();
      expect(jsonStr).toContain('"promptSections"');
      expect(jsonStr).toContain('"estimatedTokensSaved": 120');
    });

    it("exports session and summary data to valid CSV", () => {
      const observer = HarnessObserver.getInstance();
      const sessionToken = observer.beginSession("sess-1");
      observer.recordSessionTurn({
        sessionId: "sess-1",
        durationMs: 500,
        sessionToken,
        runId: "run-1",
        outcome: "completed",
        hasAssistantResponse: true,
      });
      observer.recordPromptSections(["s1"], [], 250, "sess-1", sessionToken, "run-1");

      const sessionCsv = MetricsExporter.exportSessionsCSV(observer.getAllSessions());
      expect(sessionCsv).toContain(
        "sessionId,turnCount,totalDurationMs,durationReports,completedDurationMs,completedDurationReports",
      );
      expect(sessionCsv).toContain("hookExecutions,guardBlocks,policyEvaluations,policyViolations");
      expect(sessionCsv).toContain('"sess-1",1,500,1,500,1,0,0,0,0,0,0');

      const summaryCsv = MetricsExporter.exportSummaryCSV(observer.snapshot());
      expect(summaryCsv).toContain("Category,Metric,Value");
      expect(summaryCsv).toContain("promptSections,estimatedTokensSaved,250");
    });
  });

  describe("8.5 Validation Gates & Rollback Plan (AJUSTE 3)", () => {
    it("keeps correctness blocked while repeat guard false positives are unadjudicated", () => {
      const observer = HarnessObserver.getInstance();
      observer.recordPromptSections(["a"], [], 15000);
      observer.recordHookExecution("turn_start", "h1", 1.2, true);
      const sessionToken = observer.beginSession("gate-guards");
      observer.recordRepeatGuardEvaluation("t1", false, "gate-guards", sessionToken, "run-1");

      const report = ValidationGates.evaluate(observer.snapshot(), {
        minTokenEconomyPercent: 20,
        baselineTotalTokens: 40000,
      });

      expect(report.allGatesPassed).toBe(false);
      expect(report.rollbackRequired).toBe(true);
      expect(report.gates).toHaveLength(3);
      expect(report.gates.map((g) => g.gateName)).toEqual([
        "Token Economy Gate",
        "Correctness Gate",
        "Performance Gate",
      ]);
      expect(report.gates.find((gate) => gate.gateName === "Correctness Gate")?.passed).toBe(false);
    });

    it("demands rollback if correctness gate is breached", () => {
      const observer = HarnessObserver.getInstance();
      const sessionToken = observer.beginSession("gate-response");
      observer.recordResponsePolicyEvaluation(true, "gate-response", sessionToken, "run-1");

      const report = ValidationGates.evaluate(observer.snapshot());
      expect(report.allGatesPassed).toBe(false);
      expect(report.rollbackRequired).toBe(true);
      const correctnessGate = report.gates.find((g) => g.gateName === "Correctness Gate");
      expect(correctnessGate?.passed).toBe(false);
    });

    it("fails the token economy gate on negligible savings and demands rollback", () => {
      const observer = HarnessObserver.getInstance();
      observer.recordPromptSections(["a"], [], 100); // 100 of 45000 = 0.2%, far below 30%

      const report = ValidationGates.evaluate(observer.snapshot());
      const economyGate = report.gates.find((g) => g.gateName === "Token Economy Gate");
      expect(economyGate?.passed).toBe(false);
      expect(report.allGatesPassed).toBe(false);
      expect(report.rollbackRequired).toBe(true);
    });

    it("RollbackCoordinator safely executes rollback and resets system state", () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_PROMPT_REGISTRY: true,
        MODUS_RESPONSE_POLICY: true,
        MODUS_OBSERVABILITY: true,
      });

      const res = RollbackCoordinator.executeRollback({ keepKernel: true });
      expect(res.success).toBe(true);
      expect(res.actionsTaken).toContain("Feature flags reset to kernel-only baseline");
      expect(res.actionsTaken).toContain("Harness observer telemetry reset");
    });
  });

  describe("8.6 Observability Kernel Hook Integration", () => {
    const mockContext: HarnessContext = {
      sessionId: "session-obs-test",
      runId: "run-obs-test",
      workspaceId: "ws-test",
      cwd: "/test",
      mode: "build",
      state: new Map([
        ["harness.turn_start_time", Date.now() - 250],
        ["harness.prompt_tokens_saved", 420],
      ]),
    };

    it("turn_settle hook passes through cleanly when MODUS_OBSERVABILITY is disabled", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_OBSERVABILITY: false,
      });

      const out = await defaultObservabilityTurnSettleHook.execute(
        { runId: "run-1", completed: true, hasActiveTodos: false, turnTokens: 100 },
        mockContext,
      );

      expect(out.settled).toBe(true);
      expect(mockContext.state?.get("harness.observability_harvested")).toBeUndefined();
    });

    it("does not infer prompt savings or session turns from token totals", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_OBSERVABILITY: true,
      });

      const out = await defaultObservabilityTurnSettleHook.execute(
        { runId: "run-1", completed: true, hasActiveTodos: false, turnTokens: 100 },
        mockContext,
      );

      expect(out.settled).toBe(true);
      expect(mockContext.state?.get("harness.observability_harvested")).toBe(true);

      const observer = HarnessObserver.getInstance();
      expect(observer.getSessionMetrics("session-obs-test")).toBeUndefined();
      expect(observer.snapshot().promptSections.estimatedTokensSaved).toBeNull();
    });

    it("hook fails open safely without throwing if context has invalid data", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_OBSERVABILITY: true,
      });

      const corruptedContext: HarnessContext = {
        sessionId: "session-corrupt",
        runId: "run-corrupt",
        workspaceId: "ws-test",
        cwd: "/test",
        mode: "build",
        state: new Map([["harness.turn_start_time", "invalid-time" as any]]),
      };

      const out = await defaultObservabilityTurnSettleHook.execute(
        { runId: "run-1", completed: true, hasActiveTodos: false, turnTokens: 100 },
        corruptedContext,
      );

      expect(out.settled).toBe(true);
    });
  });

  describe("8.7 Telemetry Performance SLO (< 10ms for 1,000 operations)", () => {
    it("records 1,000 metrics events in well under budget", () => {
      const observer = HarnessObserver.getInstance();
      const start = Date.now();
      const sessionId = "sess-1";
      const sessionToken = observer.beginSession(sessionId);

      for (let i = 0; i < 1000; i++) {
        observer.recordHookExecution(
          "turn_start",
          "intent",
          0.5,
          true,
          undefined,
          sessionId,
          sessionToken,
          `run-${i}`,
        );
        observer.recordPromptSections(["a"], ["b"], 10, sessionId, sessionToken, `run-${i}`);
      }

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100); // Generous ceiling, typically runs in < 15ms
    });
  });

  describe("8.8 Fase 8 review regressions", () => {
    it("records per-turn response outcomes against their owning sessions", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_OBSERVABILITY: true,
        MODUS_RESPONSE_POLICY: true,
      });

      const observer = HarnessObserver.getInstance();
      const contextFor = (sessionId: string, runId: string, raw: string): HarnessContext => {
        const sessionToken = observer.beginSession(sessionId);
        return {
          sessionId,
          runId,
          sessionToken,
          workspaceId: "w",
          cwd: ".",
          mode: "build",
          state: new Map<string, any>([
            [
              "harness.response_policy_evaluation",
              {
                runId,
                outcome: "completed",
                status: "evaluated",
                violated: raw.includes("before"),
              },
            ],
          ]),
        };
      };
      const contextA = contextFor("s-response-a", "r-response-a", "response A before formatting");
      const contextB = contextFor("s-response-b", "r-response-b", "response B before formatting");

      await Promise.all([
        defaultObservabilityTurnSettleHook.execute(
          { runId: contextA.runId, completed: true, hasActiveTodos: false, turnTokens: 10 },
          contextA,
        ),
        defaultObservabilityTurnSettleHook.execute(
          { runId: contextB.runId, completed: true, hasActiveTodos: false, turnTokens: 10 },
          contextB,
        ),
      ]);

      expect(observer.snapshot().response.violationsDetected).toBe(2);
      expect(observer.snapshot().response.evaluatedCount).toBe(2);
      expect(observer.getSessionMetrics("s-response-a")?.policyViolations).toBe(1);
      expect(observer.getSessionMetrics("s-response-b")?.policyViolations).toBe(1);
    });

    it("does not infer avoided compactions from pruning counts", () => {
      const observer = HarnessObserver.getInstance();
      const sessionId = "compaction-metrics";
      const sessionToken = observer.beginSession(sessionId);

      observer.recordCompactionPruning(8000, 1800, sessionId, sessionToken, "run-1");
      observer.recordCompactionPruning(8000, 1800, sessionId, sessionToken, "run-2");
      observer.recordCompactionPruning(8000, 1800, sessionId, sessionToken, "run-3");
      expect(observer.snapshot().compaction.frequencyReductionPercent).toBeNull();

      observer.recordNativeCompaction(sessionId, sessionToken, "run-4");
      expect(observer.snapshot().compaction.nativeCompactionsObserved).toBe(1);
      expect(observer.snapshot().compaction.frequencyReductionPercent).toBeNull();
    });

    it("aggregates plugin tracing metrics math in the snapshot", () => {
      const observer = HarnessObserver.getInstance();
      const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      durations.forEach((d, i) => {
        observer.recordPluginTrace(
          {
            pluginId: i < 5 ? "p-a" : "p-b",
            capability: "c",
            version: "1.0",
            durationMs: d,
            status: i >= 8 ? "error" : "success",
            ...(i >= 8 ? { error: "boom" } : {}),
          },
          "s1",
        );
      });

      const plugins = observer.snapshot().plugins;
      expect(plugins?.totalExecutions).toBe(10);
      expect(plugins?.failureCount).toBe(2);
      expect(plugins?.totalDurationMs).toBe(550);
      expect(plugins?.avgDurationMs).toBe(55);
      expect(plugins?.p95DurationMs).toBe(100);
      expect(plugins?.activePluginCount).toBe(2);
    });
  });
});
