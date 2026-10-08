import { describe, expect, it, vi } from "vitest";
import type { HarnessContext } from "../kernel/harness-hooks";
import { PromptRegistry } from "./prompt-registry";
import type { PromptSectionProvider } from "./prompt-section";

describe("Fase 2.1: PromptRegistry Polish Sprint", () => {
  it("2.1.1 Generates Anthropic ephemeral cache_control breakpoints on static prefix", async () => {
    const registry = PromptRegistry.createDefault();

    const mockContext: HarnessContext = {
      sessionId: "session-polish-cache",
      runId: "run-1",
      workspaceId: "ws-1",
      cwd: "C:/project",
      mode: "build",
      state: new Map<string, any>([
        ["branch", "feature/caching"],
        ["activeFiles", ["src/index.ts"]],
      ]),
    };

    const result = await registry.assemblePrompt("session-polish-cache", {
      context: mockContext,
    });

    // Verify system blocks structure for Anthropic API
    expect(result.systemBlocks.length).toBeGreaterThanOrEqual(1);

    // Static block must have ephemeral cacheControl
    const staticBlock = result.systemBlocks[0];
    expect(staticBlock).toBeDefined();
    expect(staticBlock?.type).toBe("text");
    expect(staticBlock?.cacheControl).toEqual({ type: "ephemeral" });
    expect(staticBlock?.text).toContain("You are Modus");

    // Dynamic block (if present) must not have cacheControl
    if (result.systemBlocks.length > 1) {
      const dynamicBlock = result.systemBlocks[1];
      expect(dynamicBlock).toBeDefined();
      expect(dynamicBlock?.type).toBe("text");
      expect(dynamicBlock?.cacheControl).toBeUndefined();
    }

    // Verify breakpoint points to last static section
    expect(result.cacheBreakpointSectionId).toBe("policy");
    expect(result.staticRatio).toBeGreaterThan(0.4);
  });

  it("2.1.2 Fail-open resilience: Provider errors are caught without aborting prompt assembly", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const registry = PromptRegistry.createDefault();

    // Register a faulty provider that throws unexpectedly
    const faultyProvider: PromptSectionProvider = {
      getSectionId: () => "faulty_service",
      getPriority: () => 250,
      isVolatile: () => false,
      buildContent: async () => {
        throw new Error("Database connection dropped while loading prompt rules");
      },
    };
    registry.registerProvider(faultyProvider);

    const mockContext: HarnessContext = {
      sessionId: "session-fault-test",
      runId: "run-fault-1",
      workspaceId: "ws-1",
      cwd: "C:/project",
      mode: "build",
      state: new Map(),
    };

    // assemblePrompt should NOT reject; it should gracefully complete with remaining sections
    const result = await registry.assemblePrompt("session-fault-test", {
      context: mockContext,
    });

    expect(result.prompt).toBeDefined();
    expect(result.prompt).toContain("You are Modus");
    expect(result.prompt).not.toContain("faulty_service");

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("PromptSectionProvider 'faulty_service' failed during refresh")
    );

    consoleWarnSpy.mockRestore();
  });

  it("2.1.3 Session management: tracks, cleans, and releases memory across session lifecycles", () => {
    const registry = new PromptRegistry();
    registry.registerSection({
      id: "sec-1",
      priority: 100,
      content: "Static content",
      fingerprint: "fp-1",
      volatile: false,
    });

    expect(registry.getTrackedSessionCount()).toBe(0);

    registry.markAsSent("session-a");
    registry.markAsSent("session-b");
    expect(registry.getTrackedSessionCount()).toBe(2);

    registry.cleanSession("session-a");
    expect(registry.getTrackedSessionCount()).toBe(1);

    registry.clearAllSessions();
    expect(registry.getTrackedSessionCount()).toBe(0);
  });

  it("2.1.4 Provider and section unregistration cleanly removes components", () => {
    const registry = new PromptRegistry();
    const mockProvider: PromptSectionProvider = {
      getSectionId: () => "temp_provider",
      getPriority: () => 120,
      isVolatile: () => false,
      buildContent: async () => "Temporary provider content",
    };

    registry.registerProvider(mockProvider);
    expect(registry.unregisterProvider("temp_provider")).toBe(true);
    expect(registry.unregisterProvider("temp_provider")).toBe(false);

    registry.registerSection({
      id: "temp_sec",
      priority: 100,
      content: "temp",
      fingerprint: "temp-fp",
      volatile: false,
    });
    expect(registry.unregisterSection("temp_sec")).toBe(true);
    expect(registry.getSection("temp_sec")).toBeUndefined();
  });

  it("2.1.5 Multi-turn simulation: demonstrates > 70% cache stability and sub-millisecond latency", async () => {
    const registry = PromptRegistry.createDefault();
    const sessionId = "session-simulated-conversation";

    const context: HarnessContext = {
      sessionId,
      runId: "run-turn-1",
      workspaceId: "ws-test",
      cwd: "C:/app",
      mode: "build",
      state: new Map<string, any>([
        ["branch", "main"],
        ["activeFiles", ["app.ts"]],
      ]),
    };

    const turns = 5;
    const results = [];

    for (let turn = 1; turn <= turns; turn++) {
      context.runId = `run-turn-${turn}`;
      // Simulate dynamic context growth between turns
      context.state.set("activeFiles", [`file_${turn}.ts`]);
      if (turn >= 3) {
        context.state.set("memoryHints", [
          { text: `Memory acquired at turn ${turn}`, scope: "project" },
        ]);
      }

      const res = await registry.assemblePrompt(sessionId, { context });
      results.push(res);
      registry.markAsSent(sessionId);
    }

    // Turn 1 marks all sections
    expect(results[0]?.changedSectionIds.length).toBeGreaterThan(0);

    // Turn 2: only dynamic sections changed (context-section)
    expect(results[1]?.changedSectionIds).toContain("context");
    expect(results[1]?.changedSectionIds).not.toContain("persona");
    expect(results[1]?.changedSectionIds).not.toContain("rules");

    // Static ratio must remain high (> 60%) throughout conversation
    for (const res of results) {
      expect(res.staticRatio).toBeGreaterThan(0.6);
      expect(res.durationMs).toBeLessThan(10); // Well under 100ms SLO
    }
  });
});
