import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetFeatureFlagOverrides,
  setFeatureFlagOverrides,
  validateFeatureFlags,
} from "../feature-flags";
import { contextResolveHook } from "./context-hook";
import type {
  HarnessContext,
  HarnessHook,
  TurnStartInput,
  TurnStartOutput,
} from "./harness-hooks";
import { HarnessKernel } from "./harness-kernel";
import { modelSelectHook } from "./model-hook";
import { promptBuildHook } from "./prompt-hook";
import { turnSettleHook } from "./settlement-hook";
import { toolsRegisterHook } from "./tools-hook";
import { turnStartIntentHook } from "./turn-hook";
import { verificationCheckHook } from "./verification-hook";

describe("Fase 1: HarnessKernel and Hook System", () => {
  let kernel: HarnessKernel;
  let mockContext: HarnessContext;

  beforeEach(() => {
    resetFeatureFlagOverrides();
    kernel = new HarnessKernel();
    mockContext = {
      sessionId: "test-session-123",
      runId: "test-run-456",
      workspaceId: "test-workspace-789",
      mode: "build",
      state: new Map<string, unknown>(),
      startedAt: Date.now(),
    };
  });

  it("1.1 Registers hooks and executes in strict priority order", async () => {
    const executionOrder: string[] = [];

    const hookLowPriority: HarnessHook<{ val: number }, { val: number }> = {
      name: "hook_low",
      phase: "turn_start",
      priority: 100,
      execute: async (input) => {
        executionOrder.push("low");
        return { val: input.val + 1 };
      },
    };

    const hookHighPriority: HarnessHook<{ val: number }, { val: number }> = {
      name: "hook_high",
      phase: "turn_start",
      priority: 10,
      execute: async (input) => {
        executionOrder.push("high");
        return { val: input.val * 2 };
      },
    };

    const hookMidPriority: HarnessHook<{ val: number }, { val: number }> = {
      name: "hook_mid",
      phase: "turn_start",
      priority: 50,
      execute: async (input) => {
        executionOrder.push("mid");
        return { val: input.val + 10 };
      },
    };

    kernel.registerHook(hookLowPriority);
    kernel.registerHook(hookHighPriority);
    kernel.registerHook(hookMidPriority);

    const result = await kernel.executeHooks("turn_start", { val: 5 }, mockContext);

    expect(executionOrder).toEqual(["high", "mid", "low"]);
    // (5 * 2 = 10) -> (10 + 10 = 20) -> (20 + 1 = 21)
    expect(result.val).toBe(21);
  });

  it("1.2 Respects hook dependencies with topological ordering", async () => {
    const executionOrder: string[] = [];

    // hookB has lower priority number (should run first by priority), BUT depends on hookA
    const hookB: HarnessHook<{ val: string }, { val: string }> = {
      name: "hook_b",
      phase: "context_resolve",
      priority: 10,
      dependsOn: ["hook_a"],
      execute: async (input) => {
        executionOrder.push("B");
        return { val: input.val + "->B" };
      },
    };

    const hookA: HarnessHook<{ val: string }, { val: string }> = {
      name: "hook_a",
      phase: "context_resolve",
      priority: 50,
      execute: async (input) => {
        executionOrder.push("A");
        return { val: input.val + "->A" };
      },
    };

    kernel.registerHook(hookB);
    kernel.registerHook(hookA);

    const result = await kernel.executeHooks(
      "context_resolve",
      { val: "start" },
      mockContext
    );

    expect(executionOrder).toEqual(["A", "B"]);
    expect(result.val).toBe("start->A->B");
  });

  it("1.3 Recovers gracefully from missing dependencies (logs warning, does not crash)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const hookWithGhostDep: HarnessHook<{ ok: boolean }, { ok: boolean }> = {
      name: "hook_ghost_dep",
      phase: "prompt_build",
      priority: 10,
      dependsOn: ["non_existent_hook"],
      execute: async () => ({ ok: true }),
    };

    kernel.registerHook(hookWithGhostDep);

    const result = await kernel.executeHooks(
      "prompt_build",
      { ok: false },
      mockContext
    );

    expect(result.ok).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("depends on missing hook: non_existent_hook")
    );

    warnSpy.mockRestore();
  });

  it("1.4 Recovers gracefully from circular dependencies (skips circular hook, does not hang)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const hookX: HarnessHook<{ count: number }, { count: number }> = {
      name: "hook_x",
      phase: "model_select",
      priority: 10,
      dependsOn: ["hook_y"],
      execute: async (input) => ({ count: input.count + 1 }),
    };

    const hookY: HarnessHook<{ count: number }, { count: number }> = {
      name: "hook_y",
      phase: "model_select",
      priority: 20,
      dependsOn: ["hook_x"],
      execute: async (input) => ({ count: input.count + 10 }),
    };

    kernel.registerHook(hookX);
    kernel.registerHook(hookY);

    // Resolving hooks should not crash with infinite recursion
    const ordered = kernel.getHooksForPhase("model_select");
    expect(ordered.length).toBeLessThanOrEqual(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping hook")
    );

    errorSpy.mockRestore();
  });

  it("1.5 Handles non-critical vs critical hook failures gracefully", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const nonCriticalFailingHook: HarnessHook<{ text: string }, { text: string }> = {
      name: "failing_hook",
      phase: "tools_register",
      priority: 10,
      isCritical: false,
      execute: async () => {
        throw new Error("Something went wrong in non-critical hook");
      },
    };

    const subsequentHook: HarnessHook<{ text: string }, { text: string }> = {
      name: "good_hook",
      phase: "tools_register",
      priority: 20,
      execute: async (input) => ({ text: input.text + "_processed" }),
    };

    kernel.registerHook(nonCriticalFailingHook);
    kernel.registerHook(subsequentHook);

    const result = await kernel.executeHooks(
      "tools_register",
      { text: "initial" },
      mockContext
    );

    expect(result.text).toBe("initial_processed");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Non-critical hook failing_hook failed")
    );

    // Critical hook failure MUST throw
    const criticalFailingHook: HarnessHook<{ text: string }, { text: string }> = {
      name: "critical_failing_hook",
      phase: "tools_register",
      priority: 5,
      isCritical: true,
      execute: async () => {
        throw new Error("Fatal error in critical hook");
      },
    };

    kernel.registerHook(criticalFailingHook);

    await expect(
      kernel.executeHooks("tools_register", { text: "initial" }, mockContext)
    ).rejects.toThrow("Critical harness hook critical_failing_hook failed");

    warnSpy.mockRestore();
  });

  it("1.6 Bypasses execution when MODUS_USE_KERNEL feature flag is disabled", async () => {
    setFeatureFlagOverrides({ MODUS_USE_KERNEL: false });

    const dummyHook: HarnessHook<{ ran: boolean }, { ran: boolean }> = {
      name: "should_not_run",
      phase: "turn_start",
      priority: 1,
      execute: async () => ({ ran: true }),
    };

    kernel.registerHook(dummyHook);

    const result = await kernel.executeHooks(
      "turn_start",
      { ran: false },
      mockContext
    );

    expect(result.ran).toBe(false);
  });

  it("1.7 Validates feature flag dependencies", () => {
    // Should be valid with defaults
    expect(validateFeatureFlags().length).toBe(0);

    // Should return error if prompt registry is enabled without kernel
    const invalidFlags = {
      MODUS_USE_KERNEL: false,
      MODUS_PROMPT_REGISTRY: true,
      MODUS_TOOL_RESULT_SPILL: false,
      MODUS_COMPACTION_PRUNING: false,
      MODUS_REPEAT_GUARDS: false,
      MODUS_GROUPS_MAILBOX: false,
      MODUS_RESPONSE_POLICY: false,
    };
    const errors = validateFeatureFlags(invalidFlags);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("requires MODUS_USE_KERNEL");
  });

  it("1.8 Performance SLO: executes hooks in < 1ms overhead per turn", async () => {
    for (let i = 0; i < 10; i++) {
      kernel.registerHook({
        name: `fast_hook_${i}`,
        phase: "verification_check",
        priority: i * 10,
        execute: async (input) => input,
      });
    }

    const tStart = performance.now();
    for (let i = 0; i < 50; i++) {
      await kernel.executeHooks(
        "verification_check",
        { check: i },
        mockContext
      );
    }
    const totalTimeMs = performance.now() - tStart;
    const avgPerTurnMs = totalTimeMs / 50;

    // 10 hooks executed across 50 iterations (500 hook runs) must take < 0.2ms per turn
    expect(avgPerTurnMs).toBeLessThan(1.0);
  });

  it("1.9 Full 7-Phase Execution Pipeline with Standard Built-in Hooks", async () => {
    kernel.registerHook(turnStartIntentHook);
    kernel.registerHook(contextResolveHook);
    kernel.registerHook(promptBuildHook);
    kernel.registerHook(modelSelectHook);
    kernel.registerHook(toolsRegisterHook);
    kernel.registerHook(verificationCheckHook);
    kernel.registerHook(turnSettleHook);

    // Phase 1: turn_start
    const turnStartResult: TurnStartOutput = await kernel.executeHooks(
      "turn_start",
      {
        message: "Refactor database queries and run tests",
        context: [],
        mode: "build",
      } satisfies TurnStartInput,
      mockContext
    );
    expect(turnStartResult.proceed).toBe(true);
    expect(turnStartResult.classification?.taskType).toBe("implementation");

    // Phase 2: context_resolve
    mockContext.state.set("raw_context_candidates", [
      { id: "cand-1", label: "schema.sql", trust: "local-memory", tokenCost: 100 },
    ]);
    const contextResult = await kernel.executeHooks(
      "context_resolve",
      {
        sessionId: mockContext.sessionId,
        runId: mockContext.runId,
        paths: ["schema.sql"],
        symbols: [],
        userQuery: "Refactor database",
      },
      mockContext
    );
    expect(contextResult.candidates.length).toBe(1);

    // Phase 3: prompt_build
    const promptResult = await kernel.executeHooks(
      "prompt_build",
      {
        basePrompt: "You are Modus.",
        userMessage: "Refactor database",
        systemSections: [
          { id: "sec-rules", content: "Follow SOLID principles.", volatile: false },
          { id: "sec-active", content: "Active file: db.ts", volatile: true },
        ],
      },
      mockContext
    );
    expect(promptResult.finalSystemPrompt).toContain("Follow SOLID principles.");
    expect(promptResult.finalSystemPrompt).toContain("Active file: db.ts");

    // Phase 4: model_select
    const modelResult = await kernel.executeHooks(
      "model_select",
      { requestedModel: "claude-3-5-sonnet" },
      mockContext
    );
    expect(modelResult.effectiveModel).toBe("claude-3-5-sonnet");

    // Phase 5: tools_register
    const toolsResult = await kernel.executeHooks(
      "tools_register",
      { availableTools: ["bash", "read", "write"] },
      mockContext
    );
    expect(toolsResult.enabledTools).toEqual(["bash", "read", "write"]);
    expect(toolsResult.spillPolicies?.bash.spillThresholdBytes).toBe(20 * 1024);

    // Phase 6: verification_check
    const verifyResult = await kernel.executeHooks(
      "verification_check",
      {
        sessionId: mockContext.sessionId,
        runId: mockContext.runId,
        toolExecutions: [{ toolName: "bash", isError: false, output: "Tests passed" }],
      },
      mockContext
    );
    expect(verifyResult.allPassed).toBe(true);

    // Phase 7: turn_settle
    const settleResult = await kernel.executeHooks(
      "turn_settle",
      {
        sessionId: mockContext.sessionId,
        runId: mockContext.runId,
        assistantResponse: "All tasks completed successfully.",
        toolResults: [],
      },
      mockContext
    );
    expect(settleResult.settled).toBe(true);
    expect(settleResult.taskComplete).toBe(true);

    // Check execution metrics collected by kernel
    const metrics = kernel.getExecutionMetrics();
    expect(metrics.length).toBe(7);
    expect(metrics.every((m) => m.success)).toBe(true);
  });
});
