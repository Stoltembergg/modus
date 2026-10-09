import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../../../db/database";
import { createModusToolSpillHandler } from "../../pi-tool-spill-extension";
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
import {
  TOOL_RESULT_SPILL_LIMITS,
  ToolResultStorage,
  ToolResultStorageError,
} from "./tool-result-storage";
import { interceptToolResult } from "./tool-spill-interceptor";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/modus-spill-storage-test" } }));

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
migrateDatabase(database);

function seedScope(
  sessionId: string,
  runId: string,
  workspaceId: string,
  db: DatabaseSync = database,
): void {
  if (!db.prepare("select 1 from workspaces where id = ?").get(workspaceId)) {
    const now = new Date().toISOString();
    db.prepare(
      `insert into workspaces
          (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
         values (?, ?, 'spill test', 0, ?, ?)`,
    ).run(workspaceId, `/spill-test/${workspaceId}`, now, now);
  }
  if (!db.prepare("select 1 from agent_sessions where id = ?").get(sessionId)) {
    const now = new Date().toISOString();
    db.prepare(
      `insert into agent_sessions
          (id, workspace_id, title, cwd, status, created_at, updated_at)
         values (?, ?, 'spill test', '/spill-test', 'running', ?, ?)`,
    ).run(sessionId, workspaceId, now, now);
  }
  if (!db.prepare("select 1 from agent_runs where id = ?").get(runId)) {
    db.prepare(
      `insert into agent_runs (id, session_id, prompt, status, started_at)
         values (?, ?, 'spill test', 'running', ?)`,
    ).run(runId, sessionId, new Date().toISOString());
  }
}

function storeSpill(
  storage: ToolResultStorage,
  input: {
    sessionId?: string;
    runId?: string;
    workspaceId?: string;
    toolName: string;
    content: string;
    spillReason?: "byte_limit_exceeded" | "line_limit_exceeded";
    isError?: boolean;
  },
) {
  const sessionId = input.sessionId ?? "session-1";
  const runId = input.runId ?? "run-1";
  const workspaceId = input.workspaceId ?? "workspace-1";
  seedScope(sessionId, runId, workspaceId);
  return storage.spillResult({
    ...input,
    sessionId,
    runId,
    workspaceId,
    spillReason: input.spillReason ?? "byte_limit_exceeded",
  });
}

const authorizedScope = {
  sessionId: "session-1",
  runId: "run-1",
  workspaceId: "workspace-1",
};

describe("Fase 3: ToolResultPolicy & Spill Storage", () => {
  beforeEach(() => {
    ToolResultStorage.resetInstance();
    database.exec(
      "delete from tool_result_spills; delete from agent_runs; delete from agent_sessions; delete from workspaces",
    );
    seedScope("session-1", "run-1", "workspace-1");
    resetFeatureFlagOverrides();
  });

  afterAll(() => database.close());

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
      const storage = new ToolResultStorage({ database });
      const lines = Array.from({ length: 200 }, (_, i) => `Log entry #${i + 1}`);
      const content = lines.join("\n");

      const spill = storeSpill(storage, {
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
      const storage = new ToolResultStorage({ database });
      const bigJson = `{"data":"${"x".repeat(30000)}"}`;

      const spill = storeSpill(storage, {
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
      const storage = new ToolResultStorage({ database });
      const content = "Line A\nLine B\nLine C";

      const scope = { sessionId: "session-abc", runId: "run-xyz", workspaceId: "workspace-abc" };
      const spill = storeSpill(storage, {
        ...scope,
        toolName: "grep",
        content,
      });

      expect(spill.id).toMatch(/^spill-/);
      expect(spill.contentHash).toBeDefined();
      expect(spill.sizeBytes).toBe(Buffer.byteLength(content, "utf8"));
      expect(spill.lineCount).toBe(3);

      const retrieved = storage.retrieveResult(spill.id, scope);
      expect(retrieved).toBeDefined();
      expect(retrieved?.content).toBe(content);
      expect(retrieved?.totalLines).toBe(3);
    });

    it("supports windowed slicing with offsetLine and limitLines", () => {
      const storage = new ToolResultStorage({ database });
      const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}`);
      const content = lines.join("\n");

      const scope = {
        sessionId: "session-slice",
        runId: "run-slice",
        workspaceId: "workspace-slice",
      };
      const spill = storeSpill(storage, {
        ...scope,
        toolName: "read",
        content,
      });

      // Retrieve lines 10 to 14 (5 lines)
      const sliced = storage.retrieveResult(spill.id, scope, {
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
      const storage = new ToolResultStorage({ database });

      storeSpill(storage, {
        toolName: "bash",
        content: "output 1",
      });
      storeSpill(storage, {
        sessionId: "session-1",
        runId: "run-2",
        workspaceId: "workspace-1",
        toolName: "bash",
        content: "output 2",
      });
      storeSpill(storage, {
        sessionId: "session-2",
        runId: "run-3",
        workspaceId: "workspace-2",
        toolName: "bash",
        content: "output 3",
      });

      expect(storage.getSpillCount()).toBe(3);
      expect(storage.listSpills(authorizedScope)).toHaveLength(2);

      // Clear run-1
      storage.clearRun("session-1", "run-1");
      expect(storage.listSpills(authorizedScope)).toHaveLength(1);

      // Clear session-1
      storage.clearSession("session-1");
      expect(storage.listSpills(authorizedScope)).toHaveLength(0);
      expect(
        storage.listSpills({ sessionId: "session-2", runId: "run-3", workspaceId: "workspace-2" }),
      ).toHaveLength(1);
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
        workspaceId: "workspace-test",
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

      seedScope("session-test", "run-1", "workspace-test");
      const storage = new ToolResultStorage({ database });
      const intercept = interceptToolResult({
        sessionId: "session-test",
        runId: "run-1",
        workspaceId: "workspace-test",
        toolName: "bash",
        output: hugeOutput,
        storage,
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
      const storage = new ToolResultStorage({ database });
      const content = Array.from({ length: 30 }, (_, i) => `Data ${i}`).join("\n");

      const spill = storeSpill(storage, {
        ...authorizedScope,
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
        authorizedScope,
        storage,
      );

      expect(res.success).toBe(true);
      expect(res.content).toBe("Data 5\nData 6\nData 7");
      expect(res.totalLines).toBe(30);
      expect(res.hasMore).toBe(true);

      // Non-existent spillId
      const missingRes = handleRetrieveSpilledToolResult(
        { spillId: "spill-non-existent" },
        authorizedScope,
        storage,
      );
      expect(missingRes.success).toBe(false);
      expect(missingRes.error).toContain("not available");
    });
  });

  describe("3.5a durable authorization and bounded recovery", () => {
    it("recovers prior runs only inside the host-authorized session and workspace", () => {
      const storage = new ToolResultStorage({ database });
      const record = storeSpill(storage, {
        ...authorizedScope,
        toolName: "read",
        content: "same-session prior run result",
      });
      seedScope("group-member-2", "group-member-run", "workspace-1");

      const sameSessionNextRun = { ...authorizedScope, runId: "run-next" };
      seedScope(
        sameSessionNextRun.sessionId,
        sameSessionNextRun.runId,
        sameSessionNextRun.workspaceId,
      );
      const allowed = handleRetrieveSpilledToolResult(
        { spillId: record.id },
        sameSessionNextRun,
        storage,
      );
      expect(allowed.success).toBe(true);
      expect(allowed.content).toBe("same-session prior run result");

      const modelSuppliedIdentity = Object.assign(
        { spillId: record.id },
        {
          sessionId: authorizedScope.sessionId,
          runId: authorizedScope.runId,
          workspaceId: "workspace-1",
        },
      );
      const deniedMember = handleRetrieveSpilledToolResult(
        modelSuppliedIdentity,
        { sessionId: "group-member-2", runId: "group-member-run", workspaceId: "workspace-1" },
        storage,
      );
      expect(deniedMember.success).toBe(false);
      expect(deniedMember.content).toBeUndefined();

      const deniedWorkspace = handleRetrieveSpilledToolResult(
        { spillId: record.id },
        { ...sameSessionNextRun, workspaceId: "workspace-other" },
        storage,
      );
      expect(deniedWorkspace.success).toBe(false);

      const deniedUnknownRun = handleRetrieveSpilledToolResult(
        { spillId: record.id },
        { ...sameSessionNextRun, runId: "unregistered-run" },
        storage,
      );
      expect(deniedUnknownRun.success).toBe(false);
    });

    it("isolates concurrent sessions sharing one Agent Group workspace", () => {
      const storage = new ToolResultStorage({ database });
      seedScope("group-owner", "group-owner-run", "group-workspace");
      seedScope("group-reviewer", "group-reviewer-run", "group-workspace");
      const ownerScope = {
        sessionId: "group-owner",
        runId: "group-owner-run",
        workspaceId: "group-workspace",
      };
      const reviewerScope = {
        sessionId: "group-reviewer",
        runId: "group-reviewer-run",
        workspaceId: "group-workspace",
      };
      const ownerSpill = storeSpill(storage, {
        ...ownerScope,
        toolName: "bash",
        content: "owner-only content",
      });
      const reviewerSpill = storeSpill(storage, {
        ...reviewerScope,
        toolName: "bash",
        content: "reviewer-only content",
      });

      expect(storage.retrieveResult(ownerSpill.id, reviewerScope)).toBeUndefined();
      expect(storage.retrieveResult(reviewerSpill.id, ownerScope)).toBeUndefined();
      expect(storage.retrieveResult(ownerSpill.id, ownerScope)?.content).toBe("owner-only content");
      expect(storage.retrieveResult(reviewerSpill.id, reviewerScope)?.content).toBe(
        "reviewer-only content",
      );
    });

    it("survives a SQLite close/reopen and expires after the absolute TTL", () => {
      const directory = mkdtempSync(join(tmpdir(), "modus-spill-restart-"));
      const databasePath = join(directory, "modus.sqlite");
      let fileDatabase = new DatabaseSync(databasePath);
      try {
        fileDatabase.exec("PRAGMA foreign_keys = ON");
        migrateDatabase(fileDatabase);
        seedScope("session-restart", "run-restart", "workspace-restart", fileDatabase);
        const scope = {
          sessionId: "session-restart",
          runId: "run-restart",
          workspaceId: "workspace-restart",
        };
        const storage = new ToolResultStorage({ database: fileDatabase, ttlMs: 60_000 });
        const record = storage.spillResult({
          ...scope,
          toolName: "grep",
          content: "durable through process restart",
          spillReason: "byte_limit_exceeded",
        });

        fileDatabase.close();
        fileDatabase = new DatabaseSync(databasePath);
        fileDatabase.exec("PRAGMA foreign_keys = ON");
        const restoredStorage = new ToolResultStorage({
          database: fileDatabase,
          ttlMs: 60_000,
        });
        expect(restoredStorage.retrieveResult(record.id, scope)?.content).toBe(
          "durable through process restart",
        );

        fileDatabase
          .prepare("update tool_result_spills set expires_at = ? where id = ?")
          .run(Date.now() - 1, record.id);
        expect(restoredStorage.retrieveResult(record.id, scope)).toBeUndefined();
        expect(restoredStorage.getSpillCount()).toBe(0);
      } finally {
        fileDatabase.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("enforces per-item, aggregate byte, entry, and TTL limits", () => {
      const storage = new ToolResultStorage({
        database,
        maxEntries: 1,
        maxTotalBytes: 10,
        maxSingleResultBytes: 8,
        ttlMs: 1000,
      });
      storeSpill(storage, {
        ...authorizedScope,
        toolName: "read",
        content: "12345",
      });
      storeSpill(storage, {
        ...authorizedScope,
        toolName: "read",
        content: "abcde",
      });

      expect(storage.getStats()).toEqual({ totalEntries: 1, totalBytes: 5, sessionCount: 1 });
      expect(() =>
        storeSpill(storage, {
          ...authorizedScope,
          toolName: "read",
          content: "x".repeat(11),
        }),
      ).toThrowError(ToolResultStorageError);
      expect(storage.getStats().totalBytes).toBeLessThanOrEqual(10);
      expect(storage.getSpillCount()).toBeLessThanOrEqual(1);
    });

    it("keeps a result above the single-item cap inline without creating a spill reference", () => {
      setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_TOOL_RESULT_SPILL: true });
      const storage = new ToolResultStorage({ database });
      const output = "x".repeat(TOOL_RESULT_SPILL_LIMITS.maxSingleResultBytes + 1);
      const result = interceptToolResult({
        ...authorizedScope,
        toolName: "bash",
        output,
        storage,
      });

      expect(result.spilled).toBe(false);
      expect(result.spillId).toBeUndefined();
      expect(result.effectiveContent).toBe(output);
      expect(result.failureCode).toBe("result_too_large");
      expect(storage.getStats().totalBytes).toBe(0);
    });

    it("returns bounded byte chunks with resumable offsets and line limits", () => {
      const storage = new ToolResultStorage({ database });
      const longLine = "🙂".repeat(400);
      const record = storeSpill(storage, {
        ...authorizedScope,
        toolName: "read",
        content: longLine,
      });
      const first = storage.retrieveResult(record.id, authorizedScope, { maxBytes: 512 });
      expect(first).toBeDefined();
      expect(Buffer.byteLength(first?.content ?? "", "utf8")).toBeLessThanOrEqual(512);
      expect(first?.hasMore).toBe(true);
      const second = storage.retrieveResult(record.id, authorizedScope, {
        offsetByte: first?.nextOffsetByte,
        maxBytes: 512,
      });
      expect(`${first?.content}${second?.content}`).toBe(longLine.slice(0, 256));
      expect(Buffer.byteLength(second?.content ?? "", "utf8")).toBeLessThanOrEqual(512);

      const lines = Array.from({ length: 20 }, (_, index) => `Line ${index}`).join("\n");
      const lineRecord = storeSpill(storage, {
        ...authorizedScope,
        toolName: "grep",
        content: lines,
      });
      const window = storage.retrieveResult(lineRecord.id, authorizedScope, {
        offsetLine: 3,
        limitLines: 2,
        maxBytes: 1024,
      });
      expect(window?.content).toBe("Line 3\nLine 4\n");
      expect(window?.hasMore).toBe(true);
    });

    it("preserves the original output and creates no reference when persistent storage fails", () => {
      const storage = new ToolResultStorage({ database });
      const output = "large but complete output\n".repeat(300);
      setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_TOOL_RESULT_SPILL: true });
      database.exec(`
        create trigger fail_tool_result_spill before insert on tool_result_spills
        begin select raise(abort, 'fixture persistence error'); end;
      `);
      try {
        const result = interceptToolResult({
          ...authorizedScope,
          toolName: "bash",
          output,
          storage,
        });
        expect(result.spilled).toBe(false);
        expect(result.spillId).toBeUndefined();
        expect(result.effectiveContent).toBe(output);
        expect(result.failureCode).toBe("storage_unavailable");
        expect(storage.getSpillCount()).toBe(0);
      } finally {
        database.exec("drop trigger fail_tool_result_spill");
      }
    });

    it("keeps output inline when SQLite cannot preserve its malformed Unicode exactly", () => {
      setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_TOOL_RESULT_SPILL: true });
      const storage = new ToolResultStorage({ database });
      const output = `\ud800${"x".repeat(21 * 1024)}`;
      const result = interceptToolResult({
        ...authorizedScope,
        toolName: "bash",
        output,
        storage,
      });

      expect(result.spilled).toBe(false);
      expect(result.spillId).toBeUndefined();
      expect(result.effectiveContent).toBe(output);
      expect(result.failureCode).toBe("invalid_content");
    });

    it("keeps cancellation and multimodal results untouched and retains tool error metadata", async () => {
      setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_TOOL_RESULT_SPILL: true });
      const storage = new ToolResultStorage({ database });
      const onStorageFailure = vi.fn();
      const handler = createModusToolSpillHandler(
        authorizedScope.sessionId,
        () => authorizedScope,
        onStorageFailure,
        storage,
      );
      const output = "error output\n".repeat(400);
      const details = { marker: "preserved details" };
      const errorEvent = {
        type: "tool_result",
        toolCallId: "error-call",
        toolName: "bash",
        input: { command: "offline" },
        content: [{ type: "text", text: output }],
        details,
        isError: true,
      } as ToolResultEvent;

      const patch = await handler(errorEvent, new AbortController().signal);
      expect(patch?.content?.[0]).toMatchObject({ type: "text" });
      expect(patch?.isError).toBeUndefined();
      expect(patch?.details).toBeUndefined();
      expect(errorEvent.details).toBe(details);
      expect(storage.listSpills(authorizedScope)[0]?.isError).toBe(true);

      const multimodalContent = [
        { type: "text", text: output },
        { type: "image", mimeType: "image/png", data: "AA==" },
      ];
      const multimodalEvent = {
        ...errorEvent,
        toolCallId: "image-call",
        content: multimodalContent,
      } as unknown as ToolResultEvent;
      expect(await handler(multimodalEvent, new AbortController().signal)).toBeUndefined();
      expect(multimodalEvent.content).toBe(multimodalContent);

      const controller = new AbortController();
      controller.abort();
      expect(await handler(errorEvent, controller.signal)).toBeUndefined();
      expect(onStorageFailure).not.toHaveBeenCalled();
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
