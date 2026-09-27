import { spawn, spawnSync } from "node:child_process";
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
import {
  MAC_INSTALL_EXIT_REASONS,
  MAC_INSTALL_WAIT_TICKS,
  macInstallScriptArgs,
} from "./mac-install-script";

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
  const run = (
    overrides: {
      open?: string;
      pid?: number;
      maxWaitTicks?: number;
      env?: Record<string, string>;
      lockPath?: string;
    } = {},
  ) => {
    const args = macInstallScriptArgs({
      pid: overrides.pid ?? EXITED_PID,
      bundlePath: join(apps, "Modus.app"),
      stagedAppPath: join(root, "staged", "Modus.app"),
      backupPath: join(apps, ".Modus.app.update-backup"),
      openBin: overrides.open ?? writeShim("open", "exit 0"),
      xattrBin: writeShim("xattr", "exit 0"),
      maxWaitTicks: overrides.maxWaitTicks ?? 5,
      lockPath: overrides.lockPath ?? join(root, "install.lock"),
      markerPath: markerPath(),
      version: "1.1.0",
    });
    return spawnSync("/bin/sh", args, {
      encoding: "utf8",
      env: { ...process.env, ...overrides.env },
    });
  };
  const version = (path: string) => readFileSync(join(path, "Contents", "version"), "utf8");
  /**
   * PATH shims for rm/mv that work even as root (where chmod cannot make files
   * undeletable): rm "succeeds" but leaves $SHIM_RM_KEEP in place, and mv fails for
   * the source $SHIM_MV_FAIL. Everything else goes to the real binaries.
   */
  const shimPath = () => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const real = (name: string) =>
      spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(bin, "rm"),
      `#!/bin/sh\nfor a; do last="$a"; done\n[ -n "\${SHIM_RM_KEEP:-}" ] && [ "$last" = "$SHIM_RM_KEEP" ] && exit 0\nexec ${real("rm")} "$@"\n`,
    );
    writeFileSync(
      join(bin, "mv"),
      `#!/bin/sh\n[ -n "\${SHIM_MV_FAIL:-}" ] && [ "$1" = "$SHIM_MV_FAIL" ] && exit 1\nexec ${real("mv")} "$@"\n`,
    );
    chmodSync(join(bin, "rm"), 0o755);
    chmodSync(join(bin, "mv"), 0o755);
    return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  };
  const markerPath = () => join(root, "install-failure.json");
  const marker = () => JSON.parse(readFileSync(markerPath(), "utf8"));
  const expectMarker = (code: number) =>
    expect(marker()).toEqual({
      code,
      reason: MAC_INSTALL_EXIT_REASONS[code],
      version: "1.1.0",
    });
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const backupPath = () => join(apps, ".Modus.app.update-backup");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "modus-mac-script-"));
    apps = join(root, "Applications");
    calls = join(root, "calls.log");
    bundle(join(apps, "Modus.app"), "1.0.0");
    bundle(join(root, "staged", "Modus.app"), "1.1.0");
  });

  afterEach(() => {
    // Undo read-only fixtures so the temp dir can be removed.
    spawnSync("/bin/sh", ["-c", `chmod -R u+w "${root}" 2>/dev/null`]);
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

  it("never nests the app into a backup that could not be removed (read-only dir)", () => {
    if (isRoot) return; // root can delete read-only dirs; the PATH-shim test covers root.
    const stuck = join(backupPath(), "junk");
    bundle(backupPath(), "0.9.0");
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, "file"), "old");
    chmodSync(stuck, 0o555);
    const result = run();
    expect(result.status).toBe(8);
    expect(result.stdout).toContain("failed (8 backup-not-removed)");
    expect(version(join(apps, "Modus.app"))).toBe("1.0.0");
    expect(existsSync(join(backupPath(), "Modus.app"))).toBe(false);
    expect(version(join(root, "staged", "Modus.app"))).toBe("1.1.0");
    expect(readFileSync(calls, "utf8").trim()).toBe(`open ${join(apps, "Modus.app")}`);
  });

  it("checks that the backup is really gone, not rm's exit status (works as root)", () => {
    bundle(backupPath(), "0.9.0");
    const result = run({ env: { PATH: shimPath(), SHIM_RM_KEEP: backupPath() } });
    expect(result.status).toBe(8);
    expect(version(join(apps, "Modus.app"))).toBe("1.0.0");
    expect(version(backupPath())).toBe("0.9.0");
    expect(existsSync(join(backupPath(), "Modus.app"))).toBe(false);
  });

  it("rollback never moves the backup into a new bundle it could not remove", () => {
    const current = join(apps, "Modus.app");
    const result = run({
      open: writeShim("open", `[ "$1" = "${current}" ] && exit 1; exit 0`),
      env: { PATH: shimPath(), SHIM_RM_KEEP: current },
    });
    expect(result.status).toBe(9);
    expect(result.stdout).toContain("failed (9 rollback-remove-failed)");
    // The previous version stays intact at the backup path and is launched from there.
    expect(version(backupPath())).toBe("1.0.0");
    expect(existsSync(join(current, ".Modus.app.update-backup"))).toBe(false);
    expect(existsSync(join(current, "Modus.app"))).toBe(false);
    expect(readFileSync(calls, "utf8")).toContain(`open ${backupPath()}`);
  });

  it("rollback with a read-only file in the new bundle keeps the backup separate", () => {
    if (isRoot) return;
    const current = join(apps, "Modus.app");
    const stuck = join(root, "staged", "Modus.app", "Contents", "Frameworks");
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, "lib"), "new");
    chmodSync(stuck, 0o555);
    const result = run({ open: writeShim("open", `[ "$1" = "${current}" ] && exit 1; exit 0`) });
    expect(result.status).toBe(9);
    expect(version(backupPath())).toBe("1.0.0");
    expect(existsSync(join(current, ".Modus.app.update-backup"))).toBe(false);
  });

  it("launches the backup where it is when it cannot be moved back", () => {
    const current = join(apps, "Modus.app");
    const result = run({
      open: writeShim("open", `[ "$1" = "${current}" ] && exit 1; exit 0`),
      env: { PATH: shimPath(), SHIM_MV_FAIL: backupPath() },
    });
    expect(result.status).toBe(10);
    expect(version(backupPath())).toBe("1.0.0");
    expect(existsSync(current)).toBe(false);
    expect(readFileSync(calls, "utf8")).toContain(`open ${backupPath()}`);
  });

  it("exits without touching anything when another install holds the lock", () => {
    mkdirSync(join(root, "install.lock"));
    const result = run();
    expect(result.status).toBe(11);
    expect(result.stdout).toContain("failed (11 install-in-progress)");
    expect(version(join(apps, "Modus.app"))).toBe("1.0.0");
    expect(version(join(root, "staged", "Modus.app"))).toBe("1.1.0");
    expect(existsSync(calls)).toBe(false);
    // The lock belongs to the other script and stays.
    expect(existsSync(join(root, "install.lock"))).toBe(true);
  });

  it("releases the lock when it finishes, on success and on failure", () => {
    expect(run().status).toBe(0);
    expect(existsSync(join(root, "install.lock"))).toBe(false);
    bundle(join(root, "staged", "Modus.app"), "1.2.0");
    expect(run({ pid: process.pid, maxWaitTicks: 1 }).status).toBe(3);
    expect(existsSync(join(root, "install.lock"))).toBe(false);
  });

  it("holds the lock while waiting, so a second script started meanwhile backs off", () => {
    const args = macInstallScriptArgs({
      pid: process.pid,
      bundlePath: join(apps, "Modus.app"),
      stagedAppPath: join(root, "staged", "Modus.app"),
      backupPath: backupPath(),
      openBin: writeShim("open", "exit 0"),
      xattrBin: writeShim("xattr", "exit 0"),
      maxWaitTicks: 20,
      lockPath: join(root, "install.lock"),
      markerPath: markerPath(),
      version: "1.1.0",
    });
    const first = spawn("/bin/sh", args, { stdio: "ignore" });
    try {
      const deadline = Date.now() + 2000;
      while (!existsSync(join(root, "install.lock")) && Date.now() < deadline) {
        spawnSync("sleep", ["0.05"]);
      }
      expect(run().status).toBe(11);
    } finally {
      first.kill("SIGTERM");
    }
  });

  it("waits about 10 minutes for the app to quit by default", () => {
    expect(MAC_INSTALL_WAIT_TICKS).toBe(6000);
    const args = macInstallScriptArgs({
      pid: 1,
      bundlePath: "/Applications/Modus.app",
      stagedAppPath: "/s/Modus.app",
      backupPath: "/Applications/.Modus.app.update-backup",
      lockPath: "/u/install.lock",
      markerPath: "/u/install-failure.json",
      version: "1.1.0",
    });
    expect(args.slice(-4)).toEqual(["6000", "/u/install.lock", "/u/install-failure.json", "1.1.0"]);
  });

  describe("failure marker", () => {
    const current = () => join(apps, "Modus.app");
    const failCurrentOpen = () => writeShim("open", `[ "$1" = "${current()}" ] && exit 1; exit 0`);

    it("is written for app-did-not-quit (3) without touching or reopening anything", () => {
      expect(run({ pid: process.pid, maxWaitTicks: 1 }).status).toBe(3);
      expectMarker(3);
      expect(version(current())).toBe("1.0.0");
      expect(existsSync(calls)).toBe(false);
    });

    it("is written for staged-missing (4) and the old app is reopened", () => {
      rmSync(join(root, "staged"), { recursive: true });
      expect(run().status).toBe(4);
      expectMarker(4);
      expect(readFileSync(calls, "utf8").trim()).toBe(`open ${current()}`);
    });

    it("is written for move-current-failed (5); nothing moved, old app reopened", () => {
      expect(run({ env: { PATH: shimPath(), SHIM_MV_FAIL: current() } }).status).toBe(5);
      expectMarker(5);
      expect(version(current())).toBe("1.0.0");
      expect(readFileSync(calls, "utf8").trim()).toBe(`open ${current()}`);
    });

    it("is written for move-new-failed (6) after restoring and reopening the old app", () => {
      const staged = join(root, "staged", "Modus.app");
      expect(run({ env: { PATH: shimPath(), SHIM_MV_FAIL: staged } }).status).toBe(6);
      expectMarker(6);
      expect(version(current())).toBe("1.0.0");
      expect(existsSync(backupPath())).toBe(false);
      expect(readFileSync(calls, "utf8").trim()).toBe(`open ${current()}`);
    });

    it("is written for launch-failed (7) after restoring the old app", () => {
      expect(run({ open: failCurrentOpen() }).status).toBe(7);
      expectMarker(7);
      expect(version(current())).toBe("1.0.0");
    });

    it("is written for backup-not-removed (8)", () => {
      bundle(backupPath(), "0.9.0");
      const result = run({ env: { PATH: shimPath(), SHIM_RM_KEEP: backupPath() } });
      expect(result.status).toBe(8);
      expectMarker(8);
    });

    it("is written for rollback failures (9, 10), launching the backup where it is", () => {
      expect(
        run({ open: failCurrentOpen(), env: { PATH: shimPath(), SHIM_RM_KEEP: current() } }).status,
      ).toBe(9);
      expectMarker(9);
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      bundle(current(), "1.0.0");
      bundle(join(root, "staged", "Modus.app"), "1.1.0");
      expect(
        run({ open: failCurrentOpen(), env: { PATH: shimPath(), SHIM_MV_FAIL: backupPath() } })
          .status,
      ).toBe(10);
      expectMarker(10);
      expect(readFileSync(calls, "utf8")).toContain(`open ${backupPath()}`);
    });

    it("is written for install-in-progress (11) and lock-unavailable (12)", () => {
      mkdirSync(join(root, "install.lock"));
      expect(run().status).toBe(11);
      expectMarker(11);
      expect(run({ lockPath: join(root, "missing", "install.lock") }).status).toBe(12);
      expectMarker(12);
      expect(version(current())).toBe("1.0.0");
    });

    it("is removed by a successful install", () => {
      writeFileSync(markerPath(), '{"code":3}');
      expect(run().status).toBe(0);
      expect(existsSync(markerPath())).toBe(false);
    });
  });
});
