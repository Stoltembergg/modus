import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getWorkspaceSourceRevision } from "./workspace-source-revision";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

describe("workspace source revision", () => {
  it("is stable for identical content and changes when tracked or untracked source changes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "modus-workspace-source-revision-"));
    try {
      git(cwd, ["init", "-q"]);
      git(cwd, ["config", "user.email", "test@example.com"]);
      git(cwd, ["config", "user.name", "Modus Test"]);
      mkdirSync(join(cwd, "src"));
      await writeFile(join(cwd, "src", "tracked.ts"), "export const value = 1;\n");
      git(cwd, ["add", "src/tracked.ts"]);
      git(cwd, ["commit", "-qm", "base"]);
      const base = git(cwd, ["rev-parse", "HEAD"]);

      const initial = getWorkspaceSourceRevision(cwd, base);
      expect(initial).toMatch(/^[a-f0-9]{64}$/);
      expect(getWorkspaceSourceRevision(cwd, base)).toBe(initial);

      await writeFile(join(cwd, "src", "tracked.ts"), "export const value = 2;\n");
      const trackedEdit = getWorkspaceSourceRevision(cwd, base);
      expect(trackedEdit).toMatch(/^[a-f0-9]{64}$/);
      expect(trackedEdit).not.toBe(initial);

      await writeFile(join(cwd, "src", "untracked.ts"), "export const fresh = true;\n");
      const untrackedEdit = getWorkspaceSourceRevision(cwd, base);
      expect(untrackedEdit).toMatch(/^[a-f0-9]{64}$/);
      expect(untrackedEdit).not.toBe(trackedEdit);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
