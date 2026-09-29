import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  macInstallFailurePath,
  previousInstallFailure,
  restorePreviousMacInstallFailure,
  takeMacInstallFailure,
} from "./mac-install-failure";
import { macInstallScriptArgs } from "./mac-install-script";
import { macInstallLockPath } from "./mac-zip-installer";
import { createUpdateController, type UpdateCandidate } from "./update-controller";
import { RELEASES_URL } from "./update-policy";

const describePosix = process.platform === "win32" ? describe.skip : describe;
// MODUS_SCRIPT_SHELL="bash --posix" runs the script the way macOS's /bin/sh does.
const [SCRIPT_SHELL = "/bin/sh", ...SCRIPT_SHELL_FLAGS] = (
  process.env.MODUS_SCRIPT_SHELL ?? "/bin/sh"
)
  .split(" ")
  .filter(Boolean);
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() });

function controllerFor(check: () => Promise<UpdateCandidate | null>) {
  const installer = {
    actionFor: vi.fn(async () => "install" as const),
    download: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
  };
  const openExternal = vi.fn(async (_url: string) => undefined);
  const controller = createUpdateController({
    currentVersion: "1.0.0",
    source: { check: vi.fn(check) },
    installer,
    agents: { hasActiveTurns: () => false },
    timers: { setTimeout: () => undefined, clearTimeout: () => undefined },
    logger: logger(),
    now: () => 0,
    openExternal,
    beforeInstallRestart: () => undefined,
  });
  return { controller, installer, openExternal };
}

describePosix("mac install failure marker, end to end", () => {
  let root: string;
  let workDir: string;
  let apps: string;

  const bundle = (path: string) => mkdirSync(join(path, "Contents"), { recursive: true });
  const shim = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  /** Runs the real install script, as the installer would spawn it, with failing `open`. */
  const runScript = (options: { pid?: number; maxWaitTicks?: number; openFails?: boolean }) =>
    spawnSync(
      SCRIPT_SHELL,
      [
        ...SCRIPT_SHELL_FLAGS,
        ...macInstallScriptArgs({
          pid: options.pid ?? 999_999_999,
          bundlePath: join(apps, "Modus.app"),
          stagedAppPath: join(workDir, "attempts", "1.1.0-a1", "extracted", "Modus.app"),
          backupPath: join(apps, ".Modus.app.update-backup"),
          lockPath: macInstallLockPath(workDir),
          markerPath: macInstallFailurePath(workDir),
          version: "1.1.0",
          openBin: shim(
            "open",
            options.openFails
              ? `[ "$1" = "${join(apps, "Modus.app")}" ] && exit 1; exit 0`
              : "exit 0",
          ),
          xattrBin: shim("xattr", "exit 0"),
          maxWaitTicks: options.maxWaitTicks ?? 5,
        }),
      ],
      { encoding: "utf8" },
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "modus-mac-failure-"));
    workDir = join(root, "userData", "updater");
    apps = join(root, "Applications");
    bundle(join(apps, "Modus.app"));
    bundle(join(workDir, "attempts", "1.1.0-a1", "extracted", "Modus.app"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a failed swap becomes a retryable failed state with the release page on next start", async () => {
    expect(runScript({ openFails: true }).status).toBe(7);
    expect(existsSync(macInstallFailurePath(workDir))).toBe(true);

    const { controller, openExternal } = controllerFor(async () => null);
    const log = logger();
    await restorePreviousMacInstallFailure({
      workDir,
      currentVersion: "1.0.0",
      logger: log,
      report: (failure) => controller.reportPreviousFailure(failure),
    });

    expect(controller.getState()).toEqual({
      status: "failed",
      version: "1.1.0",
      retryable: true,
      action: "download-page",
    });
    expect(existsSync(macInstallFailurePath(workDir))).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      "previous update install of 1.1.0 failed: launch-failed (exit 7)",
    );
    await controller.retry();
    expect(openExternal).toHaveBeenCalledWith(`${RELEASES_URL}/tag/v1.1.0`);
  });

  it("app-did-not-quit is retried in place: retry looks the release up and downloads", async () => {
    expect(runScript({ pid: process.pid, maxWaitTicks: 1 }).status).toBe(3);
    const candidate: UpdateCandidate = {
      version: "1.1.0",
      files: [
        {
          url: `${RELEASES_URL}/download/v1.1.0/Modus-1.1.0-mac-arm64.zip`,
          sha512: "x",
          size: 1,
        },
      ],
    };
    const { controller, installer } = controllerFor(async () => candidate);
    await restorePreviousMacInstallFailure({
      workDir,
      currentVersion: "1.0.0",
      logger: logger(),
      report: (failure) => controller.reportPreviousFailure(failure),
    });
    expect(controller.getState()).toMatchObject({ status: "failed", action: "install" });
    await controller.retry();
    expect(installer.download).toHaveBeenCalledWith(candidate, expect.any(Function));
    expect(controller.getState()).toEqual({ status: "installing", version: "1.1.0" });
  });

  it("is ignored (and deleted) when the target version is already running", async () => {
    expect(runScript({ openFails: true }).status).toBe(7);
    const report = vi.fn();
    const result = await restorePreviousMacInstallFailure({
      workDir,
      currentVersion: "1.1.0",
      logger: logger(),
      report,
    });
    expect(result).toBeNull();
    expect(report).not.toHaveBeenCalled();
    expect(existsSync(macInstallFailurePath(workDir))).toBe(false);
  });

  it("drops malformed markers and returns null when there is none", async () => {
    const log = logger();
    expect(await takeMacInstallFailure(workDir, log)).toBeNull();
    writeFileSync(macInstallFailurePath(workDir), "{not json");
    expect(await takeMacInstallFailure(workDir, log)).toBeNull();
    expect(existsSync(macInstallFailurePath(workDir))).toBe(false);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("malformed"));
  });
});

describe("previousInstallFailure", () => {
  it("offers the release page when the bundle could not be replaced", () => {
    for (const code of [5, 6, 7, 8, 9, 10]) {
      expect(
        previousInstallFailure({ code, reason: "x", version: "1.1.0" }, "1.0.0"),
      ).toMatchObject({ retryable: true, action: "download-page" });
    }
    for (const code of [3, 4, 11, 12]) {
      expect(
        previousInstallFailure({ code, reason: "x", version: "1.1.0" }, "1.0.0"),
      ).toMatchObject({ retryable: true, action: "install" });
    }
  });
});
