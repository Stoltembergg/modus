import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findCaseCollisions,
  foldPath,
  formatCaseCollisions,
  parseGitLsFilesZ,
} from "./case-collisions";

describe("findCaseCollisions (in-memory path lists)", () => {
  it("reports two files that differ only in case", () => {
    expect(findCaseCollisions(["src/Button.tsx", "src/button.tsx", "src/other.ts"])).toEqual([
      { kind: "file", key: "src/button.tsx", paths: ["src/Button.tsx", "src/button.tsx"] },
    ]);
  });

  it("reports a directory-prefix collision even when the file names differ", () => {
    expect(findCaseCollisions(["Foo/a.ts", "foo/b.ts"])).toEqual([
      { kind: "directory", key: "foo", paths: ["Foo", "foo"] },
    ]);
  });

  it("reports every colliding prefix of a nested directory collision", () => {
    const found = findCaseCollisions(["apps/Desktop/src/A/x.ts", "apps/desktop/src/a/y.ts"]);
    expect(formatCaseCollisions(found).split("\n")).toEqual([
      "directory: apps/Desktop <-> apps/desktop",
      "directory: apps/Desktop/src <-> apps/desktop/src",
      "directory: apps/Desktop/src/A <-> apps/desktop/src/a",
    ]);
  });

  it("reports a nested collision below an identical parent", () => {
    expect(findCaseCollisions(["lib/Utils/a.ts", "lib/utils/b.ts", "lib/x.ts"])).toEqual([
      { kind: "directory", key: "lib/utils", paths: ["lib/Utils", "lib/utils"] },
    ]);
  });

  it("reports a file that collides with a directory", () => {
    expect(findCaseCollisions(["docs/README", "docs/readme/intro.md"])).toEqual([
      { kind: "file-directory", key: "docs/readme", paths: ["docs/README", "docs/readme"] },
    ]);
  });

  it("groups three or more spellings together", () => {
    const [only, ...rest] = findCaseCollisions(["a/X.md", "a/x.md", "a/x.MD"]);
    expect(rest).toEqual([]);
    expect(only?.paths).toEqual(["a/X.md", "a/x.MD", "a/x.md"]);
  });

  it("no false positives: distinct names, same name in different dirs, repeats", () => {
    expect(
      findCaseCollisions([
        "src/a.ts",
        "src/b.ts",
        "src/index.ts",
        "test/index.ts",
        "Makefile",
        "packages/Makefile",
        "src/a.ts",
        "src/a.tsx",
        "./src/b.ts",
      ]),
    ).toEqual([]);
  });

  it("unicode / ascii sanity", () => {
    // ASCII and Unicode letters fold; NFC vs NFD spellings are the same entry on macOS.
    expect(findCaseCollisions(["Ärger.md", "ärger.md"]).map((c) => c.paths)).toEqual([
      ["Ärger.md", "ärger.md"],
    ]);
    expect(findCaseCollisions(["caf\u00e9.md", "cafe\u0301.md"])).toHaveLength(1);
    expect(findCaseCollisions(["Ωmega/a", "ωmega/b"])[0]?.kind).toBe("directory");
    // Distinct letters never collide, and ß is not folded to ss.
    expect(findCaseCollisions(["résumé.md", "resume.md", "straße.md", "strasse.md"])).toEqual([]);
    expect(findCaseCollisions(["中文/a.ts", "中文/b.ts", "日本/a.ts"])).toEqual([]);
    expect(foldPath("Src/Ä.TS")).toBe("src/ä.ts");
  });

  it("parses `git ls-files -z` output and normalises backslashes", () => {
    expect(parseGitLsFilesZ("a b.ts\0dir/x\0")).toEqual(["a b.ts", "dir/x"]);
    expect(findCaseCollisions(["Foo\\a.ts", "foo/b.ts"])[0]?.paths).toEqual(["Foo", "foo"]);
  });
});

/** Repo root from this file's directory (works in worktrees and CI checkouts). */
function gitRepoRoot(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const repoRoot = gitRepoRoot();
if (!repoRoot) {
  console.warn(
    "[case-collisions] git is unavailable or this is not a git checkout: real-repo check skipped",
  );
}

describe("this repository (C7: runs in CI via `npm run test`)", () => {
  it.skipIf(!repoRoot)("has no case-insensitive path collisions in `git ls-files`", () => {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const paths = parseGitLsFilesZ(output);
    expect(paths.length).toBeGreaterThan(100);
    const collisions = findCaseCollisions(paths);
    expect(
      collisions.length,
      `case-insensitive path collisions (break macOS / Windows checkouts):\n${formatCaseCollisions(collisions)}`,
    ).toBe(0);
  });
});
