import { describe, expect, it } from "vitest";
import { isWindowsPath, normalizeSlashPath, resolveSearchResultTarget } from "./searchResultPath";

describe("resolveSearchResultTarget (POSIX)", () => {
  const cwd = "/home/me/repo";

  it("joins the grep path arg with the printed relative path", () => {
    expect(
      resolveSearchResultTarget({ cwd, searchPath: "src", resultPath: "features/a.ts" }),
    ).toEqual({ kind: "open", path: "/home/me/repo/src/features/a.ts" });
  });

  it("uses the cwd when there is no path arg, and normalises . segments", () => {
    expect(resolveSearchResultTarget({ cwd, resultPath: "./src/./a.ts" })).toEqual({
      kind: "open",
      path: "/home/me/repo/src/a.ts",
    });
    expect(resolveSearchResultTarget({ cwd, searchPath: ".", resultPath: "a.ts" })).toEqual({
      kind: "open",
      path: "/home/me/repo/a.ts",
    });
  });

  it("allows .. that stays inside the workspace", () => {
    expect(
      resolveSearchResultTarget({ cwd, searchPath: "src/deep", resultPath: "../b.ts" }),
    ).toEqual({ kind: "open", path: "/home/me/repo/src/b.ts" });
  });

  it("refuses .. that escapes the workspace (in the result or in the path arg)", () => {
    expect(resolveSearchResultTarget({ cwd, resultPath: "../other/secret.ts" })).toEqual({
      kind: "outside",
      path: "/home/me/other/secret.ts",
    });
    expect(
      resolveSearchResultTarget({ cwd, searchPath: "../..", resultPath: "etc/passwd" }),
    ).toEqual({ kind: "outside", path: "/home/etc/passwd" });
    // Climbing above the filesystem root is outside too (never throws).
    expect(resolveSearchResultTarget({ cwd, resultPath: "../../../../../../x" }).kind).toBe(
      "outside",
    );
  });

  it("does not treat a sibling with the same prefix as inside", () => {
    expect(resolveSearchResultTarget({ cwd, resultPath: "/home/me/repo-old/a.ts" })).toEqual({
      kind: "outside",
      path: "/home/me/repo-old/a.ts",
    });
  });

  it("does not join an absolute printed path again with the path arg", () => {
    expect(
      resolveSearchResultTarget({ cwd, searchPath: "src", resultPath: "/home/me/repo/src/a.ts" }),
    ).toEqual({ kind: "open", path: "/home/me/repo/src/a.ts" });
  });

  it("accepts an absolute path arg inside the workspace and refuses one outside", () => {
    expect(
      resolveSearchResultTarget({ cwd, searchPath: "/home/me/repo/lib", resultPath: "x.ts" }),
    ).toEqual({ kind: "open", path: "/home/me/repo/lib/x.ts" });
    expect(resolveSearchResultTarget({ cwd, searchPath: "/tmp", resultPath: "x.ts" })).toEqual({
      kind: "outside",
      path: "/tmp/x.ts",
    });
  });

  it("an absolute printed path outside the workspace is outside", () => {
    expect(resolveSearchResultTarget({ cwd, resultPath: "/etc/hosts" })).toEqual({
      kind: "outside",
      path: "/etc/hosts",
    });
  });

  it("is case-sensitive on POSIX", () => {
    expect(resolveSearchResultTarget({ cwd, resultPath: "/home/me/REPO/a.ts" }).kind).toBe(
      "outside",
    );
  });

  it("is unavailable without a cwd or a path", () => {
    expect(resolveSearchResultTarget({ cwd: undefined, resultPath: "a.ts" })).toEqual({
      kind: "unavailable",
    });
    expect(resolveSearchResultTarget({ cwd, resultPath: "  " })).toEqual({ kind: "unavailable" });
  });
});

describe("resolveSearchResultTarget (Windows)", () => {
  const cwd = "C:\\Users\\me\\repo";

  it("joins with \\ separators in the path arg and the result, returning \\ paths", () => {
    expect(
      resolveSearchResultTarget({ cwd, searchPath: "src\\features", resultPath: "a\\b.ts" }),
    ).toEqual({ kind: "open", path: "C:\\Users\\me\\repo\\src\\features\\a\\b.ts" });
    // Mixed separators as grep sometimes prints them.
    expect(resolveSearchResultTarget({ cwd, searchPath: "src", resultPath: "a/b.ts" })).toEqual({
      kind: "open",
      path: "C:\\Users\\me\\repo\\src\\a\\b.ts",
    });
  });

  it("refuses ..\\ that escapes the workspace", () => {
    expect(resolveSearchResultTarget({ cwd, resultPath: "..\\other\\x.ts" })).toEqual({
      kind: "outside",
      path: "C:\\Users\\me\\other\\x.ts",
    });
  });

  it("compares case-insensitively (drive letter and folders)", () => {
    expect(
      resolveSearchResultTarget({ cwd, resultPath: "c:\\users\\ME\\Repo\\src\\a.ts" }),
    ).toEqual({ kind: "open", path: "c:\\users\\ME\\Repo\\src\\a.ts" });
    expect(resolveSearchResultTarget({ cwd, resultPath: "D:\\Users\\me\\repo\\a.ts" }).kind).toBe(
      "outside",
    );
    expect(resolveSearchResultTarget({ cwd, resultPath: "C:\\Users\\me\\repo2\\a.ts" }).kind).toBe(
      "outside",
    );
  });

  it("does not join an absolute printed path again with the path arg", () => {
    expect(
      resolveSearchResultTarget({
        cwd,
        searchPath: "src",
        resultPath: "C:\\Users\\me\\repo\\src\\a.ts",
      }),
    ).toEqual({ kind: "open", path: "C:\\Users\\me\\repo\\src\\a.ts" });
  });

  it("handles UNC workspaces", () => {
    const unc = "\\\\server\\share\\repo";
    expect(resolveSearchResultTarget({ cwd: unc, resultPath: "a.ts" })).toEqual({
      kind: "open",
      path: "\\\\server\\share\\repo\\a.ts",
    });
    expect(resolveSearchResultTarget({ cwd: unc, resultPath: "..\\..\\x.ts" }).kind).toBe(
      "outside",
    );
  });
});

describe("path helpers", () => {
  it("normalizeSlashPath resolves segments and refuses climbing above the root", () => {
    expect(normalizeSlashPath("/a/./b//c/../d")).toBe("/a/b/d");
    expect(normalizeSlashPath("C:\\a\\..\\b")).toBe("C:/b");
    expect(normalizeSlashPath("/a/../..")).toBeUndefined();
  });

  it("isWindowsPath detects drive letters, UNC and backslashes", () => {
    expect(isWindowsPath("C:\\x")).toBe(true);
    expect(isWindowsPath("c:/x")).toBe(true);
    expect(isWindowsPath("\\\\srv\\share")).toBe(true);
    expect(isWindowsPath("/home/me")).toBe(false);
  });
});
