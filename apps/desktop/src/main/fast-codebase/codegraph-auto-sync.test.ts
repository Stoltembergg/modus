import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "../../shared/contracts";
import {
  configureCodeGraphAutoSyncForTests,
  flushCodeGraphAutoSync,
  isCodeGraphAutoSyncPending,
  resetCodeGraphAutoSyncForTests,
  scheduleCodeGraphAutoSync,
} from "./codegraph-auto-sync";
import type { CodeGraphRunner } from "./fast-codebase-service";

function workspace(id: string, rootPath: string, inbox = false): WorkspaceInfo {
  return {
    id,
    rootPath,
    displayName: id,
    isGitRepository: true,
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    pinned: false,
    ...(inbox ? { inbox: true as const } : {}),
  };
}

describe("CodeGraph auto-sync", () => {
  afterEach(() => {
    resetCodeGraphAutoSyncForTests();
  });

  it("schedules background init without querying CodeGraph", async () => {
    const calls: string[][] = [];
    const runner: CodeGraphRunner = async (args) => {
      calls.push(args);
      return { exitCode: 0, isError: false, stderr: "", text: "ok" };
    };
    configureCodeGraphAutoSyncForTests({
      debounceMs: 0,
      resolveWorkspace: (id) => (id === "ws1" ? workspace("ws1", "/tmp/ws1") : undefined),
      runner,
    });

    scheduleCodeGraphAutoSync({ workspaceId: "ws1", reason: "workspace_select" });
    expect(isCodeGraphAutoSyncPending("ws1")).toBe(true);

    const outcome = await flushCodeGraphAutoSync("ws1");
    expect(outcome?.state).toBe("created");
    expect(outcome?.reason).toBe("workspace_select");
    expect(calls.map((args) => args[0])).toEqual(["init"]);
    expect(calls.some((args) => args[0] === "query" || args[0] === "explore")).toBe(false);
  });

  it("skips chats / inbox workspaces", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, isError: false, stderr: "", text: "ok" }));
    configureCodeGraphAutoSyncForTests({
      debounceMs: 0,
      resolveWorkspace: (id) =>
        id === "chats" ? workspace("chats", "/tmp/chats", true) : undefined,
      runner,
    });

    scheduleCodeGraphAutoSync({ workspaceId: "chats", reason: "workspace_select" });
    expect(await flushCodeGraphAutoSync("chats")).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it("coalesces concurrent schedules into one flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const runner: CodeGraphRunner = async (args) => {
      if (args[0] === "init") {
        started += 1;
        await gate;
      }
      return { exitCode: 0, isError: false, stderr: "", text: "ok" };
    };
    configureCodeGraphAutoSyncForTests({
      debounceMs: 0,
      resolveWorkspace: () => workspace("ws1", "/tmp/ws1"),
      runner,
    });

    scheduleCodeGraphAutoSync({ workspaceId: "ws1", reason: "workspace_select" });
    const first = flushCodeGraphAutoSync("ws1");
    scheduleCodeGraphAutoSync({ workspaceId: "ws1", reason: "workspace_select" });
    const second = flushCodeGraphAutoSync("ws1");
    await Promise.resolve();
    expect(started).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a?.state).toBe("created");
    expect(b?.state).toBe("created");
    expect(started).toBe(1);
  });

  it("records failed sync without throwing", async () => {
    const runner: CodeGraphRunner = async () => {
      throw new Error("kernel missing");
    };
    configureCodeGraphAutoSyncForTests({
      debounceMs: 0,
      resolveWorkspace: () => workspace("ws1", "/tmp/ws1"),
      runner,
    });

    scheduleCodeGraphAutoSync({ workspaceId: "ws1", reason: "manual" });
    const outcome = await flushCodeGraphAutoSync("ws1");
    expect(outcome?.state).toBe("failed");
    expect(outcome?.detail).toContain("kernel missing");
  });

  it("syncs an existing dirty index without a query", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "modus-auto-sync-"));
    mkdirSync(join(root, ".codegraph"), { recursive: true });
    writeFileSync(join(root, ".codegraph", "codegraph.db"), "db");

    const calls: string[][] = [];
    const runner: CodeGraphRunner = async (args) => {
      calls.push(args);
      if (args[0] === "status") {
        return {
          exitCode: 0,
          isError: false,
          stderr: "",
          text: JSON.stringify({ pendingChanges: { added: 1, modified: 0, removed: 0 } }),
        };
      }
      return { exitCode: 0, isError: false, stderr: "", text: "ok" };
    };
    configureCodeGraphAutoSyncForTests({
      debounceMs: 0,
      resolveWorkspace: () => workspace("ws1", root),
      runner,
    });

    scheduleCodeGraphAutoSync({ workspaceId: "ws1", cwd: root, reason: "git_change" });
    const outcome = await flushCodeGraphAutoSync("ws1");
    expect(outcome?.state).toBe("synced");
    expect(calls.map((args) => args[0])).toEqual(["status", "sync"]);
  });
});
