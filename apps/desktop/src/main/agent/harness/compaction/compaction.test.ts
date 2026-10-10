import { beforeEach, describe, expect, it } from "vitest";
import { createModusCompactionExtension } from "../../pi-compaction-extension";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "../feature-flags";
import { HarnessKernel } from "../kernel/harness-kernel";
import { HarnessObserver } from "../observability/harness-observer";
import { compactionTelemetry, coordinateCompaction } from "./compaction-coordinator";
import { defaultCompactionHook } from "./compaction-hook";
import {
  calculateCompactionMetrics,
  DEFAULT_COMPACTION_POLICIES,
  FALLBACK_COMPACTION_POLICY,
  getCompactionPolicy,
} from "./compaction-policy";
import {
  estimateTokens,
  identifyPruneCandidates,
  type MessageLike,
  pruneCandidates,
} from "./compaction-pruner";
import {
  filterPreservedEvidence,
  formatPreservedEvidenceMarkdown,
  type PreservedEvidence,
} from "./evidence-preservation";

describe("Phase 4: Compaction com Pruning Inteligente", () => {
  beforeEach(() => {
    resetFeatureFlagOverrides();
    compactionTelemetry.reset();
  });

  describe("4.1 Compaction Policy Engine", () => {
    it("resolves specific model policies correctly", () => {
      const opusPolicy = getCompactionPolicy("claude-opus-5");
      expect(opusPolicy.contextWindow).toBe(200_000);
      expect(opusPolicy.outputReserve).toBe(16_000);
      expect(opusPolicy.thresholdRatio).toBe(0.85);

      const sonnetPolicy = getCompactionPolicy("claude-sonnet-4-5-20250921");
      expect(sonnetPolicy.modelId).toContain("claude-sonnet-4-5");
      expect(sonnetPolicy.contextWindow).toBe(200_000);
      expect(sonnetPolicy.thresholdRatio).toBe(0.8);

      const deepseekPolicy = getCompactionPolicy("deepseek-chat");
      expect(deepseekPolicy.contextWindow).toBe(64_000);
      expect(deepseekPolicy.thresholdRatio).toBe(0.75);
    });

    it("falls back to sensible defaults when model is unknown or empty", () => {
      const emptyPolicy = getCompactionPolicy();
      expect(emptyPolicy).toEqual(FALLBACK_COMPACTION_POLICY);

      const unknownPolicy = getCompactionPolicy("unknown-experimental-model-v9");
      expect(unknownPolicy.contextWindow).toBe(FALLBACK_COMPACTION_POLICY.contextWindow);
      expect(unknownPolicy.modelId).toBe("unknown-experimental-model-v9");
    });

    it("honors the model's declared context window over table and fallback values", () => {
      // Model absent from the table with a declared window (e.g. 1M-token models).
      const wideUnknown = getCompactionPolicy("antigravity-gemini-3-pro", 1_048_576);
      expect(wideUnknown.contextWindow).toBe(1_048_576);

      // Declared window wins over a stale table entry.
      const overridden = getCompactionPolicy("deepseek-chat", 32_000);
      expect(overridden.contextWindow).toBe(32_000);

      // Missing / nonsensical declarations keep the resolved policy value.
      expect(getCompactionPolicy("deepseek-chat").contextWindow).toBe(64_000);
      expect(getCompactionPolicy("deepseek-chat", 0).contextWindow).toBe(64_000);
      expect(getCompactionPolicy("deepseek-chat", Number.NaN).contextWindow).toBe(64_000);
    });

    it("calculates compaction metrics and headroom accurately", () => {
      const policy = DEFAULT_COMPACTION_POLICIES["claude-sonnet-4-5"]!;
      // effectiveCapacity = 200k - 8k = 192k
      // triggerThreshold = 192k * 0.80 = 153.6k
      // targetRatioAfterPrune = 192k * 0.65 = 124.8k

      const underLoad = calculateCompactionMetrics(policy, 100_000);
      expect(underLoad.isOverThreshold).toBe(false);
      expect(underLoad.tokensToPrune).toBe(0);
      expect(underLoad.remainingHeadroom).toBe(92_000);

      const overLoad = calculateCompactionMetrics(policy, 160_000);
      expect(overLoad.isOverThreshold).toBe(true);
      expect(overLoad.tokensToPrune).toBe(160_000 - 124_800); // 35,200 tokens
      expect(overLoad.remainingHeadroom).toBe(32_000);
    });
  });

  describe("4.2 Evidence Preservation Engine", () => {
    const mockEvidence: PreservedEvidence[] = [
      {
        id: "qa-1",
        category: "qa_check",
        timestamp: 1000,
        summary: "Unit tests passed (45/45)",
        details: { status: "passed", kind: "tests" },
      },
      {
        id: "plan-1",
        category: "plan_acceptance",
        timestamp: 2000,
        summary: "Criterion AC-1 accepted: HarnessKernel hook resolution",
        details: { requiredCheckKinds: ["tests", "typecheck"] },
      },
      {
        id: "user-1",
        category: "user_confirmation",
        timestamp: 3000,
        summary: "User cleared deletion of temp test fixtures",
      },
      {
        id: "dec-1",
        category: "harness_decision",
        timestamp: 4000,
        summary: "Promoted to Spec Mode",
      },
      {
        id: "fail-1",
        category: "failure_attempt",
        timestamp: 5000,
        summary: "Command timeout on integration test #2",
      },
    ];

    it("filters evidence by category and enforces retention limits", () => {
      const filtered = filterPreservedEvidence(mockEvidence, ["qa_check", "plan_acceptance"]);
      expect(filtered).toHaveLength(2);
      expect(filtered.map((e) => e.category)).toEqual(["qa_check", "plan_acceptance"]);
    });

    it("formats preserved evidence into clean markdown with proper headers", () => {
      const markdown = formatPreservedEvidenceMarkdown(mockEvidence);
      expect(markdown).toContain("### Preserved Harness Evidence (Pre-Compaction Integrity)");
      expect(markdown).toContain("#### QA Checks & Verification Results:");
      expect(markdown).toContain("Unit tests passed (45/45)");
      expect(markdown).toContain("#### Plan & Specifications Accepted:");
      expect(markdown).toContain("Criterion AC-1 accepted");
      expect(markdown).toContain("#### User Confirmations & Clearances:");
      expect(markdown).toContain("User cleared deletion of temp test fixtures");
    });

    it("returns empty string if no evidence is passed", () => {
      expect(formatPreservedEvidenceMarkdown([])).toBe("");
    });
  });

  describe("4.3 Turn Pruner Engine", () => {
    const mockMessages: MessageLike[] = [
      {
        id: "msg-1",
        role: "user",
        content: "Fix the bug in src/auth.ts and run tests",
        timestamp: 1000,
      },
      {
        id: "msg-2",
        role: "tool",
        toolName: "grep_search",
        content: "query: auth\n" + "match line 1...\n".repeat(200), // ~3200 bytes
        timestamp: 2000,
      },
      {
        id: "msg-3",
        role: "tool",
        toolName: "view_file",
        content: "path: src/auth.ts\n" + "export function auth() { ... }\n".repeat(100), // ~3000 bytes
        timestamp: 3000,
      },
      {
        id: "msg-4",
        role: "tool",
        toolName: "run_command",
        content: "command: npm test\n" + "TAP version 13\n" + "ok 1 - test\n".repeat(150), // ~2500 bytes
        timestamp: 4000,
      },
      {
        id: "msg-5",
        role: "tool",
        toolName: "view_file",
        content: "path: src/auth.ts\n" + "export function auth() { /* updated */ }\n".repeat(100),
        timestamp: 5000,
      },
      {
        id: "msg-6",
        role: "assistant",
        content: "All tests now pass!",
        timestamp: 6000,
      },
    ];

    it("estimates tokens based on ~4 chars per token", () => {
      expect(estimateTokens("")).toBe(0);
      expect(estimateTokens("1234")).toBe(1);
      expect(estimateTokens("12345678")).toBe(2);
      expect(estimateTokens("hello world")).toBe(3);
    });

    it("identifies prune candidates and flags superseded items", () => {
      const candidates = identifyPruneCandidates(mockMessages, { minCandidateBytes: 500 });
      expect(candidates.length).toBeGreaterThanOrEqual(3);

      const searchCandidate = candidates.find((c) => c.type === "search");
      expect(searchCandidate).toBeDefined();
      expect(searchCandidate?.superseded).toBe(true);

      // Earlier read of src/auth.ts (msg-3) was superseded by later read (msg-5)
      const readCandidate = candidates.find((c) => c.id === "msg-3");
      expect(readCandidate).toBeDefined();
      expect(readCandidate?.superseded).toBe(true);
    });

    it("prunes candidates prioritizing search, logs, and superseded reads", () => {
      const candidates = identifyPruneCandidates(mockMessages, { minCandidateBytes: 500 });
      const targetTokens = 1000;
      const result = pruneCandidates(candidates, targetTokens);

      expect(result.prunedIds.length).toBeGreaterThan(0);
      expect(result.savedTokens).toBeGreaterThanOrEqual(targetTokens);
      expect(result.savedBytes).toBeGreaterThan(0);

      // Replacements should contain concise tombstone references
      for (const [_, tombstone] of result.replacements.entries()) {
        expect(tombstone).toContain("[Pruned superseded");
        expect(tombstone).toContain("Raw content retained in session storage");
      }
    });

    it("respects neverPrunePaths", () => {
      const candidates = identifyPruneCandidates(mockMessages, {
        minCandidateBytes: 500,
        neverPrunePaths: ["src/auth.ts"],
      });
      const authCandidates = candidates.filter((c) => c.path === "src/auth.ts");
      expect(authCandidates).toHaveLength(0);
    });

    it("never prunes user or assistant messages, even when large", () => {
      const messages: MessageLike[] = [
        {
          id: "u1",
          role: "user",
          content: "Please refactor the module carefully. ".repeat(40),
          timestamp: 1000,
        },
        {
          id: "a1",
          role: "assistant",
          content: "Here is my analysis of the change. ".repeat(40),
          timestamp: 2000,
        },
        {
          id: "t1",
          role: "tool",
          toolName: "grep_search",
          content: "query: auth\n" + "match line...\n".repeat(80),
          timestamp: 3000,
        },
      ];

      const candidates = identifyPruneCandidates(messages, { minCandidateBytes: 500 });
      expect(candidates.map((c) => c.id)).toEqual(["t1"]);
    });
  });

  describe("4.4 Compaction Coordinator", () => {
    const mockMessages: MessageLike[] = [
      {
        id: "msg-1",
        role: "user",
        content: "Investigate performance bottleneck",
        timestamp: 1000,
      },
      {
        id: "msg-2",
        role: "tool",
        toolName: "grep_search",
        content: "query: bottleneck\n" + "trace dump line...\n".repeat(500), // ~10k bytes, ~2.5k tokens
        timestamp: 2000,
      },
      {
        id: "msg-3",
        role: "tool",
        toolName: "run_command",
        content: "command: npm run bench\n" + "benchmark output row...\n".repeat(600), // ~15k bytes, ~3.75k tokens
        timestamp: 3000,
      },
      {
        id: "msg-4",
        role: "assistant",
        content: "Found bottleneck in worker thread",
        timestamp: 4000,
      },
      {
        id: "msg-5",
        role: "user",
        content: "Next step",
        timestamp: 5000,
      },
    ];

    it("cancels compaction when session is under threshold", () => {
      const result = coordinateCompaction({
        sessionId: "test-session",
        modelId: "claude-sonnet-4-5",
        currentTokens: 50_000, // well under 153.6k threshold
        messages: mockMessages,
      });

      expect(result.shouldCancelCompaction).toBe(true);
      expect(result.reason).toBe("under_threshold");
      expect(result.savedTokens).toBe(0);
      expect(result.prunedCount).toBe(0);
    });

    it("restores headroom and cancels compaction if pruning drops below threshold", () => {
      // Custom low policy to simulate threshold breach
      const customPolicy = {
        modelId: "test-model",
        contextWindow: 10_000,
        outputReserve: 1_000,
        headroom: 1_000,
        thresholdRatio: 0.8, // trigger at 7,200 tokens
        targetRatioAfterPrune: 0.5, // target 4,500 tokens
        preserveCategories: ["qa_check" as const],
      };

      // Current tokens = 7,500 (over 7,200 threshold)
      // Pruning msg-2 and msg-3 saves ~6k tokens, dropping load to ~1,500
      const result = coordinateCompaction({
        sessionId: "test-session",
        currentTokens: 7_500,
        messages: mockMessages,
        customPolicy,
      });

      expect(result.shouldCancelCompaction).toBe(true);
      expect(result.reason).toBe("headroom_restored_via_pruning");
      expect(result.savedTokens).toBeGreaterThan(0);
      expect(result.prunedCount).toBeGreaterThan(0);
      expect(result.remainingTokens).toBeLessThan(
        customPolicy.contextWindow * customPolicy.thresholdRatio,
      );
    });

    it("requires compaction and enhances summary with preserved evidence if still above threshold", () => {
      const customPolicy = {
        modelId: "test-model-tight",
        contextWindow: 10_000,
        outputReserve: 1_000,
        headroom: 1_000,
        thresholdRatio: 0.5, // trigger at 4,500
        targetRatioAfterPrune: 0.3,
        preserveCategories: ["qa_check" as const, "plan_acceptance" as const],
      };

      const evidence: PreservedEvidence[] = [
        {
          id: "qa-1",
          category: "qa_check",
          timestamp: Date.now(),
          summary: "Core regression suite passed (100%)",
        },
      ];

      // Very high token load (50,000) that pruning alone cannot bring under 4,500
      const result = coordinateCompaction({
        sessionId: "test-session",
        currentTokens: 50_000,
        messages: mockMessages,
        customPolicy,
        evidence,
        baseSummary: "Previous session context.",
      });

      expect(result.shouldCancelCompaction).toBe(false);
      expect(result.reason).toBe("compaction_required");
      expect(result.enhancedSummary).toBeDefined();
      expect(result.enhancedSummary).toContain("Previous session context.");
      expect(result.enhancedSummary).toContain("Preserved Harness Evidence");
      expect(result.enhancedSummary).toContain("Core regression suite passed");
      expect(result.preservedEvidenceCount).toBe(1);
    });

    it("tracks compaction telemetry metrics", () => {
      const snapshotBefore = compactionTelemetry.getSnapshot();
      expect(snapshotBefore.totalEvaluations).toBe(0);

      coordinateCompaction({
        sessionId: "test-session",
        modelId: "claude-sonnet-4-5",
        currentTokens: 50_000,
        messages: mockMessages,
      });

      const snapshotAfter = compactionTelemetry.getSnapshot();
      expect(snapshotAfter.totalEvaluations).toBe(1);
      expect(snapshotAfter.compactionsCanceled).toBe(1);
    });
  });

  describe("4.5 Kernel Hook Integration", () => {
    it("executes defaultCompactionHook within HarnessKernel", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_COMPACTION_PRUNING: true,
      });

      const kernel = new HarnessKernel();
      kernel.registerHook(defaultCompactionHook);

      const hooks = kernel.getHooksForPhase("compact_prune");
      expect(hooks).toHaveLength(1);
      expect(hooks[0]!.name).toBe("harness_compaction_prune");

      const output = await kernel.executePhase(
        "compact_prune",
        {
          currentTokens: 50_000,
          messages: [],
          modelId: "claude-sonnet-4-5",
        },
        {
          sessionId: "test-kernel-session",
          runId: "run-kernel-1",
          mode: "build",
          state: new Map(),
        },
      );

      expect(output.shouldCancelCompaction).toBe(true);
      expect(output.reason).toBe("under_threshold");
    });
  });

  describe("4.6 PI SDK Compaction Extension", () => {
    function captureHandlers() {
      const handlers = new Map<string, (event: never, context: never) => unknown>();
      const on = (event: string, handler: unknown): void => {
        handlers.set(event, handler as (event: never, context: never) => unknown);
      };
      return { handlers, on };
    }

    it("returns undefined when MODUS_COMPACTION_PRUNING is disabled", async () => {
      setFeatureFlagOverrides({
        MODUS_COMPACTION_PRUNING: false,
      });

      const { handlers, on } = captureHandlers();
      createModusCompactionExtension(() => undefined)({ on } as never);

      expect([...handlers.keys()]).toEqual(["context"]);
      expect(
        handlers.get("context")?.(
          { type: "context", messages: [] } as never,
          {
            signal: undefined,
            getContextUsage: () => undefined,
            model: undefined,
          } as never,
        ),
      ).toBeUndefined();
    });

    it("leaves manual, threshold, and overflow compaction to the Pi SDK", () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_COMPACTION_PRUNING: true,
      });

      const { handlers, on } = captureHandlers();
      createModusCompactionExtension(() => undefined)({ on } as never);

      // Pi sends manual, threshold, automatic, and overflow compaction through
      // session_before_compact. Leaving that hook unregistered delegates every
      // reason to the SDK without intercepting or cancelling it.
      expect([...handlers.keys()]).toEqual(["context"]);
    });

    it("does not register compaction cancellation when the context exceeds the model window", () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_COMPACTION_PRUNING: true,
      });

      const { handlers, on } = captureHandlers();
      createModusCompactionExtension(() => undefined)({ on } as never);
      expect(handlers.has("session_before_compact")).toBe(false);
      expect([...handlers.keys()]).toEqual(["context"]);
    });

    it("keeps Pi's native summary generation available when compaction is required", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_COMPACTION_PRUNING: true,
      });

      const { handlers, on } = captureHandlers();
      createModusCompactionExtension(() => undefined)({ on } as never);
      expect(handlers.has("session_before_compact")).toBe(false);
      expect([...handlers.keys()]).toEqual(["context"]);
    });

    it("applies context hook pruning non-destructively for LLM requests", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_COMPACTION_PRUNING: true,
        MODUS_OBSERVABILITY: true,
      });

      const sessionId = "sess-ctx";
      const observer = HarnessObserver.getInstance();
      const observerSessionToken = observer.beginSession(sessionId);
      const { handlers, on } = captureHandlers();
      createModusCompactionExtension(() => ({
        sessionId,
        runId: "run-ctx",
        observerSessionToken,
      }))({ on } as never);
      const messages = [
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "read-first",
          isError: false,
          content: [{ type: "text", text: "stable read result\n".repeat(200) }],
        },
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "read-later",
          isError: false,
          content: [{ type: "text", text: "stable read result\n".repeat(200) }],
        },
      ];

      const originalText = (messages[0]?.content as Array<{ text: string }>)[0]?.text;
      const result = await handlers.get("context")?.(
        { type: "context", messages } as never,
        {
          signal: undefined,
          model: { id: "deepseek-chat", contextWindow: 64_000 },
          getContextUsage: () => ({ tokens: 55_000, contextWindow: 64_000, percent: 85 }),
        } as never,
      );

      expect(result).toBeDefined();
      const resultMessages = (result as { messages: typeof messages }).messages;
      expect(resultMessages).toHaveLength(2);
      expect(resultMessages[0]?.content[0]?.text).toMatch(/identical later result/i);
      expect(resultMessages[1]?.content[0]?.text).toBe(originalText);
      expect(messages[0]?.content[0]?.text).toBe(originalText);
      expect(observer.getRecentEvents().at(-1)?.data).toMatchObject({
        measuredContextBytesRemoved: expect.any(Number),
        estimatedTokensSaved: expect.any(Number),
      });
    });
  });
});
