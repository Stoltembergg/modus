import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodeGraphRunner,
  resolveFastCodebaseBinary,
  runFastCodebase,
} from "./fast-codebase-service";

describe("Fast Codebase service", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the configured CodeGraph binary when provided", () => {
    vi.stubEnv("MODUS_CODEGRAPH_BIN", "C:\\Tools\\codegraph.exe");
    expect(resolveFastCodebaseBinary()).toBe("C:\\Tools\\codegraph.exe");
  });

  it("indexes the current workspace before querying when .codegraph is missing", async () => {
    const root = tempWorkspace();
    const calls: string[][] = [];
    const runner: CodeGraphRunner = async (args) => {
      calls.push(args);
      return ok(args[0] === "explore" ? "Relevant map\n- src/run.ts:7" : "ok");
    };

    const result = await runFastCodebase({ cwd: root, query: "run", runner });

    expect(calls).toEqual([
      ["init", root, "--verbose"],
      ["query", "-p", root, "-l", "8", "--json", "run"],
      ["explore", "-p", root, "--max-files", "1", "run"],
    ]);
    expect(result.details.indexDir).toBe(join(root, ".codegraph"));
    expect(result.details.indexed).toBe(true);
    expect(result.text).toContain("Index: created");
    expect(result.text).toContain("src/run.ts");
  });

  it("shares one index process for concurrent calls to the same workspace", async () => {
    const root = tempWorkspace();
    let releaseIndex!: () => void;
    const indexReady = new Promise<void>((resolve) => {
      releaseIndex = resolve;
    });
    let indexStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      indexStarted = resolve;
    });
    const calls: string[][] = [];
    const runner: CodeGraphRunner = async (args) => {
      calls.push(args);
      if (args[0] === "init") {
        indexStarted();
        await indexReady;
      }
      return ok("[]");
    };

    const first = runFastCodebase({ cwd: root, query: "one", runner });
    const second = runFastCodebase({ cwd: root, query: "two", runner });
    await started;

    expect(calls.filter(([command]) => command === "init")).toHaveLength(1);
    releaseIndex();
    await Promise.all([first, second]);
    expect(calls.filter(([command]) => command === "explore")).toHaveLength(2);
  });

  it("aborts the shared index when the only waiter cancels", async () => {
    const root = tempWorkspace();
    const controller = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    let indexStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      indexStarted = resolve;
    });
    const runner: CodeGraphRunner = async (args, options) => {
      if (args[0] !== "init") {
        return ok("[]");
      }
      sharedSignal = options.signal;
      indexStarted();
      return new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("index aborted")), {
          once: true,
        });
      });
    };

    const result = runFastCodebase({
      cwd: root,
      query: "tools",
      runner,
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(true);
  });

  it("indexes an explicit child workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-fast-codebase-"));
    const child = join(root, "repo");
    mkdirSync(child);
    const calls: string[][] = [];
    const runner: CodeGraphRunner = async (args) => {
      calls.push(args);
      return ok(args[0] === "explore" ? "map" : "ok");
    };

    const result = await runFastCodebase({
      cwd: root,
      query: "tools",
      runner,
      workspacePath: child,
    });

    expect(calls[0]).toEqual(["init", child, "--verbose"]);
    expect(result.details.workspace).toBe(child);
  });

  it("does not index workspace_path outside the current workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-fast-codebase-"));
    const outside = tempWorkspace();
    const runner: CodeGraphRunner = async () => {
      throw new Error("CodeGraph should not start");
    };

    const result = await runFastCodebase({
      cwd: root,
      query: "tools",
      runner,
      workspacePath: outside,
    });

    expect(result.details.indexed).toBe(false);
    expect(result.text).toContain("outside the current workspace");
    expect(result.hits).toEqual([]);
  });

  it("queries an existing clean index without syncing", async () => {
    const root = tempWorkspace();
    writeIndex(root);
    const calls: string[][] = [];
    const runner: CodeGraphRunner = async (args) => {
      calls.push(args);
      if (args[0] === "status") {
        return ok(statusJson());
      }
      return ok("[]");
    };

    const result = await runFastCodebase({ cwd: root, query: "overview", runner });

    expect(calls).toEqual([
      ["status", root, "--json"],
      ["query", "-p", root, "-l", "8", "--json", "overview"],
      ["explore", "-p", root, "--max-files", "1", "overview"],
    ]);
    expect(result.text).toContain("Index: ready");
  });

  it("does not sync only because CodeGraph recommends a future reindex", async () => {
    const root = tempWorkspace();
    writeIndex(root);
    const calls: string[][] = [];
    const runner: CodeGraphRunner = async (args) => {
      calls.push(args);
      if (args[0] === "status") {
        return ok(statusJson({}, true));
      }
      return ok("[]");
    };

    await runFastCodebase({ cwd: root, query: "overview", runner });

    expect(calls.map(([command]) => command)).toEqual(["status", "query", "explore"]);
  });

  it("syncs an existing index when CodeGraph reports pending changes", async () => {
    const root = tempWorkspace();
    writeIndex(root);
    const calls: string[][] = [];
    const runner: CodeGraphRunner = async (args) => {
      calls.push(args);
      if (args[0] === "status") {
        return ok(statusJson({ modified: 1 }));
      }
      return ok("[]");
    };

    const result = await runFastCodebase({ cwd: root, query: "overview", runner });

    expect(calls).toEqual([
      ["status", root, "--json"],
      ["sync", root],
      ["query", "-p", root, "-l", "8", "--json", "overview"],
      ["explore", "-p", root, "--max-files", "1", "overview"],
    ]);
    expect(result.text).toContain("Index: synced");
  });

  it("allows one source file when source snippets are requested", async () => {
    const root = tempWorkspace();
    const calls: string[][] = [];
    const runner: CodeGraphRunner = async (args) => {
      calls.push(args);
      return ok("source");
    };

    await runFastCodebase({ cwd: root, includeCode: true, limit: 30, query: "run", runner });

    expect(calls).toEqual([
      ["init", root, "--verbose"],
      ["query", "-p", root, "-l", "12", "--json", "run"],
      ["explore", "-p", root, "--max-files", "1", "run"],
    ]);
  });

  it("adds compact exact hits before the code map", async () => {
    const root = tempWorkspace();
    const runner: CodeGraphRunner = async (args) =>
      ok(
        args[0] === "query"
          ? JSON.stringify([
              {
                node: {
                  filePath: "src/run.ts",
                  kind: "function",
                  name: "run",
                  signature: "function run(): void",
                  startLine: 7,
                },
              },
            ])
          : args[0] === "explore"
            ? "map"
            : "ok",
      );

    const result = await runFastCodebase({ cwd: root, query: "run", runner });

    expect(result.text).toContain("**Exact hits**");
    expect(result.text).toContain("src/run.ts:7 — function run");
    expect(result.text).not.toContain("function run(): void");
    expect(result.text).toContain("**Code map**");
    expect(result.text.indexOf("**Exact hits**")).toBeLessThan(result.text.indexOf("**Code map**"));
  });

  it("returns bounded structured hit references while preserving the display text", async () => {
    const root = tempWorkspace();
    const runner: CodeGraphRunner = async (args) =>
      ok(
        args[0] === "query"
          ? JSON.stringify([
              {
                node: {
                  filePath: join(root, "src", "run.ts"),
                  kind: "function",
                  name: "run",
                  qualifiedName: "Agent.run",
                  startLine: 7,
                  signature: "source body must not enter hit refs",
                },
              },
              { node: { filePath: "src/invalid.ts", startLine: 0, name: " " } },
            ])
          : args[0] === "explore"
            ? "Existing display map remains."
            : "ok",
      );

    const result = await runFastCodebase({ cwd: root, query: "run", runner });

    expect(result.hits).toEqual([
      { path: "src/run.ts", symbol: "Agent.run", line: 7, kind: "function" },
      { path: "src/invalid.ts" },
    ]);
    expect(result.text).toContain("**Exact hits**");
    expect(result.text).toContain("Existing display map remains.");
    expect(JSON.stringify(result.hits)).not.toContain("source body");
  });

  it("rejects discovery paths outside the owning workspace and through symlinks", async () => {
    const root = tempWorkspace();
    const outside = tempWorkspace();
    const linkedDir = join(root, "linked");
    try {
      symlinkSync(outside, linkedDir, "junction");
    } catch {
      // Some Windows environments do not permit creating directory symlinks.
    }
    const runner: CodeGraphRunner = async (args) =>
      ok(
        args[0] === "query"
          ? JSON.stringify([
              { node: { filePath: join(outside, "secret.ts"), kind: "file" } },
              { node: { filePath: "../outside.ts", kind: "file" } },
              { node: { filePath: join(linkedDir, "secret.ts"), kind: "file" } },
            ])
          : args[0] === "explore"
            ? "map"
            : "ok",
      );

    const result = await runFastCodebase({ cwd: root, query: "secret", runner });

    expect(result.hits).toEqual([]);
  });

  it("does not index a workspace_path symlink that resolves outside the workspace", async () => {
    const root = tempWorkspace();
    const outside = tempWorkspace();
    const linked = join(root, "linked");
    try {
      symlinkSync(outside, linked, "junction");
    } catch {
      return;
    }
    const calls: string[][] = [];
    const runner: CodeGraphRunner = async (args) => {
      calls.push(args);
      return ok("map");
    };

    const result = await runFastCodebase({
      cwd: root,
      query: "outside",
      runner,
      workspacePath: "linked",
    });

    expect(calls).toEqual([]);
    expect(result.details.indexed).toBe(false);
    expect(result.hits).toEqual([]);
  });

  it("deduplicates and bounds hit count and metadata fields", async () => {
    const root = tempWorkspace();
    const nodes = Array.from({ length: 60 }, (_, index) => ({
      node: {
        filePath: `src/file-${index}.ts`,
        kind: "function".repeat(20),
        name: `symbol-${index}-${"x".repeat(600)}`,
        startLine: index + 1,
      },
    }));
    const duplicate = nodes[0];
    if (duplicate) nodes.push(duplicate);
    const runner: CodeGraphRunner = async (args) =>
      ok(args[0] === "query" ? JSON.stringify(nodes) : "map");

    const result = await runFastCodebase({ cwd: root, query: "symbols", runner });

    expect(result.hits).toHaveLength(50);
    expect(new Set(result.hits.map((hit) => hit.path)).size).toBe(result.hits.length);
    expect(result.hits.every((hit) => (hit.symbol?.length ?? 0) <= 256)).toBe(true);
    expect(result.hits.every((hit) => (hit.kind?.length ?? 0) <= 64)).toBe(true);
    expect(result.hits.every((hit) => hit.line === undefined || hit.line > 0)).toBe(true);
  });

  it("returns no typed hits when the exact CodeGraph query fails", async () => {
    const root = tempWorkspace();
    writeIndex(root);
    const runner: CodeGraphRunner = async (args) =>
      args[0] === "status"
        ? ok(statusJson())
        : args[0] === "query"
          ? fail("query failed", "network unavailable")
          : ok("map");

    const result = await runFastCodebase({ cwd: root, query: "failed", runner });
    expect(result.hits).toEqual([]);
    expect(result.text).toContain("map");
  });

  it("caps long tool output with a narrower-query hint", async () => {
    const root = tempWorkspace();
    const runner: CodeGraphRunner = async (args) =>
      ok(args[0] === "explore" ? "x".repeat(40_000) : "ok");

    const result = await runFastCodebase({
      cwd: root,
      includeCode: true,
      query: "run",
      runner,
    });

    expect(result.text.length).toBeLessThan(25_000);
    expect(result.text).toContain("output truncated");
    expect(result.text).toContain("narrower query");
  });

  it("adds guidance that prefers narrower map queries before broad grep", async () => {
    const root = tempWorkspace();
    const runner: CodeGraphRunner = async (args) =>
      ok(args[0] === "explore" ? "map codegraph_explore" : "ok");

    const result = await runFastCodebase({
      cwd: root,
      query: "solers ai tool registry",
      runner,
    });

    expect(result.text).toContain("How to use this map");
    expect(result.text).toContain("Read exact hit line ranges first");
    expect(result.text).toContain("Prefer small reads around listed lines");
    expect(result.text).toContain("ask fast_codebase again with a narrower query");
    expect(result.text).toContain("include_code only for a narrow implementation lookup");
    expect(result.text).toContain("preferably scoped");
    expect(result.text).not.toContain("codegraph_explore");
    expect(result.text.indexOf("How to use this map")).toBeLessThan(result.text.indexOf("map"));
  });

  it("summarizes stderr when queries fail", async () => {
    const root = tempWorkspace();
    writeIndex(root);
    const runner: CodeGraphRunner = async (args) =>
      args[0] === "status"
        ? ok(statusJson())
        : fail("project failed", "debug line 1\ndebug line 2");

    await expect(runFastCodebase({ cwd: root, query: "run", runner })).rejects.toThrow(
      /stderr:\ndebug line 1\ndebug line 2/,
    );
  });
});

function ok(text: string) {
  return {
    exitCode: 0,
    isError: false,
    stderr: "",
    text,
  };
}

function fail(text: string, stderr: string) {
  return {
    exitCode: 1,
    isError: true,
    stderr,
    text,
  };
}

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "modus-fast-codebase-"));
}

function writeIndex(root: string): void {
  mkdirSync(join(root, ".codegraph"), { recursive: true });
  writeFileSync(join(root, ".codegraph", "codegraph.db"), "");
}

function statusJson(
  pending: { added?: number; modified?: number; removed?: number } = {},
  reindexRecommended = false,
): string {
  return JSON.stringify({
    index: { reindexRecommended },
    pendingChanges: {
      added: pending.added ?? 0,
      modified: pending.modified ?? 0,
      removed: pending.removed ?? 0,
    },
    worktreeMismatch: null,
  });
}
