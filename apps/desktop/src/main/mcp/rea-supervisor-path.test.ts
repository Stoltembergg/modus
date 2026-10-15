import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveReaSupervisorPath } from "./rea-supervisor-path";

describe("resolveReaSupervisorPath", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("prefers the packaged resources/bin supervisor", () => {
    root = mkdtempSync(join(tmpdir(), "modus-rea-path-"));
    const packaged = join(root, "resources", "bin", "modus-rea-process-supervisor.exe");
    const development = join(root, "target", "release", "modus-rea-process-supervisor.exe");
    mkdirSync(join(root, "resources", "bin"), { recursive: true });
    mkdirSync(join(root, "target", "release"), { recursive: true });
    writeFileSync(packaged, "packaged");
    writeFileSync(development, "development");

    expect(
      resolveReaSupervisorPath({
        resourcesPath: join(root, "resources"),
        cwd: root,
        moduleDirectory: join(root, "src"),
        platform: "win32",
        isPackaged: true,
      }),
    ).toBe(packaged);
  });

  it("never falls back to cwd development binaries in packaged mode", () => {
    root = mkdtempSync(join(tmpdir(), "modus-rea-path-"));
    const development = join(root, "target", "release", "modus-rea-process-supervisor");
    mkdirSync(join(root, "target", "release"), { recursive: true });
    writeFileSync(development, "fake development binary");

    expect(() =>
      resolveReaSupervisorPath({
        resourcesPath: join(root, "resources-without-supervisor"),
        cwd: root,
        moduleDirectory: join(root, "src"),
        platform: "linux",
        isPackaged: true,
      }),
    ).toThrow(/not found/i);
  });

  it("resolves the development release binary when no packaged binary exists", () => {
    root = mkdtempSync(join(tmpdir(), "modus-rea-path-"));
    const releaseBinary = join(root, "target", "release", "modus-rea-process-supervisor");
    mkdirSync(join(root, "target", "release"), { recursive: true });
    writeFileSync(releaseBinary, "development");

    expect(
      resolveReaSupervisorPath({
        cwd: root,
        moduleDirectory: join(root, "src"),
        platform: "linux",
      }),
    ).toBe(releaseBinary);
  });
});
