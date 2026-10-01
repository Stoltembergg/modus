import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "../../shared/contracts";

let userData: string;

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

const { getDatabase } = await import("../db/database");
const {
  configureGroupProjectSetupForTests,
  flushGroupProjectSetup,
  getGroupProjectContextSnapshot,
  isGroupProjectSetupPending,
  resetGroupProjectSetupForTests,
  scheduleGroupProjectSetup,
} = await import("./group-project-setup");
const { invalidateProjectModelPaths, listProjectModelEdges, upsertProjectModelDiscoveries } =
  await import("../agent/harness/project-model-store");
const { classifyGroupProjectRole, composeGroupProjectContextSection, selectProjectModelSlice } =
  await import("./group-project-context-slice");

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

function insertWorkspace(id: string, rootPath: string): void {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert or replace into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, ?, 1, ?, ?)`,
    )
    .run(id, rootPath, id, now, now);
}

describe("group project Setup", () => {
  beforeAll(async () => {
    userData = mkdtempSync(join(tmpdir(), "modus-group-setup-"));
    getDatabase();
  });

  beforeEach(() => {
    resetGroupProjectSetupForTests();
  });

  afterEach(() => {
    resetGroupProjectSetupForTests();
  });

  it("maps a project into Project Model + status Ready without a parallel store", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-setup-proj-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "demo",
        main: "src/index.ts",
        dependencies: { react: "19.0.0" },
        scripts: { test: "vitest" },
      }),
    );
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/index.ts"), "export {};");
    insertWorkspace("ws-setup-1", root);

    const runner = vi.fn(async () => ({ exitCode: 0, isError: false, stderr: "", text: "ok" }));
    configureGroupProjectSetupForTests({
      debounceMs: 0,
      resolveWorkspace: (id) => (id === "ws-setup-1" ? workspace("ws-setup-1", root) : undefined),
      runner,
      readGit: async () => ({
        branch: "main",
        head: "abc123def456",
        changedPaths: ["src/index.ts"],
      }),
    });

    scheduleGroupProjectSetup({
      workspaceId: "ws-setup-1",
      reason: "group_create",
      groupId: "g-1",
    });
    expect(isGroupProjectSetupPending("ws-setup-1")).toBe(true);

    const outcome = await flushGroupProjectSetup("ws-setup-1");
    expect(outcome?.snapshot.status).toBe("ready");
    expect(outcome?.snapshot.fingerprint.length).toBe(64);
    expect(outcome?.snapshot.edgeCount).toBeGreaterThan(0);
    expect(
      listProjectModelEdges("ws-setup-1").some((edge) => edge.fromPath === "package.json"),
    ).toBe(true);
    expect(getGroupProjectContextSnapshot("ws-setup-1")?.status).toBe("ready");
  });

  it("skips reopen work when the fingerprint still matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-setup-reopen-"));
    writeFileSync(join(root, "package.json"), '{"name":"reopen"}');
    insertWorkspace("ws-setup-2", root);
    const runner = vi.fn(async () => ({ exitCode: 0, isError: false, stderr: "", text: "ok" }));
    const readGit = vi.fn(async () => ({
      branch: "main",
      head: "head111",
      changedPaths: [] as string[],
    }));
    configureGroupProjectSetupForTests({
      debounceMs: 0,
      resolveWorkspace: () => workspace("ws-setup-2", root),
      runner,
      readGit,
    });

    scheduleGroupProjectSetup({ workspaceId: "ws-setup-2", reason: "group_create" });
    await flushGroupProjectSetup("ws-setup-2");
    const callsAfterCreate = runner.mock.calls.length;

    scheduleGroupProjectSetup({ workspaceId: "ws-setup-2", reason: "reopen" });
    const reopen = await flushGroupProjectSetup("ws-setup-2");
    expect(reopen?.skipped).toBe(true);
    expect(reopen?.snapshot.status).toBe("ready");
    expect(runner.mock.calls.length).toBe(callsAfterCreate);
  });

  it("skips chats / inbox workspaces", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, isError: false, stderr: "", text: "ok" }));
    configureGroupProjectSetupForTests({
      debounceMs: 0,
      resolveWorkspace: (id) =>
        id === "chats" ? workspace("chats", "/tmp/chats", true) : undefined,
      runner,
    });
    scheduleGroupProjectSetup({ workspaceId: "chats", reason: "group_create" });
    expect(await flushGroupProjectSetup("chats")).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it("selectively invalidates only affected Project Model paths", () => {
    insertWorkspace("ws-inv", "/tmp/ws-inv");
    upsertProjectModelDiscoveries({
      workspaceId: "ws-inv",
      revision: "rev1",
      hits: [
        { path: "apps/desktop/src/a.ts" },
        { path: "apps/desktop/src/b.ts" },
        { path: "docs/readme.md" },
      ],
    });
    const removed = invalidateProjectModelPaths("ws-inv", ["apps/desktop/src/a.ts"]);
    expect(removed).toBeGreaterThanOrEqual(1);
    const remaining = listProjectModelEdges("ws-inv").map((edge) => edge.fromPath);
    expect(remaining).not.toContain("apps/desktop/src/a.ts");
    expect(remaining).toContain("apps/desktop/src/b.ts");
    expect(remaining).toContain("docs/readme.md");
  });
});

describe("group project context selective retrieval", () => {
  it("classifies roles and prefers matching edge kinds", () => {
    expect(classifyGroupProjectRole("Planner")).toBe("planner");
    expect(classifyGroupProjectRole("Builder / implement")).toBe("builder");
    expect(classifyGroupProjectRole("Reviewer")).toBe("reviewer");
    expect(classifyGroupProjectRole("Explorer")).toBe("explorer");

    const edges = [
      {
        workspaceId: "ws",
        revision: "r",
        fromPath: "src/changed.ts",
        toPath: "src/changed.ts",
        kind: "changed" as const,
        source: "git" as const,
        updatedAt: "t",
      },
      {
        workspaceId: "ws",
        revision: "r",
        fromPath: "package.json",
        toPath: "package.json",
        kind: "discovery" as const,
        source: "codegraph" as const,
        updatedAt: "t",
      },
      {
        workspaceId: "ws",
        revision: "r",
        fromPath: "package.json",
        toPath: "deps/react",
        kind: "depends" as const,
        source: "checkpoint" as const,
        updatedAt: "t",
      },
    ];
    const builder = selectProjectModelSlice({ edges, role: "builder", prompt: "fix changed" });
    expect(builder[0]?.kind).toBe("changed");
    const planner = selectProjectModelSlice({ edges, role: "planner" });
    expect(planner[0]?.kind).toBe("discovery");
  });

  it("composes a wake project_context section that prefers the shared map", () => {
    const section = composeGroupProjectContextSection({
      role: "Explorer",
      edges: [
        {
          workspaceId: "ws",
          revision: "r",
          fromPath: "apps/desktop/src/main.ts",
          toPath: "apps/desktop/src/main.ts",
          kind: "discovery",
          source: "codegraph",
          updatedAt: "t",
        },
      ],
      prompt: "where is the entrypoint",
    });
    expect(section).toContain('<project_context role="explorer">');
    expect(section).toContain("Consult this before broad search");
    expect(section).toContain("discovery apps/desktop/src/main.ts");
  });
});
