import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdaptiveFailureAttempt } from "../../../../shared/contracts";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "../feature-flags";
import type { HarnessContext } from "../kernel/harness-hooks";
import { decideNext } from "../meta-controller";
import { CircuitBreakerRegistry, detectFailureLoop } from "./failure-loop-guard";
import {
  getRepeatGuardConfig,
  resetRepeatGuardConfig,
  setRepeatGuardConfig,
} from "./repeat-guard-config";
import {
  defaultTurnStartRepeatGuardHook,
  defaultVerificationRepeatGuardHook,
} from "./repeat-guard-hook";
import { detectRepeatHypothesis } from "./repeat-hypothesis-guard";
import {
  detectRepeatTools,
  detectUnproductiveToolRepeat,
  fingerprintToolArgs,
  type ToolInvocation,
  ToolInvocationTracker,
} from "./repeat-tool-guard";

function makeAttempt(overrides: Partial<AdaptiveFailureAttempt> = {}): AdaptiveFailureAttempt {
  return {
    id: "att-1",
    sessionId: "s1",
    runId: "r1",
    strategyCode: "strategy_a",
    status: "failed",
    reasonCode: "test_fail",
    evidenceEventIds: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Phase 5: Repeat Guards & Circuit Breakers", () => {
  beforeEach(() => {
    resetFeatureFlagOverrides();
    resetRepeatGuardConfig();
    ToolInvocationTracker.getInstance().clearAll();
    CircuitBreakerRegistry.getInstance().clearAll();
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    resetRepeatGuardConfig();
    ToolInvocationTracker.getInstance().clearAll();
    CircuitBreakerRegistry.getInstance().clearAll();
  });

  describe("5.1 Configuration & Calibration", () => {
    it("provides calibrated defaults matching specification", () => {
      const config = getRepeatGuardConfig();
      expect(config.toolRepeatWindowMs).toBe(300_000);
      expect(config.toolRepeatThreshold).toBe(3);
      expect(config.hypothesisRepeatRatio).toBe(0.5);
      expect(config.maxFailureAttempts).toBe(5);
      // Whitelist must match FASE-5-AVALIACAO.md (8 read-only tools).
      expect(config.whitelistedTools).toEqual(
        expect.arrayContaining([
          "view_file",
          "client_view_file",
          "retrieve_spilled_tool_result",
          "search_files",
          "grep_search",
          "list_dir",
          "find_by_name",
          "read_url_content",
        ]),
      );
      expect(config.whitelistedTools).toHaveLength(8);
    });

    it("allows overrides and resets cleanly", () => {
      setRepeatGuardConfig({ toolRepeatThreshold: 2 });
      expect(getRepeatGuardConfig().toolRepeatThreshold).toBe(2);

      resetRepeatGuardConfig();
      expect(getRepeatGuardConfig().toolRepeatThreshold).toBe(3);
    });
  });

  describe("5.2 Repeat Tool Guard", () => {
    it("generates stable deterministic argument fingerprints", () => {
      const fp1 = fingerprintToolArgs({ path: "/foo/bar", mode: "read" });
      const fp2 = fingerprintToolArgs({ mode: "read", path: "/foo/bar" });
      expect(fp1).toBe(fp2);

      const fp3 = fingerprintToolArgs({ path: "/foo/baz" });
      expect(fp1).not.toBe(fp3);
      expect(fingerprintToolArgs(null)).toBe("empty");
    });

    it("includes nested argument changes in the stable fingerprint", () => {
      const first = fingerprintToolArgs({ target: "same", options: { mode: "quick" } });
      const second = fingerprintToolArgs({ target: "same", options: { mode: "thorough" } });

      expect(first).not.toBe(second);
    });

    it("detects repeating tool calls with identical arguments within sliding window", () => {
      const now = 1000_000;
      const fp = fingerprintToolArgs({ command: "cargo build" });
      const invocations: ToolInvocation[] = [
        { toolName: "terminal_run", argsFingerprint: fp, timestamp: now - 10_000 },
        { toolName: "terminal_run", argsFingerprint: fp, timestamp: now - 5_000 },
        { toolName: "terminal_run", argsFingerprint: fp, timestamp: now },
      ];

      const patterns = detectRepeatTools(invocations, undefined, now);
      expect(patterns).toHaveLength(1);
      const pattern = patterns[0]!;
      expect(pattern.toolName).toBe("terminal_run");
      expect(pattern.count).toBe(3);
      expect(pattern.identical).toBe(true);
    });

    it("only blocks an identical call streak when its results or task state stop progressing", () => {
      const now = 1_000_000;
      const args = { path: "src/example.ts" };
      const argsFingerprint = fingerprintToolArgs(args);
      const invocations: ToolInvocation[] = Array.from({ length: 3 }, (_, index) => ({
        toolName: "edit_file",
        argsFingerprint,
        timestamp: now - (2 - index) * 1000,
        outcome: "failed",
        resultFingerprint: `failure-${index}`,
        progressFingerprint: "same-task-state",
      }));

      expect(
        detectUnproductiveToolRepeat(invocations, "edit_file", args, undefined, now),
      ).toMatchObject({ count: 3, identical: true });
      expect(
        detectUnproductiveToolRepeat(
          invocations.map((invocation, index) => ({
            ...invocation,
            progressFingerprint: `task-progress-${index}`,
          })),
          "edit_file",
          args,
          undefined,
          now,
        ),
      ).toBeUndefined();
    });

    it("ignores invocations outside the sliding time window", () => {
      const now = 1000_000;
      const fp = fingerprintToolArgs({ command: "cargo build" });
      const invocations: ToolInvocation[] = [
        { toolName: "terminal_run", argsFingerprint: fp, timestamp: now - 400_000 }, // outside 300s window
        { toolName: "terminal_run", argsFingerprint: fp, timestamp: now - 350_000 },
        { toolName: "terminal_run", argsFingerprint: fp, timestamp: now },
      ];

      const patterns = detectRepeatTools(invocations, undefined, now);
      expect(patterns).toHaveLength(0);
    });

    it("exempts whitelisted tools from false positives at threshold", () => {
      const now = 1000_000;
      const fp = fingerprintToolArgs({ path: "/src/index.ts" });
      const invocations: ToolInvocation[] = [
        { toolName: "view_file", argsFingerprint: fp, timestamp: now - 10_000 },
        { toolName: "view_file", argsFingerprint: fp, timestamp: now - 5_000 },
        { toolName: "view_file", argsFingerprint: fp, timestamp: now },
      ];

      // Whitelisted tool (view_file) called 3 times should NOT trigger a loop alarm
      const patterns = detectRepeatTools(invocations, undefined, now);
      expect(patterns).toHaveLength(0);

      // But if called excessively (>= 2x threshold = 6), it should trigger
      const excessive: ToolInvocation[] = [
        ...invocations,
        { toolName: "view_file", argsFingerprint: fp, timestamp: now },
        { toolName: "view_file", argsFingerprint: fp, timestamp: now },
        { toolName: "view_file", argsFingerprint: fp, timestamp: now },
      ];
      const excessivePatterns = detectRepeatTools(excessive, undefined, now);
      expect(excessivePatterns).toHaveLength(1);
      expect(excessivePatterns[0]!.count).toBe(6);
    });

    it("detects high frequency non-identical churn for mutating tools", () => {
      const now = 1000_000;
      const invocations: ToolInvocation[] = [
        { toolName: "edit_file", argsFingerprint: "fp1", timestamp: now - 20_000 },
        { toolName: "edit_file", argsFingerprint: "fp2", timestamp: now - 15_000 },
        { toolName: "edit_file", argsFingerprint: "fp3", timestamp: now - 10_000 },
        { toolName: "edit_file", argsFingerprint: "fp4", timestamp: now - 5_000 },
        { toolName: "edit_file", argsFingerprint: "fp5", timestamp: now },
      ];

      const patterns = detectRepeatTools(invocations, undefined, now);
      expect(patterns).toHaveLength(1);
      const pattern = patterns[0]!;
      expect(pattern.identical).toBe(false);
      expect(pattern.reasons[0]).toContain("high_frequency_tool_churn");
    });

    it("manages bounded in-memory tool invocations per session", () => {
      const tracker = ToolInvocationTracker.getInstance();
      setRepeatGuardConfig({ maxTrackedInvocations: 5 });

      for (let i = 0; i < 10; i++) {
        tracker.record(
          "sess-1",
          "run-1",
          "grep",
          { query: `term_${i}` },
          {
            toolCallId: `call-${i}`,
            outcome: "success",
            resultFingerprint: `result-${i}`,
            progressFingerprint: `progress-${i}`,
          },
        );
      }

      const stored = tracker.getInvocations("sess-1", "run-1");
      expect(stored).toHaveLength(5);
      expect(stored[4]!.argsFingerprint).toBe(fingerprintToolArgs({ query: "term_9" }));

      tracker.clearSession("sess-1");
      expect(tracker.getInvocations("sess-1")).toHaveLength(0);
    });
  });

  describe("5.3 Repeat Hypothesis Guard", () => {
    it("returns healthy diversity when attempts are few or diverse", () => {
      const attempts: AdaptiveFailureAttempt[] = [
        makeAttempt({ id: "1", strategyCode: "fix_type_error", reasonCode: "tsc_error" }),
        makeAttempt({ id: "2", strategyCode: "rewrite_interface", reasonCode: "lint_error" }),
      ];

      const result = detectRepeatHypothesis(attempts);
      expect(result.isRepeating).toBe(false);
      expect(result.ratio).toBe(1.0);
    });

    it("flags low hypothesis diversity when identical strategies repeat", () => {
      const attempts: AdaptiveFailureAttempt[] = [
        makeAttempt({ id: "1", strategyCode: "blind_retry" }),
        makeAttempt({ id: "2", strategyCode: "blind_retry" }),
        makeAttempt({ id: "3", strategyCode: "blind_retry" }),
      ];

      const result = detectRepeatHypothesis(attempts);
      expect(result.isRepeating).toBe(true);
      expect(result.uniqueSignatures).toBe(1);
      expect(result.ratio).toBeCloseTo(0.333, 2);
      expect(result.dominantSignatures[0]!.strategyCode).toBe("blind_retry");
      expect(result.reasons[0]).toContain("low_hypothesis_diversity");
    });
  });

  describe("5.4 Failure Loop Guard & Circuit Breakers", () => {
    it("trips hard circuit breaker when consecutive failures reach maximum threshold", () => {
      const failedAttempts: AdaptiveFailureAttempt[] = Array.from({ length: 5 }, (_, i) =>
        makeAttempt({ id: `att-${i}`, strategyCode: `strat_${i}` }),
      );

      const action = detectFailureLoop({
        attempts: failedAttempts,
        repeatTools: [],
      });

      expect(action).toBeDefined();
      expect(action?.action).toBe("circuit_break");
      expect(action?.reasonCodes).toContain("circuit_breaker_max_failures");
    });

    it("delegates to debugger specialist when identical bash command loops", () => {
      const attempts: AdaptiveFailureAttempt[] = [
        makeAttempt({ id: "1", strategyCode: "run_test" }),
      ];

      const action = detectFailureLoop({
        attempts,
        repeatTools: [
          {
            toolName: "bash",
            count: 3,
            windowMs: 300_000,
            identical: true,
            reasons: [],
          },
        ],
      });

      expect(action).toBeDefined();
      expect(action?.action).toBe("delegate");
      if (action?.action === "delegate") {
        expect(action.role).toBe("debugger");
      }
    });

    it("delegates to explore specialist when search loop is detected", () => {
      const action = detectFailureLoop({
        attempts: [],
        repeatTools: [
          {
            toolName: "grep_search",
            count: 3,
            windowMs: 300_000,
            identical: true,
            reasons: [],
          },
        ],
      });

      expect(action).toBeDefined();
      expect(action?.action).toBe("delegate");
      if (action?.action === "delegate") {
        expect(action.role).toBe("explore");
      }
    });

    it("suggests strategy change when hypothesis loop occurs with multiple failures", () => {
      const attempts: AdaptiveFailureAttempt[] = [
        makeAttempt({ id: "1", strategyCode: "same_fix" }),
        makeAttempt({ id: "2", strategyCode: "same_fix" }),
      ];

      const action = detectFailureLoop({
        attempts,
        repeatTools: [],
      });

      expect(action).toBeDefined();
      expect(action?.action).toBe("change_strategy");
      expect(action?.reasonCodes).toContain("hypothesis_loop_detected");
    });

    it("manages circuit breaker registry lifecycle", () => {
      const registry = CircuitBreakerRegistry.getInstance();
      expect(registry.isOpen("sess-cb")).toBe(false);

      registry.recordFailure("sess-cb");
      registry.recordFailure("sess-cb");
      expect(registry.isOpen("sess-cb")).toBe(false);

      registry.trip("sess-cb", "Unrecoverable build loop");
      expect(registry.isOpen("sess-cb")).toBe(true);

      const record = registry.getRecord("sess-cb");
      expect(record.state).toBe("open");
      expect(record.trippedReason).toBe("Unrecoverable build loop");

      registry.reset("sess-cb");
      expect(registry.isOpen("sess-cb")).toBe(false);
    });
  });

  describe("5.5 Kernel Hook Integration", () => {
    it("bypasses repeat guards when feature flag is disabled", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_REPEAT_GUARDS: false,
      });

      const context: HarnessContext = {
        sessionId: "sess-off",
        runId: "run-off",
        mode: "build",
        state: new Map(),
      };

      const turnResult = await defaultTurnStartRepeatGuardHook.execute({}, context);
      expect(turnResult.proceed).toBe(true);
      expect(context.state.has("harness.repeat_tools")).toBe(false);

      const verifResult = await defaultVerificationRepeatGuardHook.execute(
        { runId: "run-off", exitCode: 1 },
        context,
      );
      expect(verifResult.verified).toBe(false);
      expect(verifResult.suggestedAction).toBe("retry");
    });

    it("records analysis during turn start when feature flag is enabled", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_REPEAT_GUARDS: true,
      });

      const tracker = ToolInvocationTracker.getInstance();
      const fp = fingerprintToolArgs({ file: "a.ts" });
      for (let index = 0; index < 3; index += 1) {
        tracker.record("sess-on", "run-on", "edit", fp, {
          toolCallId: `call-${index}`,
          outcome: "success",
          resultFingerprint: "same-result",
          progressFingerprint: "same-progress",
        });
      }

      const context: HarnessContext = {
        sessionId: "sess-on",
        runId: "run-on",
        mode: "build",
        state: new Map(),
      };

      const result = await defaultTurnStartRepeatGuardHook.execute({}, context);
      expect(result.proceed).toBe(true);
      expect(context.state.has("harness.repeat_tools")).toBe(true);
      const patterns = context.state.get("harness.repeat_tools");
      expect(patterns).toHaveLength(1);
    });

    it("never overrides an upstream intent-gate abort", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_REPEAT_GUARDS: true,
      });

      const context: HarnessContext = {
        sessionId: "sess-gate",
        runId: "run-gate",
        mode: "build",
        state: new Map(),
      };

      // The kernel chains hook outputs: the intent hook runs first (priority 10)
      // and may abort. This guard (priority 25) must forward that abort intact.
      const upstream = {
        proceed: false,
        abortReason: "Gate action required: confirm",
        classification: { taskType: "implementation" },
      };

      const result = await defaultTurnStartRepeatGuardHook.execute(
        upstream as unknown as Parameters<typeof defaultTurnStartRepeatGuardHook.execute>[0],
        context,
      );

      expect(result.proceed).toBe(false);
      expect(result.abortReason).toBe("Gate action required: confirm");
      expect(result.classification).toEqual({ taskType: "implementation" });
      expect(context.state.has("harness.repeat_tools")).toBe(true);
    });

    it("forwards an upstream abort even when the guard flag is disabled", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_REPEAT_GUARDS: false,
      });

      const context: HarnessContext = {
        sessionId: "sess-gate-off",
        runId: "run-gate-off",
        mode: "build",
        state: new Map(),
      };

      const result = await defaultTurnStartRepeatGuardHook.execute(
        { proceed: false, abortReason: "Turn rejected" } as unknown as Parameters<
          typeof defaultTurnStartRepeatGuardHook.execute
        >[0],
        context,
      );

      expect(result.proceed).toBe(false);
      expect(result.abortReason).toBe("Turn rejected");
      expect(context.state.has("harness.repeat_tools")).toBe(false);
    });

    it("trips circuit breaker and suggests replan during verification check when loops detected", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_REPEAT_GUARDS: true,
      });

      const context: HarnessContext = {
        sessionId: "sess-trip",
        runId: "run-trip",
        mode: "build",
        state: new Map(),
      };

      const failedAttempts: AdaptiveFailureAttempt[] = Array.from({ length: 5 }, (_, i) =>
        makeAttempt({
          id: `att-${i}`,
          sessionId: "sess-trip",
          runId: "run-trip",
          strategyCode: "retry",
        }),
      );
      context.state.set("harness.failure_attempts", failedAttempts);

      const verifResult = await defaultVerificationRepeatGuardHook.execute(
        { runId: "run-trip", exitCode: 1 },
        context,
      );

      expect(verifResult.verified).toBe(false);
      expect(verifResult.suggestedAction).toBe("replan");
      expect(verifResult.failureReason).toContain("Circuit breaker tripped");

      expect(CircuitBreakerRegistry.getInstance().isOpen("sess-trip")).toBe(true);
    });
  });

  describe("5.6 Meta Controller Integration", () => {
    it("incorporates repeated hypothesis into avoid codes when MODUS_REPEAT_GUARDS is enabled", () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_REPEAT_GUARDS: true,
      });

      const attempts: AdaptiveFailureAttempt[] = [
        makeAttempt({ id: "1", strategyCode: "looping_tactic" }),
        makeAttempt({ id: "2", strategyCode: "looping_tactic" }),
      ];

      const decision = decideNext({
        sessionId: "s",
        runId: "r",
        workspaceId: "w",
        mode: "build",
        classification: {
          taskType: "implementation",
          complexity: "simple",
          risk: "low",
          confidence: "high",
          reasons: [],
        },
        failureAttempts: attempts,
        remainingContinuationBudget: 1,
        enabledModelIds: [],
        decisionMode: "advisory",
        openQuestionCount: 0,
        unresolvedCriterionCount: 1,
        qaStatus: "failed",
      });

      expect(decision.avoidStrategyCodes).toContain("looping_tactic");
      expect(decision.action).toBe("avoid_retry");
    });

    it("forces a replan when the circuit breaker verdict reaches the meta controller", () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_REPEAT_GUARDS: true,
      });

      const decision = decideNext({
        sessionId: "s",
        runId: "r",
        workspaceId: "w",
        mode: "build",
        classification: {
          taskType: "implementation",
          complexity: "simple",
          risk: "low",
          confidence: "high",
          reasons: [],
        },
        failureAttempts: [makeAttempt({ id: "cb-1" })],
        remainingContinuationBudget: 1,
        enabledModelIds: [],
        decisionMode: "advisory",
        openQuestionCount: 0,
        unresolvedCriterionCount: 1,
        qaStatus: "failed",
        failureLoopAction: {
          action: "circuit_break",
          reason: "Circuit breaker tripped: exceeded maximum failed attempts (5/5)",
          reasonCodes: ["circuit_breaker_max_failures", "failures_5"],
        },
      });

      expect(decision.action).toBe("replan");
      expect(decision.reasonCodes).toContain("repeat_guard_circuit_break");
      expect(decision.reasonCodes).toContain("circuit_breaker_max_failures");
    });

    it("treats non-breaking loop verdicts as a strategy to avoid", () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_REPEAT_GUARDS: true,
      });

      const decision = decideNext({
        sessionId: "s",
        runId: "r",
        workspaceId: "w",
        mode: "build",
        classification: {
          taskType: "implementation",
          complexity: "simple",
          risk: "low",
          confidence: "high",
          reasons: [],
        },
        failureAttempts: [makeAttempt({ id: "ls-1", strategyCode: "repeat_probe" })],
        remainingContinuationBudget: 1,
        enabledModelIds: [],
        decisionMode: "advisory",
        openQuestionCount: 0,
        unresolvedCriterionCount: 1,
        qaStatus: "failed",
        failureLoopAction: {
          action: "change_strategy",
          suggestion: "Avoid repeating identical invocation of bash",
          reasonCodes: ["tool_loop_change_strategy"],
        },
      });

      expect(decision.action).toBe("avoid_retry");
    });
  });

  it("routes a tool-loop verdict through the Meta Controller without QA failure", () => {
    setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_REPEAT_GUARDS: true });

    const decision = decideNext({
      sessionId: "s",
      runId: "r",
      workspaceId: "w",
      mode: "build",
      classification: {
        taskType: "implementation",
        complexity: "simple",
        risk: "low",
        confidence: "high",
        reasons: [],
      },
      failureAttempts: [],
      remainingContinuationBudget: 0,
      enabledModelIds: [],
      decisionMode: "advisory",
      openQuestionCount: 0,
      unresolvedCriterionCount: 1,
      failureLoopAction: {
        action: "change_strategy",
        suggestion: "Change the repeated tool call.",
        reasonCodes: ["tool_loop_detected", "identical_tool_call_loop"],
      },
    });

    expect(decision.action).toBe("avoid_retry");
    expect(decision.reasonCodes).toContain("repeat_guard_tool_loop");
  });

  describe("5.7 Performance Benchmark (SLO < 5ms)", () => {
    it("executes repeat tool detection over 500 invocations in < 5ms", () => {
      const now = Date.now();
      const invocations: ToolInvocation[] = [];
      for (let i = 0; i < 500; i++) {
        invocations.push({
          toolName: i % 10 === 0 ? "grep" : "view_file",
          argsFingerprint: `fp_${i % 15}`,
          timestamp: now - (500 - i) * 500,
        });
      }

      const start = performance.now();
      const patterns = detectRepeatTools(invocations, undefined, now);
      const elapsed = performance.now() - start;

      expect(patterns).toBeDefined();
      expect(elapsed).toBeLessThan(5); // SLO: under 5ms
    });
  });
});
