import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../db/database";
import { CompactionCoordinator } from "./compaction/compaction-coordinator";
import type { MessageLike } from "./compaction/compaction-pruner";
import type { PreservedEvidence } from "./compaction/evidence-preservation";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "./feature-flags";
import type { HarnessContext, HarnessHook } from "./kernel/harness-hooks";
import { HarnessKernel } from "./kernel/harness-kernel";
import { HarnessObserver } from "./observability/harness-observer";
import { defaultObservabilityTurnSettleHook } from "./observability/observability-hooks";
import { PromptRegistry } from "./prompt/prompt-registry";
import { ContextSectionProvider } from "./prompt/sections/context-section";
import { MemorySectionProvider } from "./prompt/sections/memory-section";
import { PersonaSectionProvider } from "./prompt/sections/persona-section";
import { PolicySectionProvider } from "./prompt/sections/policy-section";
import { RulesSectionProvider } from "./prompt/sections/rules-section";
import { SkillsSectionProvider } from "./prompt/sections/skills-section";
import type { Deliverable } from "./response/deliverables";
import { ResponseFormatter } from "./response/response-formatter";
import { ResponsePolicyRegistry } from "./response/response-registry";
import { ModusNativeSubagentProvider } from "./subagents/modus-native-provider";
import { SubagentProviderRegistry } from "./subagents/subagent-provider-registry";
import { handleRetrieveSpilledToolResult } from "./tools/retrieve-spill-tool";
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

describe("Phase 10 — DeepSeek-Inspired Harness End-to-End Integration Suite", () => {
  let kernel: HarnessKernel;
  let promptRegistry: PromptRegistry;
  let compactionCoordinator: CompactionCoordinator;
  let subagentRegistry: SubagentProviderRegistry;
  let responseRegistry: ResponsePolicyRegistry;
  let responseFormatter: ResponseFormatter;
  let observer: HarnessObserver;

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
    SubagentProviderRegistry.resetInstance();
    ResponsePolicyRegistry.resetInstance();
    HarnessObserver.resetInstance();

    kernel = new HarnessKernel();
    promptRegistry = new PromptRegistry();
    compactionCoordinator = new CompactionCoordinator();
    subagentRegistry = SubagentProviderRegistry.getInstance();
    responseRegistry = ResponsePolicyRegistry.getInstance();
    responseFormatter = new ResponseFormatter();
    observer = HarnessObserver.getInstance();

    // Register built-in prompt section providers
    promptRegistry.registerProvider(new PersonaSectionProvider());
    promptRegistry.registerProvider(new RulesSectionProvider());
    promptRegistry.registerProvider(new SkillsSectionProvider());
    promptRegistry.registerProvider(new ContextSectionProvider());
    promptRegistry.registerProvider(new MemorySectionProvider());
    promptRegistry.registerProvider(new PolicySectionProvider());

    // Register observability turn settle hook in kernel
    kernel.registerHook(defaultObservabilityTurnSettleHook);
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    ToolResultStorage.resetInstance();
    SubagentProviderRegistry.resetInstance();
    ResponsePolicyRegistry.resetInstance();
    HarnessObserver.resetInstance();
  });

  it("10.1 E2E Full Turn Lifecycle: executes all 7 pipeline phases and records telemetry", async () => {
    const executedPhases: string[] = [];

    const createTrackingHook = (
      name: string,
      phase: any,
      priority = 50,
    ): HarnessHook<any, any> => ({
      name,
      phase,
      priority,
      isCritical: false,
      execute: async (payload: any) => {
        executedPhases.push(phase);
        observer.recordHookExecution(phase, name, 0.4, true);
        return payload;
      },
    });

    kernel.registerHook(createTrackingHook("e2e_turn_start", "turn_start"));
    kernel.registerHook(createTrackingHook("e2e_context_resolve", "context_resolve"));
    kernel.registerHook(createTrackingHook("e2e_prompt_build", "prompt_build"));
    kernel.registerHook(createTrackingHook("e2e_model_select", "model_select"));
    kernel.registerHook(createTrackingHook("e2e_tools_register", "tools_register"));
    kernel.registerHook(createTrackingHook("e2e_verification_check", "verification_check"));

    const context: HarnessContext = {
      sessionId: "session-e2e-1",
      runId: "run-e2e-1",
      cwd: "C:/projects/test-app",
      mode: "build",
      state: new Map(),
    };

    // 1. Turn Start
    await kernel.executePhase("turn_start", { userPrompt: "Build and test auth" }, context);
    // 2. Context Resolve
    await kernel.executePhase("context_resolve", { candidates: [] }, context);
    // 3. Prompt Build
    const assembly = await promptRegistry.assemble(context);
    await kernel.executePhase("prompt_build", { prompt: assembly.prompt }, context);
    // 4. Model Select
    await kernel.executePhase("model_select", { selectedModel: "deepseek-coder-v2" }, context);
    // 5. Tools Register
    await kernel.executePhase(
      "tools_register",
      { tools: ["bash", "read_file", "write_file"] },
      context,
    );
    // 6. Verification Check
    await kernel.executePhase("verification_check", { checksPassed: true }, context);
    // 7. Turn Settle
    context.state.set("harness.turn_start_time", Date.now() - 125);
    await kernel.executePhase("turn_settle", { runId: "run-e2e-1", completed: true }, context);

    expect(executedPhases).toEqual([
      "turn_start",
      "context_resolve",
      "prompt_build",
      "model_select",
      "tools_register",
      "verification_check",
    ]);

    const snapshot = observer.snapshot();
    expect(snapshot.performance.sampledHookExecutionCount).toBeGreaterThanOrEqual(6);
    expect(snapshot.performance.averageHookDurationMs).toBeGreaterThan(0);
  });

  it("10.2 E2E Prompt Diffing & Cache Control: preserves static sections and isolates dynamic diffs", async () => {
    const context: HarnessContext = {
      sessionId: "session-prompt-e2e",
      runId: "run-prompt-1",
      mode: "build",
      state: new Map(),
      cwd: "C:/projects/test-app",
    };

    // First assembly
    const firstAssembly = await promptRegistry.assemble(context);
    expect(firstAssembly.systemBlocks.length).toBeGreaterThan(0);
    expect(firstAssembly.staticRatio).toBeGreaterThan(0.5);
    expect(firstAssembly.cacheablePrefix.length).toBeGreaterThan(0);
    expect(firstAssembly.changedSectionIds.length).toBeGreaterThanOrEqual(4);

    // Second assembly on the same session with same static sections
    const turn2Context: HarnessContext = {
      ...context,
      runId: "run-prompt-2",
    };

    const secondAssembly = await promptRegistry.assemble(turn2Context);
    // Static sections (persona, rules, skills, policy) did not change
    expect(secondAssembly.staticRatio).toBeGreaterThan(0.5);
    expect(secondAssembly.cacheablePrefix).toBe(firstAssembly.cacheablePrefix);
  });

  it("10.3 E2E Tool Result Spill & Retrieval: spills large output and provides transparent retrieval", async () => {
    const largeBashOutput =
      "Test run starting...\n" + "A".repeat(30 * 1024) + "\nTests complete: 15 passed.";
    const scope = {
      sessionId: "session-tool-e2e",
      runId: "run-tool-e2e",
      workspaceId: "workspace-tool-e2e",
    };
    const { database, storage } = createSpillTestStorage(scope);
    try {
      const interceptResult = interceptToolResult({
        ...scope,
        toolName: "bash",
        output: largeBashOutput,
        storage,
      });

      expect(interceptResult.spilled).toBe(true);
      expect(interceptResult.spillId).toBeDefined();
      expect(interceptResult.effectiveContent).toContain("[Large output spilled:");
      expect(interceptResult.effectiveContent).toContain("retrieve_spilled_tool_result");

      // Retrieve a bounded chunk through the same authorized session, run, and workspace.
      const retrieval = handleRetrieveSpilledToolResult(
        { spillId: interceptResult.spillId!, maxBytes: 32768 },
        scope,
        storage,
      );
      expect(retrieval.success).toBe(true);
      expect(retrieval.content).toBe(largeBashOutput);
    } finally {
      database.close();
    }
  });

  it("10.4 E2E Compaction & Intelligent Pruning: restores headroom and preserves QA evidence", () => {
    const messages: MessageLike[] = [
      { id: "m1", role: "user", content: "Implement feature X" },
      { id: "m2", role: "assistant", content: "Running tests..." },
      {
        id: "m3",
        role: "tool",
        toolName: "grep_search",
        content: "Ephemeral search logs query: auth\n" + "L".repeat(15000),
      },
      {
        id: "m4",
        role: "tool",
        toolName: "run_command",
        content: "Ephemeral status check\n" + "S".repeat(15000),
      },
      {
        id: "m5",
        role: "assistant",
        content: "Verification PASSED: all 12 tests passed and typecheck clean.",
      },
    ];

    const evidence: PreservedEvidence[] = [
      {
        id: "ev-1",
        category: "qa_check",
        timestamp: Date.now(),
        summary: "Unit Tests & Typecheck: passed",
      },
    ];

    const customPolicy = {
      modelId: "test-model-e2e",
      contextWindow: 10_000,
      outputReserve: 1_000,
      headroom: 1_000,
      thresholdRatio: 0.8, // trigger at 7,200 tokens
      targetRatioAfterPrune: 0.5, // target 4,500 tokens
      preserveCategories: ["qa_check" as const],
    };

    // Total tokens simulate 7,500 tokens (over 7,200 threshold)
    const result = compactionCoordinator.coordinate({
      sessionId: "session-compaction-e2e",
      currentTokens: 7500,
      messages,
      evidence,
      customPolicy,
    });

    // Pruning ephemeral messages m3 and m4 restores headroom!
    expect(result.shouldCancelCompaction).toBe(true);
    expect(result.reason).toBe("headroom_restored_via_pruning");
    expect(result.savedTokens).toBeGreaterThan(1000);
    expect(result.preservedEvidenceCount).toBe(1);
    expect(result.enhancedSummary).toContain("Unit Tests & Typecheck: passed");
  });

  it("10.5 E2E Subagent Provider Interface: spawns, checks status, waits, and harvests output", async () => {
    let mockChildCompleted = false;

    const nativeProvider = new ModusNativeSubagentProvider({
      spawnSubagent: async () => ({
        subagentId: "subagent-e2e-42",
        status: "spawned" as const,
      }),
      getSubagentStatus: async () => ({
        subagentId: "subagent-e2e-42",
        state: mockChildCompleted ? "completed" : "running",
      }),
      waitSubagent: async () => {
        mockChildCompleted = true;
        return {
          subagentId: "subagent-e2e-42",
          success: true,
          output: "Subagent completed task: database migration successful.",
        };
      },
      stopSubagent: async () => {},
    });

    subagentRegistry.registerProvider(nativeProvider);

    const provider = subagentRegistry.getProvider("modus-native");
    expect(provider).toBeDefined();

    const spawnResult = await provider!.spawn({
      role: "database_migrator",
      task: "Run knex migrations on isolated branch",
      isolation: "worktree",
    });
    expect(spawnResult.status).toBe("spawned");
    expect(spawnResult.subagentId).toBe("subagent-e2e-42");

    const statusBefore = await provider!.status(spawnResult.subagentId);
    expect(statusBefore.state).toBe("running");

    const waitResult = await provider!.wait(spawnResult.subagentId);
    expect(waitResult.success).toBe(true);
    expect(waitResult.output).toContain("database migration successful");

    const statusAfter = await provider!.status(spawnResult.subagentId);
    expect(statusAfter.state).toBe("completed");
  });

  it("10.6 E2E Response Policy & Deliverables: truncates verbosity while strictly preserving critical warnings", () => {
    responseRegistry.setSessionPolicy("session-resp-e2e", { level: "compact" });

    const verboseOutput = [
      "Here is an overview of the changes made.",
      "First, we refactored the database connection pool to handle timeouts better.",
      "Second, we updated the configuration parser to validate environment keys.",
      "Third, we wrote additional unit tests covering edge cases in payment retry.",
      "> [!WARNING]\n> Production database requires migration v2 before deploying this code!",
      "Fourth, we benchmarked the queries and observed a 15% latency improvement.",
      "Finally, the PR has been updated and is ready for code review.",
    ].join("\n\n");

    const deliverables: Deliverable[] = [
      { id: "del-1", type: "file_changed", label: "pool.ts", path: "src/db/pool.ts" },
    ];

    const formattedResult = responseFormatter.format({
      message: verboseOutput,
      policy: responseRegistry.getSessionPolicy("session-resp-e2e"),
      deliverables,
    });

    // Compact level permits minimal paragraphs
    // But it MUST strictly preserve the critical [!WARNING] block and the deliverables block!
    expect(formattedResult.response).toContain("Production database requires migration v2");
    expect(formattedResult.deliverablesSummary).toBe("*1 file(s) modified.*");
    expect(formattedResult.response).toContain("*1 file(s) modified.*");
    expect(formattedResult.response.length).toBeLessThan(verboseOutput.length);
  });

  it("10.7 E2E Fail-Open Resilience: non-critical hook exceptions never interrupt the user turn", async () => {
    const faultyHook: HarnessHook<any, any> = {
      name: "faulty_analytics_hook",
      phase: "prompt_build",
      priority: 10,
      isCritical: false,
      execute: async () => {
        throw new Error("Telemetry connection timed out!");
      },
    };

    kernel.registerHook(faultyHook);

    const context: HarnessContext = {
      sessionId: "session-fail-open",
      runId: "run-fail-open",
      cwd: "C:/projects/test-app",
      mode: "build",
      state: new Map(),
    };

    // Executing phase with non-critical hook throwing should resolve gracefully
    const phasePayload = { prompt: "Base prompt" };
    await expect(kernel.executePhase("prompt_build", phasePayload, context)).resolves.not.toThrow();

    // Verification check continues uninterrupted
    const verifRes = await kernel.executePhase(
      "verification_check",
      { status: "pending" },
      context,
    );
    expect(verifRes).toEqual({ status: "pending" });
  });
});
