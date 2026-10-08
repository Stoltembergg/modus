import { describe, expect, it, vi } from "vitest";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "../feature-flags";
import type { HarnessContext, TurnStartInput, TurnStartOutput } from "./harness-hooks";
import { HarnessKernel } from "./harness-kernel";
import { turnSettleHook } from "./settlement-hook";
import { turnStartIntentHook } from "./turn-hook";

describe("Fase 1.1: Runtime Integration & Dual-Path Validation", () => {
  it("1.1.1 Kernel initializes with standard lifecycle phases registered", () => {
    const kernel = new HarnessKernel();
    kernel.registerHook(turnStartIntentHook);
    kernel.registerHook(turnSettleHook);

    const startHooks = kernel.getHooksForPhase("turn_start");
    const settleHooks = kernel.getHooksForPhase("turn_settle");

    expect(startHooks).toHaveLength(1);
    expect(startHooks[0]?.name).toBe("turn_start_intent_classifier");
    expect(settleHooks).toHaveLength(1);
    expect(settleHooks[0]?.name).toBe("turn_settle_continuation");
  });

  it("1.1.2 Dual-path: when MODUS_USE_KERNEL is false, bypasses hooks with zero overhead", async () => {
    setFeatureFlagOverrides({ MODUS_USE_KERNEL: false });

    try {
      const kernel = new HarnessKernel();
      kernel.registerHook(turnStartIntentHook);

      const ctx: HarnessContext = {
        sessionId: "test-session-bypass",
        runId: "test-run-1",
        workspaceId: "ws-1",
        cwd: "C:/app",
        mode: "build",
        state: new Map(),
      };

      const input: TurnStartInput = {
        sessionId: "test-session-bypass",
        userPrompt: "Hello world",
        mode: "build",
      };

      const start = performance.now();
      const output = await kernel.executeHooks<TurnStartInput, TurnStartOutput>(
        "turn_start",
        input,
        ctx
      );
      const elapsed = performance.now() - start;

      // Pass-through behavior: input is returned directly as output
      expect(output).toEqual(input);
      expect(elapsed).toBeLessThan(5);
      // No execution history recorded
      expect(kernel.getExecutionHistory()).toHaveLength(0);
    } finally {
      resetFeatureFlagOverrides();
    }
  });

  it("1.1.3 Dual-path: when MODUS_USE_KERNEL is true, executes pipeline and records telemetry", async () => {
    setFeatureFlagOverrides({ MODUS_USE_KERNEL: true });

    try {
      const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      const kernel = new HarnessKernel();
      kernel.registerHook(turnStartIntentHook);

      const ctx: HarnessContext = {
        sessionId: "test-session-active",
        runId: "test-run-2",
        workspaceId: "ws-1",
        cwd: "C:/app",
        mode: "build",
        state: new Map(),
      };

      const input: TurnStartInput = {
        sessionId: "test-session-active",
        userPrompt: "Inspect the repository structure and explore where files live",
        mode: "build",
      };

      const output = await kernel.executeHooks<TurnStartInput, TurnStartOutput>(
        "turn_start",
        input,
        ctx
      );

      expect(output.proceed).toBe(true);
      expect(output.classification).toBeDefined();
      expect(output.classification?.taskType).toBe("explore");

      // Execution history must be populated
      const history = kernel.getExecutionHistory();
      expect(history).toHaveLength(1);
      expect(history[0]?.hookName).toBe("turn_start_intent_classifier");
      expect(history[0]?.phase).toBe("turn_start");
      expect(history[0]?.success).toBe(true);

      // Verify structured logging [modus-harness]
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining("[modus-harness] Phase: turn_start")
      );

      consoleInfoSpy.mockRestore();
    } finally {
      resetFeatureFlagOverrides();
    }
  });

  it("1.1.4 Critical hook aborts turn execution with descriptive reason", async () => {
    setFeatureFlagOverrides({ MODUS_USE_KERNEL: true });

    try {
      const kernel = new HarnessKernel();
      kernel.registerHook({
        name: "guard_check",
        phase: "turn_start",
        priority: 5,
        isCritical: true,
        execute: async () => {
          return {
            proceed: false,
            abortReason: "Session blocked by safety policy",
          };
        },
      });

      const ctx: HarnessContext = {
        sessionId: "test-abort",
        runId: "test-run-3",
        workspaceId: "ws-1",
        cwd: "C:/app",
        mode: "build",
        state: new Map(),
      };

      const output = await kernel.executeHooks<TurnStartInput, TurnStartOutput>(
        "turn_start",
        { sessionId: "test-abort", userPrompt: "delete everything", mode: "build" },
        ctx
      );

      expect(output.proceed).toBe(false);
      expect(output.abortReason).toBe("Session blocked by safety policy");
    } finally {
      resetFeatureFlagOverrides();
    }
  });
});
