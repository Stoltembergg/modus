import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../db/database";
import { CompactionCoordinator } from "./compaction/compaction-coordinator";
import type { MessageLike } from "./compaction/compaction-pruner";
import type { PreservedEvidence } from "./compaction/evidence-preservation";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "./feature-flags";
import type { HarnessContext, HarnessHook } from "./kernel/harness-hooks";
import { HarnessKernel } from "./kernel/harness-kernel";
import { PromptRegistry } from "./prompt/prompt-registry";
import { PersonaSectionProvider } from "./prompt/sections/persona-section";
import { PolicySectionProvider } from "./prompt/sections/policy-section";
import { RulesSectionProvider } from "./prompt/sections/rules-section";
import { SkillsSectionProvider } from "./prompt/sections/skills-section";
import type { Deliverable } from "./response/deliverables";
import { ResponseFormatter } from "./response/response-formatter";
import { ResponsePolicyRegistry } from "./response/response-registry";
import { ToolResultStorage } from "./tools/tool-result-storage";
import { interceptToolResult } from "./tools/tool-spill-interceptor";

function createSpillTestStorage(scope: { sessionId: string; runId: string; workspaceId: string }): {
  database: DatabaseSync;
  storage: ToolResultStorage;
} {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  migrateDatabase(database);
  const now = new Date().toISOString();
  database
    .prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, 'spill test', 0, ?, ?)`,
    )
    .run(scope.workspaceId, `/spill-test/${scope.workspaceId}`, now, now);
  database
    .prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
       values (?, ?, 'spill test', '/spill-test', 'running', ?, ?)`,
    )
    .run(scope.sessionId, scope.workspaceId, now, now);
  database
    .prepare(
      `insert into agent_runs (id, session_id, prompt, status, started_at)
       values (?, ?, ?, ?, ?)`,
    )
    .run(scope.runId, scope.sessionId, "spill test", "running", now);
  return { database, storage: new ToolResultStorage({ database }) };
}

describe("Phase 10 — DeepSeek Harness Performance Benchmarks & Token Reduction", () => {
  beforeEach(() => {
    resetFeatureFlagOverrides();
    setFeatureFlagOverrides({
      MODUS_USE_KERNEL: true,
      MODUS_PROMPT_REGISTRY: true,
      MODUS_TOOL_RESULT_SPILL: true,
      MODUS_COMPACTION_PRUNING: true,
      MODUS_REPEAT_GUARDS: true,
      MODUS_GROUPS_MAILBOX: true,
      MODUS_RESPONSE_POLICY: true,
      MODUS_OBSERVABILITY: true,
    });
    ToolResultStorage.resetInstance();
    ResponsePolicyRegistry.resetInstance();
  });

  it("10.1 Benchmark: Prompt Diffing & Cacheable Prefix achieves >= 50% static cache ratio", async () => {
    const registry = new PromptRegistry();
    registry.registerProvider(new PersonaSectionProvider());
    registry.registerProvider(new RulesSectionProvider());
    registry.registerProvider(new SkillsSectionProvider());
    registry.registerProvider(new PolicySectionProvider());

    const context: HarnessContext = {
      sessionId: "bench-session-1",
      runId: "bench-run-1",
      mode: "build",
      state: new Map(),
      cwd: "C:/app",
    };

    const result = await registry.assemble(context);

    // Static sections (persona, rules, skills, policy) provide high cacheable prefix ratio
    expect(result.staticRatio).toBeGreaterThanOrEqual(0.5);
    expect(result.cacheablePrefix.length).toBeGreaterThan(500);

    // Estimate token savings: on subsequent turns, staticPrefix is cached by Anthropic/OpenAI prompt cache
    const cachedTokens = result.staticPrefixTokensEstimate;
    expect(cachedTokens).toBeGreaterThan(100);
  });

  it("10.2 Benchmark: Tool Result Spill achieves >= 85% token reduction for outputs > 20 KB", () => {
    ToolResultStorage.resetInstance();

    // Simulate 35 KB build output (e.g. webpack or vite bundle log)
    const rawOutput =
      "Build step: compiling modules...\n" +
      "chunk-details: ".repeat(2500) +
      "\nBuild finished in 4.2s.";
    const rawEstimatedTokens = Math.ceil(rawOutput.length / 4);

    const scope = {
      sessionId: "bench-spill-session",
      runId: "bench-spill-run",
      workspaceId: "bench-spill-workspace",
    };
    const { database, storage } = createSpillTestStorage(scope);
    try {
      const intercept = interceptToolResult({
        ...scope,
        toolName: "bash",
        output: rawOutput,
        storage,
      });
      expect(intercept.spilled).toBe(true);

      const spilledEstimatedTokens = Math.ceil(intercept.effectiveContent.length / 4);
      const tokenReductionPercent =
        ((rawEstimatedTokens - spilledEstimatedTokens) / rawEstimatedTokens) * 100;

      // Expected token reduction: > 85%
      expect(tokenReductionPercent).toBeGreaterThanOrEqual(85);
    } finally {
      database.close();
    }
  });

  it("10.3 Benchmark: Compaction Pruning saves >= 50% ephemeral tokens before LLM summarization", () => {
    const coordinator = new CompactionCoordinator();

    // 10 messages with 6 ephemeral large tool logs and 4 critical reasoning steps
    const messages: MessageLike[] = [
      { id: "m0", role: "user", content: "Run the full test suite" },
      { id: "m1", role: "assistant", content: "Starting tests across 8 packages..." },
      {
        id: "m2",
        role: "tool",
        toolName: "run_command",
        content: "DEBUG [auth]: " + "x".repeat(12000),
      },
      {
        id: "m3",
        role: "tool",
        toolName: "run_command",
        content: "DEBUG [billing]: " + "y".repeat(12000),
      },
      {
        id: "m4",
        role: "tool",
        toolName: "run_command",
        content: "DEBUG [cart]: " + "z".repeat(12000),
      },
      {
        id: "m5",
        role: "assistant",
        content: "Partial success in auth and cart; retrying billing...",
      },
      {
        id: "m6",
        role: "tool",
        toolName: "run_command",
        content: "DEBUG [billing retry]: " + "w".repeat(12000),
      },
      { id: "m7", role: "assistant", content: "Billing passed after retry." },
      {
        id: "m8",
        role: "tool",
        toolName: "run_command",
        content: "DEBUG [cleanup]: " + "k".repeat(12000),
      },
      {
        id: "m9",
        role: "assistant",
        content: "All suites completed successfully: 48 tests passed.",
      },
    ];

    const evidence: PreservedEvidence[] = [
      {
        id: "ev-suite",
        category: "qa_check",
        timestamp: Date.now(),
        summary: "Full Test Suite: 48 tests passed, 0 failures",
      },
    ];

    const customPolicy = {
      modelId: "bench-model",
      contextWindow: 20_000,
      outputReserve: 1_000,
      headroom: 1_000,
      thresholdRatio: 0.8, // trigger at 15,200 tokens
      targetRatioAfterPrune: 0.4, // prune down to 7,600 tokens
      preserveCategories: ["qa_check" as const],
    };

    const result = coordinator.coordinate({
      sessionId: "bench-compaction-session",
      currentTokens: 18000,
      messages,
      evidence,
      customPolicy,
    });

    const prunedTokens = result.savedTokens;
    const initialTokens = 18000;
    const pruningSavingsPercent = (prunedTokens / initialTokens) * 100;

    // Pruning ephemeral tool runs saves >= 50% of the token bloat
    expect(pruningSavingsPercent).toBeGreaterThanOrEqual(50);
    expect(result.shouldCancelCompaction).toBe(true);
    expect(result.preservedEvidenceCount).toBe(1);
  });

  it("10.4 Benchmark: Response Policy cuts verbosity by >= 40% while preserving 100% critical alerts", () => {
    const registry = ResponsePolicyRegistry.getInstance();
    registry.setSessionPolicy("bench-session", { level: "compact" });

    const formatter = new ResponseFormatter();
    const verboseAssistantText = [
      "Here is the detailed analysis of the system architecture and everything we observed during inspection.",
      "The database layer utilizes a singleton pool with 10 max connections which might cause congestion during peak hours.",
      "In the middle tier, the express router is mounting controllers sequentially which could introduce a minor routing overhead.",
      "We noticed that cache headers are not currently set on static asset responses in the public directory.",
      "> [!WARNING]\n> High severity: SQL injection vulnerability detected in legacy search query parser!",
      "> [!CAUTION]\n> Do not restart the server without running the safety migration script first!",
      "Furthermore, the worker queue is configured to retry up to 5 times with exponential backoff.",
      "The logging pipeline currently logs to stdout in development mode and a local log file in production.",
    ].join("\n\n");

    const deliverables: Deliverable[] = [
      { id: "d1", type: "file_changed", label: "patch.sql", path: "migrations/patch.sql" },
    ];

    const formattedResult = formatter.format({
      message: verboseAssistantText,
      policy: registry.getSessionPolicy("bench-session"),
      deliverables,
    });

    const originalTokens = Math.ceil(verboseAssistantText.length / 4);
    const formattedTokens = Math.ceil(formattedResult.response.length / 4);
    const reductionPercent = ((originalTokens - formattedTokens) / originalTokens) * 100;

    // Verbosity reduced by >= 40%
    expect(reductionPercent).toBeGreaterThanOrEqual(40);

    // Critical invariants: 100% preservation of warnings and deliverables
    expect(formattedResult.response).toContain("SQL injection vulnerability detected");
    expect(formattedResult.response).toContain(
      "Do not restart the server without running the safety migration script",
    );
    expect(formattedResult.deliverablesSummary).toBe("*1 file(s) modified.*");
    expect(formattedResult.response).toContain("*1 file(s) modified.*");
  });

  it("10.5 Benchmark: Hook Execution Performance Overhead SLO (< 1.5ms per hook)", async () => {
    const kernel = new HarnessKernel();

    // Register 10 lightweight hooks across lifecycle phases
    for (let i = 0; i < 10; i++) {
      const hook: HarnessHook<{ iter?: number }, { iter?: number }> = {
        name: `bench_hook_${i}`,
        phase: "turn_start",
        priority: i * 10,
        isCritical: false,
        execute: (input) => input,
      };
      kernel.registerHook(hook);
    }

    const context: HarnessContext = {
      sessionId: "bench-kernel-session",
      runId: "bench-kernel-run",
      mode: "build",
      state: new Map(),
      cwd: "C:/app",
    };

    // Warm-up
    await kernel.executePhase("turn_start", { iter: 0 }, context);

    // Execute 50 phase executions (500 hook executions total)
    const iterations = 50;
    const startTime = performance.now();
    for (let i = 0; i < iterations; i++) {
      await kernel.executePhase("turn_start", { iter: i }, context);
    }
    const totalDurationMs = performance.now() - startTime;
    const avgDurationPerPhaseMs = totalDurationMs / iterations;
    const avgDurationPerHookMs = avgDurationPerPhaseMs / 10;

    // SLO: Average duration per hook must be under 1.5ms
    expect(avgDurationPerHookMs).toBeLessThan(1.5);
  });
});
