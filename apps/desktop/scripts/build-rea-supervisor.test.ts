import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReaSupervisor, resolveReaRustTarget } from "./build-rea-supervisor.mjs";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function fixtureRoot(): string {
  root = mkdtempSync(join(tmpdir(), "modus-rea-build-"));
  return root;
}

describe("build-rea-supervisor", () => {
  it.each([
    ["darwin", "arm64", "aarch64-apple-darwin"],
    ["darwin", "x64", "x86_64-apple-darwin"],
    ["linux", "arm64", "aarch64-unknown-linux-gnu"],
    ["linux", "x64", "x86_64-unknown-linux-gnu"],
    ["win32", "arm64", "aarch64-pc-windows-msvc"],
    ["win32", "x64", "x86_64-pc-windows-msvc"],
  ])("maps %s/%s to %s", (platform, arch, target) => {
    expect(resolveReaRustTarget({ platform, arch })).toBe(target);
  });

  it("uses an explicit cross-target artifact and stages only that file", () => {
    const repoRoot = fixtureRoot();
    const target = "aarch64-apple-darwin";
    const expectedSource = join(
      repoRoot,
      "target",
      target,
      "release",
      "modus-rea-process-supervisor",
    );
    mkdirSync(join(repoRoot, "target", target, "release"), { recursive: true });
    writeFileSync(expectedSource, "arm64-target-binary");
    const spawn = vi.fn(() => ({ status: 0 }));

    const result = buildReaSupervisor({ repoRoot, target, spawn });

    expect(spawn).toHaveBeenCalledWith(
      "cargo",
      ["build", "--locked", "--release", "-p", "modus-rea-process-supervisor", "--target", target],
      { cwd: repoRoot, stdio: "inherit" },
    );
    expect(result.source).toBe(expectedSource);
    expect(readFileSync(result.staged, "utf8")).toBe("arm64-target-binary");
    expect(result.staged).toBe(
      resolve(repoRoot, "target", "release", "modus-rea-process-supervisor"),
    );
  });

  it("preserves the Windows executable suffix while selecting the target triple", () => {
    const repoRoot = fixtureRoot();
    const target = "x86_64-pc-windows-msvc";
    const source = join(repoRoot, "target", target, "release", "modus-rea-process-supervisor.exe");
    mkdirSync(join(repoRoot, "target", target, "release"), { recursive: true });
    writeFileSync(source, "windows-target-binary");

    const result = buildReaSupervisor({ repoRoot, target, spawn: () => ({ status: 0 }) });

    expect(result.staged.endsWith("modus-rea-process-supervisor.exe")).toBe(true);
    expect(readFileSync(result.staged, "utf8")).toBe("windows-target-binary");
  });

  it("rejects unsupported target triples before invoking Cargo", () => {
    const spawn = vi.fn();
    expect(() =>
      buildReaSupervisor({
        repoRoot: fixtureRoot(),
        target: "x86_64-unknown-freebsd" as never,
        spawn,
      }),
    ).toThrow(/Unsupported REA supervisor Rust target/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a failed Cargo build and a missing target artifact", () => {
    const repoRoot = fixtureRoot();
    const target = "x86_64-apple-darwin";
    expect(() => buildReaSupervisor({ repoRoot, target, spawn: () => ({ status: 101 }) })).toThrow(
      /failed with status 101/,
    );
    expect(() => buildReaSupervisor({ repoRoot, target, spawn: () => ({ status: 0 }) })).toThrow(
      /target binary is missing/,
    );
  });

  it("propagates Cargo startup errors without staging a host binary", () => {
    const repoRoot = fixtureRoot();
    const error = new Error("cargo missing");
    expect(() =>
      buildReaSupervisor({
        repoRoot,
        target: "x86_64-apple-darwin",
        spawn: () => ({ status: null, error }),
        exists: () => true,
        copy: copyFileSync,
      }),
    ).toThrow(error);
  });
});
