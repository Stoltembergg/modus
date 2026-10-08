import { beforeEach, describe, expect, it } from "vitest";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "../feature-flags";
import { HarnessKernel } from "../kernel/harness-kernel";
import { toolsRegisterHook } from "../kernel/tools-hook";
import { handleRetrieveSpilledToolResult } from "./retrieve-spill-tool";
import {
  DEFAULT_TOOL_RESULT_POLICY,
  evaluateToolSpill,
  TOOL_SPECIFIC_POLICIES,
} from "./tool-result-policy";
import { generateSpillPreview } from "./tool-result-preview";
import { ToolResultStorage } from "./tool-result-storage";
import { interceptToolResult } from "./tool-spill-interceptor";

describe("Fase 3: ToolResultPolicy & Spill Storage", () => {
  beforeEach(() => {
    ToolResultStorage.resetInstance();
    resetFeatureFlagOverrides();
  });

  describe("3.1 Evaluation & Thresholds", () => {
    it("preserves small tool outputs below 20 KB inline without spilling", () => {
      const smallOutput = "Line 1: Build succeeded.\nLine 2: 0 errors, 0 warnings.\n";
      const evalResult = evaluateToolSpill("bash", smallOutput);

      expect(evalResult.shouldSpill).toBe(false);
      expect(evalResult.sizeBytes).toBeLessThan(DEFAULT_TOOL_RESULT_POLICY.spillThresholdBytes);
    });

    it("triggers spill when output exceeds 20 KB (byte limit)", () => {
      // 25 KB string
      const largeOutput = "A".repeat(25 * 1024);
      const evalResult = evaluateToolSpill("bash", largeOutput);

      expect(evalResult.shouldSpill).toBe(true);
      expect(evalResult.reason).toBe("byte_limit_exceeded");
      expect(evalResult.sizeBytes).toBe(25 * 1024);
    });

    it("triggers spill when line count exceeds maxInlineLines (300 lines)", () => {
      // 350 short lines (~3.5 KB, well below byte threshold)
      const manyLines = Array.from({ length: 350 }, (_, i) => `item #${i}`).join("\n");
      const evalResult = evaluateToolSpill("bash", manyLines);

      expect(evalResult.shouldSpill).toBe(true);
      expect(evalResult.reason).toBe("line_limit_exceeded");
      expect(evalResult.lineCount).toBe(350);
    });

    it("applies tool-specific policy overrides (e.g. browser_events threshold 10 KB)", () => {
      // 12 KB output: below default 20 KB, but above browser_events 10 KB
      const mediumOutput = "B".repeat(12 * 1024);

      const bashEval = evaluateToolSpill("bash", mediumOutput);
      expect(bashEval.shouldSpill).toBe(false);

      const browserEval = evaluateToolSpill("browser_events", mediumOutput);
      expect(browserEval.shouldSpill).toBe(true);
      expect(browserEval.policy.spillThresholdBytes).toBe(10 * 1024);
    });
  });

  describe("3.2 Spill Preview Generation", () => {
    it("generates line-oriented head + tail preview with omitted counts", () => {
      const storage = new ToolResultStorage();
      const lines = Array.from({ length: 200 }, (_, i) => `Log entry #${i + 1}`);
      const content = lines.join("\n");

      const spill = storage.spillResult({
        sessionId: "session-1",
        runId: "run-1",
        toolName: "terminal_run",
        content,
      });

      const preview = generateSpillPreview(spill, {
        ...DEFAULT_TOOL_RESULT_POLICY,
        previewHeadLines: 10,
        previewTailLines: 10,
      });

      expect(preview).toContain("Large output spilled:");
      expect(preview).toContain("first 10 lines");
      expect(preview).toContain("Log entry #1");
      expect(preview).toContain("Log entry #10");
      expect(preview).toContain("[... 180 lines omitted ...]");
      expect(preview).toContain("last 10 lines");
      expect(preview).toContain("Log entry #200");
      expect(preview).toContain(spill.id);
    });

    it("generates character-oriented preview for minified single-line outputs", () => {
      const storage = new ToolResultStorage();
      const bigJson = `{"data":"${"x".repeat(30000)}"}`;

      const spill = storage.spillResult({
        sessionId: "session-1",
        runId: "run-1",
        toolName: "web_fetch",
        content: bigJson,
      });

      const preview = generateSpillPreview(spill, {
        ...DEFAULT_TOOL_RESULT_POLICY,
        previewHeadChars: 50,
        previewTailChars: 50,
      });

      expect(preview).toContain("Large output spilled:");
      expect(preview).toContain("first 50 chars");
      expect(preview).toContain("last 50 chars");
      expect(preview).toContain("characters omitted");
      expect(preview).toContain(spill.id);
    });
  });

  describe("3.3 Storage and Retrieval", () => {
    it("persists spilled result with deterministic contentHash and line count", () => {
      const storage = new ToolResultStorage();
      const content = "Line A\nLine B\nLine C";

      const spill = storage.spillResult({
        sessionId: "session-abc",
        runId: "run-xyz",
        toolName: "grep",
        content,
      });

      expect(spill.id).toMatch(/^spill-/);
      expect(spill.contentHash).toBeDefined();
      expect(spill.sizeBytes).toBe(Buffer.byteLength(content, "utf8"));
      expect(spill.lineCount).toBe(3);

      const retrieved = storage.retrieveResult(spill.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.content).toBe(content);
      expect(retrieved?.totalLines).toBe(3);
    });

    it("supports windowed slicing with offsetLine and limitLines", () => {
      const storage = new ToolResultStorage();
      const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}`);
      const content = lines.join("\n");

      const spill = storage.spillResult({
        sessionId: "session-slice",
        runId: "run-1",
        toolName: "read",
        content,
      });

      // Retrieve lines 10 to 14 (5 lines)
      const sliced = storage.retrieveResult(spill.id, {
        offsetLine: 10,
        limitLines: 5,
      });

      expect(sliced).toBeDefined();
      expect(sliced?.linesReturned).toBe(5);
      expect(sliced?.offsetLine).toBe(10);
      expect(sliced?.hasMore).toBe(true);
      expect(sliced?.content).toBe("Line 10\nLine 11\nLine 12\nLine 13\nLine 14");
    });

    it("clears spills by session and run", () => {
      const storage = new ToolResultStorage();

      storage.spillResult({
        sessionId: "session-1",
        runId: "run-1",
        toolName: "bash",
        content: "output 1",
      });
      storage.spillResult({
        sessionId: "session-1",
        runId: "run-2",
        toolName: "bash",
        content: "output 2",
      });
      storage.spillResult({
        sessionId: "session-2",
        runId: "run-3",
        toolName: "bash",
        content: "output 3",
      });

      expect(storage.getSpillCount()).toBe(3);
      expect(storage.listSpills("session-1")).toHaveLength(2);

      // Clear run-1
      storage.clearRun("session-1", "run-1");
      expect(storage.listSpills("session-1")).toHaveLength(1);

      // Clear session-1
      storage.clearSession("session-1");
      expect(storage.listSpills("session-1")).toHaveLength(0);
      expect(storage.listSpills("session-2")).toHaveLength(1);
    });
  });

  describe("3.4 Interceptor Pipeline", () => {
    it("passes through output when MODUS_TOOL_RESULT_SPILL is disabled", () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_TOOL_RESULT_SPILL: false,
      });

      const hugeOutput = "X".repeat(50 * 1024); // 50 KB
      const intercept = interceptToolResult({
        sessionId: "session-test",
        runId: "run-1",
        toolName: "bash",
        output: hugeOutput,
      });

      expect(intercept.spilled).toBe(false);
      expect(intercept.effectiveContent).toBe(hugeOutput);
      expect(intercept.bytesSaved).toBe(0);
    });

    it("spills output when MODUS_TOOL_RESULT_SPILL is enabled, saving > 90% bytes", () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_TOOL_RESULT_SPILL: true,
      });

      const lines = Array.from({ length: 800 }, (_, i) => `Diagnostic line ${i}: All tests passed`);
      const hugeOutput = lines.join("\n"); // ~32 KB

      const intercept = interceptToolResult({
        sessionId: "session-test",
        runId: "run-1",
        toolName: "bash",
        output: hugeOutput,
      });

      expect(intercept.spilled).toBe(true);
      expect(intercept.spillId).toBeDefined();
      expect(intercept.effectiveContent).toContain("Large output spilled:");
      expect(intercept.effectiveContent).toContain("lines omitted");
      expect(intercept.bytesSaved).toBeGreaterThan(25 * 1024);
      expect(intercept.effectiveBytes).toBeLessThan(4 * 1024);
    });
  });

  describe("3.5 Retrieval Tool Handler", () => {
    it("handles retrieve_spilled_tool_result execution and error cases", () => {
      const storage = new ToolResultStorage();
      const content = Array.from({ length: 30 }, (_, i) => `Data ${i}`).join("\n");

      const spill = storage.spillResult({
        sessionId: "session-1",
        runId: "run-1",
        toolName: "read",
        content,
      });

      // Successful retrieval
      const res = handleRetrieveSpilledToolResult(
        {
          spillId: spill.id,
          offsetLine: 5,
          limitLines: 3,
        },
        storage,
      );

      expect(res.success).toBe(true);
      expect(res.content).toBe("Data 5\nData 6\nData 7");
      expect(res.totalLines).toBe(30);
      expect(res.hasMore).toBe(true);

      // Non-existent spillId
      const missingRes = handleRetrieveSpilledToolResult(
        { spillId: "spill-non-existent" },
        storage,
      );
      expect(missingRes.success).toBe(false);
      expect(missingRes.error).toContain("not found");
    });
  });

  describe("3.6 Kernel Tools Hook Integration", () => {
    it("registers spill policies and retrieve_spilled_tool_result when flag is active", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_TOOL_RESULT_SPILL: true,
      });

      const kernel = new HarnessKernel();
      kernel.registerHook(toolsRegisterHook);

      const ctx = {
        sessionId: "session-tools-hook",
        runId: "run-tools-1",
        cwd: "C:/app",
        mode: "build" as const,
        state: new Map<string, any>(),
      };

      const result = await kernel.executeHooks(
        "tools_register",
        {
          requestedTools: ["bash", "read", "browser_events"],
        },
        ctx,
      );

      // retrieve_spilled_tool_result must be auto-injected
      expect(result.enabledTools).toContain("retrieve_spilled_tool_result");

      // Verify tool-specific policy thresholds
      expect(result.spillPolicies?.bash?.spillThresholdBytes).toBe(20 * 1024);
      expect(result.spillPolicies?.browser_events?.spillThresholdBytes).toBe(10 * 1024);
      expect(result.spillPolicies?.read?.spillThresholdBytes).toBe(30 * 1024);
    });
  });
});
