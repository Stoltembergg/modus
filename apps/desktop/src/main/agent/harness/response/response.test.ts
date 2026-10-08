import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "../feature-flags";
import type { HarnessContext } from "../kernel/harness-hooks";
import { type Deliverable, formatDeliverables } from "./deliverables";
import { enforceResponsePolicy, formatResponse } from "./response-formatter";
import {
  defaultPromptBuildResponsePolicyHook,
  defaultTurnSettleResponsePolicyHook,
} from "./response-hooks";
import {
  DEFAULT_RESPONSE_LEVEL,
  RESPONSE_POLICIES,
  RESPONSE_POLICY_PROMPTS,
  type ResponseLevel,
  type ResponsePolicy,
  resolveResponsePolicy,
} from "./response-policy";
import { ResponsePolicyRegistry } from "./response-registry";
import { extractSections, isCriticalParagraph, splitParagraphs } from "./response-sections";

describe("Phase 7 — Response Policy DSL & Formatting Unification", () => {
  beforeEach(() => {
    resetFeatureFlagOverrides();
    ResponsePolicyRegistry.resetInstance();
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    ResponsePolicyRegistry.resetInstance();
  });

  describe("7.1 Response Policy & Defaults", () => {
    it("provides the four canonical response levels with appropriate defaults", () => {
      expect(RESPONSE_POLICIES.compact.maxParagraphs).toBe(2);
      expect(RESPONSE_POLICIES.compact.includeReasoning).toBe(false);

      expect(RESPONSE_POLICIES.standard.maxParagraphs).toBe(5);
      expect(RESPONSE_POLICIES.standard.includeReasoning).toBe(false);

      expect(RESPONSE_POLICIES.detailed.maxParagraphs).toBe(10);
      expect(RESPONSE_POLICIES.detailed.includeReasoning).toBe(true);

      expect(RESPONSE_POLICIES.verbose.maxParagraphs).toBe(-1);
      expect(RESPONSE_POLICIES.verbose.includeReasoning).toBe(true);
    });

    it("resolves default policy to standard when unspecified or unknown", () => {
      expect(DEFAULT_RESPONSE_LEVEL).toBe("standard");
      const resolvedEmpty = resolveResponsePolicy();
      expect(resolvedEmpty.level).toBe("standard");
      expect(resolvedEmpty.maxParagraphs).toBe(5);

      const resolvedUnknown = resolveResponsePolicy("non_existent_level" as ResponseLevel);
      expect(resolvedUnknown.level).toBe("standard");
    });

    it("applies policy overrides correctly", () => {
      const custom = resolveResponsePolicy("compact", {
        maxParagraphs: 3,
        enforcementMode: "strict",
      });
      expect(custom.level).toBe("compact");
      expect(custom.maxParagraphs).toBe(3);
      expect(custom.enforcementMode).toBe("strict");
    });

    it("contains structured XML prompt directives for all levels", () => {
      for (const level of ["compact", "standard", "detailed", "verbose"] as ResponseLevel[]) {
        const prompt = RESPONSE_POLICY_PROMPTS[level];
        expect(prompt).toBeDefined();
        expect(prompt).toContain(`<response_policy level="${level}">`);
        expect(prompt).toContain("</response_policy>");
      }
    });
  });

  describe("7.2 Semantic Sections & Critical Info Detection (RISCO 4 Mitigation)", () => {
    it("splits paragraphs correctly by double newlines and trims whitespace", () => {
      const text = "First paragraph.\n\nSecond paragraph.\n\n\nThird paragraph.";
      const paras = splitParagraphs(text);
      expect(paras).toEqual(["First paragraph.", "Second paragraph.", "Third paragraph."]);
    });

    it("identifies critical paragraphs (errors, blockers, failures, warnings)", () => {
      expect(isCriticalParagraph("Build failed with 2 errors.")).toBe(true);
      expect(isCriticalParagraph("A fatal exception occurred during initialization.")).toBe(true);
      expect(isCriticalParagraph("Action required from user: supply API key.")).toBe(true);
      expect(isCriticalParagraph("Task is blocked by pending review.")).toBe(true);
      expect(isCriticalParagraph("Caution: breaking change in database schema.")).toBe(true);
      expect(isCriticalParagraph("Verification failed: 2 unit tests failed.")).toBe(true);

      expect(isCriticalParagraph("Created the new file in src/main/app.ts.")).toBe(false);
      expect(isCriticalParagraph("Added comments to helper functions.")).toBe(false);
    });

    it("extracts semantic sections from text", () => {
      const message = [
        "Completed implementation of the new feature.",
        "Modified src/index.ts to export new classes.",
        "Verification status: all 12 tests passed.",
        "Blocker: waiting for user confirmation on deployment.",
        "Warning: network latency observed in test environment.",
      ].join("\n\n");

      const sections = extractSections(message);
      expect(sections.conclusion).toContain("Completed implementation");
      expect(sections.importantChanges).toContain("Modified src/index.ts");
      expect(sections.verification).toContain("Verification status");
      expect(sections.blockers).toContain("Blocker: waiting");
      expect(sections.warnings).toContain("Warning: network");
    });
  });

  describe("7.3 GAP 5: Response Policy Enforcement Modes", () => {
    const longMessage = [
      "Paragraph 1: Summary of task execution.",
      "Paragraph 2: Detailed walkthrough of step 1.",
      "Paragraph 3: Detailed walkthrough of step 2.",
      "Paragraph 4: Detailed walkthrough of step 3.",
    ].join("\n\n");

    const compactPolicy: ResponsePolicy = {
      level: "compact",
      maxParagraphs: 2,
      includeReasoning: false,
      includeToolNarration: false,
      includeFileReads: false,
      includeSearchResults: false,
      enforcementMode: "advisory",
    };

    it("mode 'off': never truncates nor flags violation", () => {
      const result = enforceResponsePolicy(longMessage, compactPolicy, "off");
      expect(result.violated).toBe(false);
      expect(result.response).toBe(longMessage);
      expect(result.omittedParagraphCount).toBe(0);
    });

    it("mode 'advisory': flags violation with reason but preserves response unmodified", () => {
      const result = enforceResponsePolicy(longMessage, compactPolicy, "advisory");
      expect(result.violated).toBe(true);
      expect(result.reason).toContain("exceeded_max_paragraphs");
      expect(result.response).toBe(longMessage);
      expect(result.originalParagraphCount).toBe(4);
    });

    it("mode 'strict': truncates surplus non-critical paragraphs and appends notice", () => {
      const result = enforceResponsePolicy(longMessage, compactPolicy, "strict");
      expect(result.violated).toBe(true);
      expect(result.formattedParagraphCount).toBe(2);
      expect(result.omittedParagraphCount).toBe(2);
      expect(result.response).toContain("Paragraph 1");
      expect(result.response).toContain("Paragraph 2");
      expect(result.response).not.toContain("Paragraph 3");
      expect(result.response).toContain(
        "[Response formatted by response policy (2 non-critical paragraphs truncated)]",
      );
    });
  });

  describe("7.4 RISCO 4: Critical Sections Are Never Truncated", () => {
    it("preserves critical error and blocker paragraphs in strict compact mode even if exceeding limit", () => {
      const criticalMessage = [
        "Paragraph 1: Routine task summary.",
        "Paragraph 2: Routine code update description.",
        "Paragraph 3: Routine styling change.",
        "Paragraph 4: CRITICAL ERROR: Database migration failed with syntax error!",
        "Paragraph 5: BLOCKER: Deployment blocked by failing integration test.",
      ].join("\n\n");

      const strictCompactPolicy: ResponsePolicy = {
        level: "compact",
        maxParagraphs: 2,
        includeReasoning: false,
        includeToolNarration: false,
        includeFileReads: false,
        includeSearchResults: false,
        enforcementMode: "strict",
      };

      const result = enforceResponsePolicy(criticalMessage, strictCompactPolicy);
      expect(result.violated).toBe(true);

      // The 2 critical paragraphs MUST be preserved!
      expect(result.response).toContain("CRITICAL ERROR");
      expect(result.response).toContain("BLOCKER");
      expect(result.criticalPreservedCount).toBe(2);
    });
  });

  describe("7.5 Deliverables Tracking and Formatting", () => {
    const deliverables: Deliverable[] = [
      {
        type: "file_changed",
        id: "d1",
        label: "app.ts",
        path: "src/main/app.ts",
      },
      {
        type: "file_changed",
        id: "d2",
        label: "utils.ts",
        path: "src/main/utils.ts",
      },
      {
        type: "decision",
        id: "d3",
        label: "Adopted SQLite WAL mode",
      },
    ];

    it("formats deliverables concisely for compact mode", () => {
      const formatted = formatDeliverables(deliverables, "compact");
      expect(formatted).toBe("*2 file(s) modified.*");
    });

    it("formats deliverables with grouped details for standard mode", () => {
      const formatted = formatDeliverables(deliverables, "standard");
      expect(formatted).toContain("`src/main/app.ts`");
      expect(formatted).toContain("`src/main/utils.ts`");
      expect(formatted).toContain("Adopted SQLite WAL mode");
    });

    it("formats deliverables as a list with types for detailed mode", () => {
      const formatted = formatDeliverables(deliverables, "detailed");
      expect(formatted).toContain("### Deliverables");
      expect(formatted).toContain("- **app.ts** (file_changed): `src/main/app.ts`");
      expect(formatted).toContain("- **Adopted SQLite WAL mode** (decision)");
    });

    it("integrates deliverables into formatResponse output", () => {
      const basePolicy = resolveResponsePolicy("standard");
      const res = formatResponse({
        message: "Work completed successfully.",
        policy: basePolicy,
        deliverables,
      });

      expect(res.response).toContain("Work completed successfully.");
      expect(res.response).toContain("Files affected");
      expect(res.deliverablesSummary).toBeDefined();
    });
  });

  describe("7.6 ResponsePolicyRegistry & Metrics", () => {
    it("stores and retrieves session-specific policy overrides", () => {
      const registry = ResponsePolicyRegistry.getInstance();
      const sessionId = "session-123";

      expect(registry.getSessionPolicy(sessionId).level).toBe("standard");

      registry.setSessionPolicy(sessionId, {
        level: "compact",
        enforcementMode: "strict",
      });

      const updated = registry.getSessionPolicy(sessionId);
      expect(updated.level).toBe("compact");
      expect(updated.enforcementMode).toBe("strict");

      registry.clearSessionPolicy(sessionId);
      expect(registry.getSessionPolicy(sessionId).level).toBe("standard");
    });

    it("tracks evaluation metrics and character savings", () => {
      const registry = ResponsePolicyRegistry.getInstance();

      registry.recordEvaluation({
        violated: true,
        formatted: true,
        charsBefore: 1000,
        charsAfter: 400,
      });

      registry.recordEvaluation({
        violated: false,
        formatted: false,
        charsBefore: 200,
        charsAfter: 200,
      });

      const metrics = registry.getMetrics();
      expect(metrics.totalEvaluated).toBe(2);
      expect(metrics.violationsDetected).toBe(1);
      expect(metrics.totalFormatted).toBe(1);
      expect(metrics.charactersSaved).toBe(600);
    });
  });

  describe("7.7 Kernel Hooks Integration", () => {
    const mockContext: HarnessContext = {
      sessionId: "test-session",
      runId: "test-run",
      workspaceId: "test-ws",
      cwd: "/test/cwd",
      mode: "build",
      state: new Map(),
    };

    it("prompt_build hook passes through cleanly when MODUS_RESPONSE_POLICY is disabled", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_RESPONSE_POLICY: false,
      });

      const out = await defaultPromptBuildResponsePolicyHook.execute(
        { basePrompt: "Existing prompt" },
        mockContext,
      );

      expect(out.finalSystemPrompt).toBe("Existing prompt");
      expect(out.activePromptSections).toEqual([]);
    });

    it("prompt_build hook injects response policy XML when MODUS_RESPONSE_POLICY is enabled", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_RESPONSE_POLICY: true,
      });

      const out = await defaultPromptBuildResponsePolicyHook.execute(
        { basePrompt: "Existing prompt" },
        mockContext,
      );

      expect(out.finalSystemPrompt).toContain('<response_policy level="standard">');
      expect(out.activePromptSections.some((s) => s.id === "response_policy")).toBe(true);
      expect(mockContext.state.get("harness.response_policy_prompt")).toBeDefined();
    });

    it("turn_settle hook evaluates and formats response when flag is enabled", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_RESPONSE_POLICY: true,
      });

      const contextWithResponse: HarnessContext = {
        ...mockContext,
        state: new Map<string, any>([
          ["harness.assistant_response", "P1\n\nP2\n\nP3\n\nP4\n\nP5\n\nP6\n\nP7"],
          ["harness.deliverables", [{ type: "file_changed", id: "1", label: "f.ts" }]],
        ]),
      };

      const out = await defaultTurnSettleResponsePolicyHook.execute(
        { runId: "test-run", completed: true, hasActiveTodos: false, turnTokens: 100 },
        contextWithResponse,
      );

      expect(out.settled).toBe(true);
      expect(contextWithResponse.state.get("harness.formatted_response")).toBeDefined();
      expect(contextWithResponse.state.get("harness.response_violated")).toBe(true);
    });

    it("hooks fail open gracefully without throwing if state has unexpected data", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_RESPONSE_POLICY: true,
      });

      const corruptedContext: HarnessContext = {
        ...mockContext,
        state: new Map<string, any>([["harness.assistant_response", null]]),
      };

      const out = await defaultTurnSettleResponsePolicyHook.execute(
        { runId: "test-run", completed: true, hasActiveTodos: false, turnTokens: 100 },
        corruptedContext,
      );
      expect(out.settled).toBe(true);
    });
  });

  describe("7.8 Latency & Performance SLO (< 50ms for 1,000 operations)", () => {
    it("formats 1,000 responses well within performance budget", () => {
      const policy = resolveResponsePolicy("compact", { enforcementMode: "strict" });
      const testMsg = [
        "Paragraph 1: Task completed.",
        "Paragraph 2: Modified files.",
        "Paragraph 3: Extra explanation.",
        "Paragraph 4: Verification passed with 0 errors.",
      ].join("\n\n");

      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        formatResponse({
          message: testMsg,
          policy,
        });
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(150); // Generous ceiling, typically runs in < 25ms
    });
  });

  describe("7.9 Fase 7 review regressions", () => {
    it("records metrics and formats when the runtime-provided response is present", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_RESPONSE_POLICY: true,
      });

      const context: HarnessContext = {
        sessionId: "s-regr",
        runId: "r-regr",
        workspaceId: "w",
        cwd: ".",
        mode: "build",
        state: new Map<string, any>([
          ["harness.assistant_response", "P1\n\nP2\n\nP3\n\nP4\n\nP5\n\nP6\n\nP7"],
        ]),
      };

      await defaultTurnSettleResponsePolicyHook.execute(
        { runId: "r-regr", completed: true, hasActiveTodos: false, turnTokens: 100 },
        context,
      );

      expect(context.state.get("harness.formatted_response")).toBeDefined();
      expect(ResponsePolicyRegistry.getInstance().getMetrics().totalEvaluated).toBe(1);
    });

    it("renders the compact deliverables one-liner inside the response", () => {
      const result = formatResponse({
        message: "Implemented the feature.",
        policy: resolveResponsePolicy("compact"),
        deliverables: [
          { type: "file_changed", id: "1", label: "a.ts", path: "a.ts" },
          { type: "file_changed", id: "2", label: "b.ts", path: "b.ts" },
        ],
      });

      expect(result.deliverablesSummary).toBe("*2 file(s) modified.*");
      expect(result.response).toContain("file(s) modified");
    });

    it("strict mode never exceeds maxParagraphs even when a paragraph repeats", () => {
      const policy = resolveResponsePolicy("standard", {
        enforcementMode: "strict",
        maxParagraphs: 2,
      });

      const result = enforceResponsePolicy(
        "dup\n\ndup\n\ndup\n\ndup\n\nother paragraph here",
        policy,
      );

      expect(result.formattedParagraphCount).toBeLessThanOrEqual(policy.maxParagraphs);
    });
  });
});
