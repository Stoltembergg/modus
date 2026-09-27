import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { macInstallScriptArgs } from "./mac-install-script";

// Runs the real script with /bin/sh against a fake bundle layout; `open`/`xattr` are shims.
const describePosix = process.platform === "win32" ? describe.skip : describe;
const EXITED_PID = 999_999_999;

describePosix("mac install script", () => {
  let root: string;
  let apps: string;
  let calls: string;

  const writeShim = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const bundle = (path: string, version: string) => {
    mkdirSync(join(path, "Contents"), { recursive: true });
    writeFileSync(join(path, "Contents", "version"), version);
  };
  const run = (overrides: { open?: string; pid?: number; maxWaitTicks?: number } = {}) => {
    const args = macInstallScriptArgs({
      pid: overrides.pid ?? EXITED_PID,
      bundlePath: join(apps, "Modus.app"),
      stagedAppPath: join(root, "staged", "Modus.app"),
      backupPath: join(apps, ".Modus.app.update-backup"),
      openBin: overrides.open ?? writeShim("open", "exit 0"),
      xattrBin: writeShim("xattr", "exit 0"),
      maxWaitTicks: overrides.maxWaitTicks ?? 5,
    });
    return spawnSync("/bin/sh", args, { encoding: "utf8" });
  };
  const version = (path: string) => readFileSync(join(path, "Contents", "version"), "utf8");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "modus-mac-script-"));
    apps = join(root, "Applications");
    calls = join(root, "calls.log");
    bundle(join(apps, "Modus.app"), "1.0.0");
    bundle(join(root, "staged", "Modus.app"), "1.1.0");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("swaps the bundle, clears quarantine and relaunches", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(version(join(apps, "Modus.app"))).toBe("1.1.0");
    expect(version(join(apps, ".Modus.app.update-backup"))).toBe("1.0.0");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      `xattr -dr com.apple.quarantine ${join(apps, "Modus.app")}`,
      `open ${join(apps, "Modus.app")}`,
    ]);
  });

  it("restores the previous bundle when the new one fails to launch", () => {
    const result = run({
      open: writeShim(
        "open",
        `[ -f "${root}/opened-once" ] && exit 0; touch "${root}/opened-once"; exit 1`,
      ),
    });
    expect(result.status).toBe(7);
    expect(version(join(apps, "Modus.app"))).toBe("1.0.0");
    expect(existsSync(join(apps, ".Modus.app.update-backup"))).toBe(false);
    expect(readFileSync(calls, "utf8").match(/^open /gm)).toHaveLength(2);
  });

  it("keeps the current bundle and relaunches it when the staged bundle is missing", () => {
    rmSync(join(root, "staged"), { recursive: true });
    const result = run();
    expect(result.status).toBe(4);
    expect(version(join(apps, "Modus.app"))).toBe("1.0.0");
  });

  it("changes nothing when the app never quits", () => {
    const result = run({ pid: process.pid, maxWaitTicks: 2 });
    expect(result.status).toBe(3);
    expect(version(join(apps, "Modus.app"))).toBe("1.0.0");
    expect(existsSync(calls)).toBe(false);
  });
});
