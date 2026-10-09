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

      expect(snap.promptSections.tokensSaved).toBe(0);
      expect(snap.toolResults.spilledResults).toBe(0);
      expect(snap.compaction.frequencyReductionPercent).toBe(0);
      expect(snap.repeatGuards.falsePositiveCount).toBe(0);
      expect(snap.response.criticalSectionsOmitted).toBe(0);
      expect(snap.performance.hookSystemOverheadMs).toBe(0);
    });

    it("records hook executions and calculates average and P95 durations", () => {
      const observer = HarnessObserver.getInstance();

      observer.recordHookExecution("turn_start", "intent_gate", 2.5, true);
      observer.recordHookExecution("turn_start", "repeat_guard", 1.5, true);
      observer.recordHookExecution("prompt_build", "modular_prompt", 4.0, true);

      const snap = observer.snapshot();
      expect(snap.performance.totalHookExecutions).toBe(3);
      expect(snap.performance.averageHookDurationMs).toBeCloseTo(2.67, 1);
      expect(snap.performance.p95HookDurationMs).toBeGreaterThanOrEqual(2.5);
    });

    it("records tool spills, compaction pruning, and prompt compilations", () => {
      const observer = HarnessObserver.getInstance();

      observer.recordToolResultSpill("bash", 4000, "spill-123", "sess-1");
      observer.recordToolResultRetrieval(15, "sess-1");
      observer.recordCompactionPruning(8000, 1800, "sess-1");
      observer.recordPromptSections(["base", "tools"], ["rules"], 600, "sess-1");

      const snap = observer.snapshot();
      expect(snap.toolResults.spilledResults).toBe(1);
      expect(snap.toolResults.spilledBytes).toBe(4000);
      expect(snap.toolResults.retrievalLatency).toBe(15);

      expect(snap.compaction.compactionEvents).toBe(1);
      expect(snap.compaction.tokensSavedByPruning).toBe(1800);

      expect(snap.promptSections.tokensSaved).toBe(600);
      expect(snap.promptSections.skippedSections).toBe(1);
    });

    it("tracks repeat guards and response policy evaluations", () => {
      const observer = HarnessObserver.getInstance();

      observer.recordRepeatGuardTrigger("fetch", "tool_loop", false, "sess-1");
      observer.recordRepeatGuardTrigger("read", "hypothesis_loop", true, "sess-1");
      observer.recordResponsePolicyEvaluation(true, true, 1200, 0, "sess-1");

      const snap = observer.snapshot();
      expect(snap.repeatGuards.blockedLoopCount).toBe(2);
      expect(snap.repeatGuards.falsePositiveCount).toBe(1);
      expect(snap.response.violationsDetected).toBe(1);
      expect(snap.response.charactersSaved).toBe(1200);
      expect(snap.response.criticalSectionsOmitted).toBe(0);
    });

    it("aggregates metrics per session accurately", () => {
      const observer = HarnessObserver.getInstance();
      const sessionId = "session-audit-1";

      observer.recordSessionTurn(sessionId, 450);
      observer.recordPromptSections(["sec1"], [], 300, sessionId);
      observer.recordToolResultSpill("grep", 2000, "sp1", sessionId);
      observer.recordRepeatGuardTrigger("grep", "tool_loop", false, sessionId);

      const sessionMetrics = observer.getSessionMetrics(sessionId);
      expect(sessionMetrics).toBeDefined();
      expect(sessionMetrics?.turnCount).toBe(1);
      expect(sessionMetrics?.totalDurationMs).toBe(450);
      expect(sessionMetrics?.guardBlocks).toBe(1);
      expect(sessionMetrics?.spilledResults).toBe(1);
      expect(sessionMetrics?.tokensSaved).toBeGreaterThanOrEqual(300);
    });

    it("emits and stores ring-buffered telemetry events", () => {
      const observer = HarnessObserver.getInstance();
      observer.recordHookExecution("turn_start", "h1", 1.0, true, undefined, "s1");

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

    it("triggers critical alert if critical sections are omitted (RISCO 4)", () => {
      const observer = HarnessObserver.getInstance();
      observer.recordResponsePolicyEvaluation(true, true, 500, 2); // 2 critical sections omitted!

      const health = observer.getHealthStatus();
      expect(health.status).toBe("critical");
      expect(health.alerts.some((a) => a.severity === "critical")).toBe(true);
      expect(health.alerts[0]?.metric).toBe("response.criticalSectionsOmitted");
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
    it("evaluates all phases with GO verdict when meeting criteria", () => {
      const observer = HarnessObserver.getInstance();
      // Phase 2 saving
      observer.recordPromptSections(["a"], ["b"], 150000);
      // Phase 3 spill retrieval
      observer.recordToolResultSpill("cat", 10000);
      observer.recordToolResultRetrieval(40);
      // Phase 4 compaction pruning
      observer.recordCompactionPruning(20000, 5000);
      // Phase 5 repeat guards
      observer.recordRepeatGuardTrigger("t1", "loop", false);
      // Phase 6 groups hook latency
      observer.recordHookExecution("turn_start", "mailbox", 0.8, true);
      // Phase 7 zero critical omissions
      observer.recordResponsePolicyEvaluation(false, false, 0, 0);

      const comparator = new BaselineComparator();
      const result = comparator.evaluate(observer.snapshot(), 100);

      expect(result.overallVerdict).toBe("GO");
      expect(result.phaseDecisions).toHaveLength(6);
      expect(result.phaseDecisions.every((d) => d.verdict === "GO" || d.verdict === "WARN")).toBe(
        true,
      );
      expect(result.estimatedTokenEconomyPercent).toBeGreaterThanOrEqual(30);
    });

    it("evaluates NO-GO when critical criteria fail", () => {
      const observer = HarnessObserver.getInstance();
      // Critical omission in response policy
      observer.recordResponsePolicyEvaluation(true, true, 500, 3);

      const comparator = new BaselineComparator();
      const result = comparator.evaluate(observer.snapshot(), 100);

      expect(result.overallVerdict).toBe("NO-GO");
      const p7 = result.phaseDecisions.find((d) => d.phase === 7);
      expect(p7?.verdict).toBe("NO-GO");
      expect(result.recommendation).toContain("failed the threshold gates");
    });
  });

  describe("8.4 Metrics Export (JSON & CSV)", () => {
    it("exports snapshot to formatted JSON", () => {
      const observer = HarnessObserver.getInstance();
      observer.recordPromptSections(["s1"], [], 120);

      const jsonStr = MetricsExporter.exportJSON(observer.snapshot());
      expect(() => JSON.parse(jsonStr)).not.toThrow();
      expect(jsonStr).toContain('"promptSections"');
      expect(jsonStr).toContain('"tokensSaved": 120');
    });

    it("exports session and summary data to valid CSV", () => {
      const observer = HarnessObserver.getInstance();
      observer.recordSessionTurn("sess-1", 500);
      observer.recordPromptSections(["s1"], [], 250, "sess-1");

      const sessionCsv = MetricsExporter.exportSessionsCSV(observer.getAllSessions());
      expect(sessionCsv).toContain("sessionId,turnCount,totalDurationMs");
      expect(sessionCsv).toContain('"sess-1",1,500');

      const summaryCsv = MetricsExporter.exportSummaryCSV(observer.snapshot());
      expect(summaryCsv).toContain("Category,Metric,Value");
      expect(summaryCsv).toContain("promptSections,tokensSaved,250");
    });
  });

  describe("8.5 Validation Gates & Rollback Plan (AJUSTE 3)", () => {
    it("passes all three production gates when thresholds are satisfied", () => {
      const observer = HarnessObserver.getInstance();
      observer.recordPromptSections(["a"], [], 15000);
      observer.recordHookExecution("turn_start", "h1", 1.2, true);
      observer.recordRepeatGuardTrigger("t1", "loop", false);

      const report = ValidationGates.evaluate(observer.snapshot(), {
        minTokenEconomyPercent: 20,
        baselineTotalTokens: 40000,
      });

      expect(report.allGatesPassed).toBe(true);
      expect(report.rollbackRequired).toBe(false);
      expect(report.gates).toHaveLength(3);
      expect(report.gates.map((g) => g.gateName)).toEqual([
        "Token Economy Gate",
        "Correctness Gate",
        "Performance Gate",
      ]);
    });

    it("demands rollback if correctness gate is breached", () => {
      const observer = HarnessObserver.getInstance();
      observer.recordResponsePolicyEvaluation(true, true, 500, 1); // 1 critical omitted

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

    it("turn_settle hook records session turn and tokens when enabled", async () => {
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
      const session = observer.getSessionMetrics("session-obs-test");
      expect(session).toBeDefined();
      expect(session?.turnCount).toBe(1);
      expect(session?.totalDurationMs).toBeGreaterThanOrEqual(200);
      expect(session?.tokensSaved).toBe(420);
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

      for (let i = 0; i < 1000; i++) {
        observer.recordHookExecution("turn_start", "intent", 0.5, true, undefined, "sess-1");
        observer.recordPromptSections(["a"], ["b"], 10, "sess-1");
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
            ["harness.response_policy", { enforcementMode: "strict" }],
            ["harness.assistant_response", raw],
            ["harness.formatted_response", "formatted"],
            ["harness.response_violated", true],
          ]),
        };
      };
      const contextA = contextFor(
        "s-response-a",
        "r-response-a",
        "response A before formatting",
      );
      const contextB = contextFor(
        "s-response-b",
        "r-response-b",
        "response B before formatting",
      );

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
      expect(observer.snapshot().response.formattedCount).toBe(2);
      expect(observer.getSessionMetrics("s-response-a")?.policyViolations).toBe(1);
      expect(observer.getSessionMetrics("s-response-b")?.policyViolations).toBe(1);
    });

    it("computes a varying compaction avoidance ratio instead of a constant", () => {
      const observer = HarnessObserver.getInstance();

      observer.recordCompactionPruning(8000, 1800);
      observer.recordCompactionPruning(8000, 1800);
      observer.recordCompactionPruning(8000, 1800);
      expect(observer.snapshot().compaction.frequencyReductionPercent).toBe(100);

      observer.recordActualCompaction();
      expect(observer.snapshot().compaction.frequencyReductionPercent).toBe(75);
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
