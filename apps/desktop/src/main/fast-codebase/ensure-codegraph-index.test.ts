import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureCodeGraphIndex } from "./ensure-codegraph-index";
import type { CodeGraphRunner } from "./fast-codebase-service";

describe("ensureCodeGraphIndex", () => {
  it("initializes without querying", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-ensure-index-"));
    const calls: string[][] = [];
    const runner: CodeGraphRunner = async (args) => {
      calls.push(args);
      return { exitCode: 0, isError: false, stderr: "", text: "ok" };
    };

    const state = await ensureCodeGraphIndex({ cwd: root, runner });
    expect(state).toBe("created");
    expect(calls).toEqual([["init", root, "--verbose"]]);
  });

  it("syncs when status reports pending changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-ensure-index-"));
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

    const state = await ensureCodeGraphIndex({ cwd: root, runner });
    expect(state).toBe("synced");
    expect(calls.map((args) => args[0])).toEqual(["status", "sync"]);
  });
});
