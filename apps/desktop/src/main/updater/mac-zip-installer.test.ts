import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupMacUpdateArtifacts,
  createMacZipInstaller,
  type ExecFile,
  type HttpResponse,
  macBackupPath,
} from "./mac-zip-installer";
import type { UpdateCandidate } from "./update-controller";
import { UpdateInstallError } from "./update-errors";

const ZIP = Buffer.from("PK fake zip bytes for the update ".repeat(64));
const SHA512 = createHash("sha512").update(ZIP).digest("base64");
const BASE = "https://github.com/stoltembergg-png/modus/releases/download/v1.1.0";

function candidate(
  overrides: Partial<{ sha512: string; size: number; url: string }> = {},
): UpdateCandidate {
  return {
    version: "1.1.0",
    files: [
      { url: `${BASE}/Modus-1.1.0-mac-x64.zip`, sha512: "other", size: 1 },
      {
        url: overrides.url ?? `${BASE}/Modus-1.1.0-mac-arm64.zip`,
        sha512: overrides.sha512 ?? SHA512,
        size: overrides.size ?? ZIP.length,
      },
    ],
  };
}

function response(statusCode: number, body: Buffer[] = [], headers: HttpResponse["headers"] = {}) {
  return {
    statusCode,
    headers,
    abort: vi.fn(),
    body: (async function* () {
      for (const chunk of body) yield new Uint8Array(chunk);
    })(),
  };
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

describe("mac zip installer", () => {
  let root: string;
  let workDir: string;
  let bundlePath: string;
  let plist: Record<string, string>;
  let codesignOk: boolean;

  const exec = vi.fn<ExecFile>(async (file, args) => {
    if (file === "/usr/bin/ditto") {
      const app = join(args[3] ?? "", "Modus.app", "Contents");
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, "Info.plist"), "<plist/>");
      return { stdout: "" };
    }
    if (file === "/usr/bin/plutil") return { stdout: `${plist[args[1] ?? ""] ?? ""}\n` };
    if (file === "/usr/bin/codesign") {
      if (!codesignOk) throw new Error("code object is not signed at all");
      return { stdout: "" };
    }
    throw new Error(`unexpected exec ${file}`);
  });

  let attempt = 0;
  const attemptDir = (n: number) => join(workDir, "attempts", `1.1.0-a${n}`);
  const attemptsLeft = () =>
    existsSync(join(workDir, "attempts")) ? readdirSync(join(workDir, "attempts")) : [];

  const makeInstaller = (overrides: Partial<Parameters<typeof createMacZipInstaller>[0]> = {}) => {
    const deps = {
      newAttemptId: () => `a${++attempt}`,
      bundlePath,
      isInApplicationsFolder: () => true,
      arm64Mac: true,
      workDir,
      pid: 4242,
      httpGet: vi.fn(async (_url: string) =>
        response(200, [ZIP.subarray(0, 100), ZIP.subarray(100)]),
      ),
      exec,
      spawnDetached: vi.fn(),
      quit: vi.fn(),
      logger,
      isWritable: vi.fn(async () => true),
      ...overrides,
    };
    return { installer: createMacZipInstaller(deps), deps };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "modus-mac-installer-"));
    workDir = join(root, "userData", "updater");
    bundlePath = join(root, "Applications", "Modus.app");
    mkdirSync(bundlePath, { recursive: true });
    plist = { CFBundleIdentifier: "dev.modus.desktop", CFBundleShortVersionString: "1.1.0" };
    codesignOk = true;
    attempt = 0;
    exec.mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("downloads the arm64 zip, verifies it, extracts with ditto and checks the bundle", async () => {
    const { installer, deps } = makeInstaller();
    const progress: number[] = [];
    await installer.download(candidate(), (percent) => progress.push(percent));
    expect(deps.httpGet).toHaveBeenCalledWith(`${BASE}/Modus-1.1.0-mac-arm64.zip`);
    expect(progress.at(-1)).toBe(100);
    const extractDir = join(attemptDir(1), "extracted");
    expect(exec).toHaveBeenCalledWith("/usr/bin/ditto", [
      "-x",
      "-k",
      join(attemptDir(1), "update.zip"),
      extractDir,
    ]);
    expect(exec).toHaveBeenCalledWith("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      join(extractDir, "Modus.app"),
    ]);
    expect(existsSync(join(attemptDir(1), "update.zip"))).toBe(false);
  });

  it("follows allowlisted redirects to GitHub's asset CDN", async () => {
    const httpGet = vi
      .fn()
      .mockResolvedValueOnce(
        response(302, [], { location: "https://release-assets.githubusercontent.com/x?sig=1" }),
      )
      .mockResolvedValueOnce(response(200, [ZIP]));
    const { installer } = makeInstaller({ httpGet });
    await installer.download(candidate(), () => {});
    expect(httpGet).toHaveBeenLastCalledWith(
      "https://release-assets.githubusercontent.com/x?sig=1",
    );
  });

  it("rejects redirects outside the allowlist and cleans up", async () => {
    const httpGet = vi
      .fn()
      .mockResolvedValue(response(302, [], { location: "http://evil.example/Modus.zip" }));
    const { installer } = makeInstaller({ httpGet });
    await expect(installer.download(candidate(), () => {})).rejects.toThrow(
      "Refusing update redirect",
    );
    expect(httpGet).toHaveBeenCalledTimes(1);
    expect(attemptsLeft()).toEqual([]);
  });

  it("aborts on a sha512 mismatch, keeps the current app and removes temp files", async () => {
    const { installer, deps } = makeInstaller();
    const wrong = createHash("sha512").update("other").digest("base64");
    const error = await installer.download(candidate({ sha512: wrong }), () => {}).catch((e) => e);
    expect(error).toBeInstanceOf(UpdateInstallError);
    expect(error.message).toContain("sha512 mismatch");
    expect(error.retryable).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(attemptsLeft()).toEqual([]);
    expect(existsSync(bundlePath)).toBe(true);
    await expect(installer.install(candidate())).rejects.toThrow("not downloaded");
    expect(deps.spawnDetached).not.toHaveBeenCalled();
  });

  it("aborts when the download is larger or smaller than expected", async () => {
    const { installer } = makeInstaller();
    await expect(installer.download(candidate({ size: 100 }), () => {})).rejects.toThrow(
      "larger than expected",
    );
    await expect(installer.download(candidate({ size: ZIP.length + 1 }), () => {})).rejects.toThrow(
      "size mismatch",
    );
    expect(attemptsLeft()).toEqual([]);
  });

  it("fails retryably on HTTP errors", async () => {
    const { installer } = makeInstaller({ httpGet: vi.fn(async () => response(404)) });
    await expect(installer.download(candidate(), () => {})).rejects.toMatchObject({
      retryable: true,
      message: "Update download failed with HTTP 404",
    });
  });

  it("rejects a wrong bundle id, a wrong version or a failed codesign check", async () => {
    const { installer } = makeInstaller();
    plist.CFBundleIdentifier = "com.evil.app";
    await expect(installer.download(candidate(), () => {})).rejects.toMatchObject({
      message: "Unexpected bundle id com.evil.app",
      retryable: false,
      action: "download-page",
    });
    plist.CFBundleIdentifier = "dev.modus.desktop";
    plist.CFBundleShortVersionString = "1.0.9";
    await expect(installer.download(candidate(), () => {})).rejects.toThrow(
      "Unexpected bundle version",
    );
    plist.CFBundleShortVersionString = "1.1.0";
    codesignOk = false;
    await expect(installer.download(candidate(), () => {})).rejects.toThrow(
      "codesign verification",
    );
    expect(attemptsLeft()).toEqual([]);
  });

  it("offers the release page when the install location cannot be replaced", async () => {
    expect(await makeInstaller().installer.actionFor(candidate())).toBe("install");
    expect(
      await makeInstaller({ isInApplicationsFolder: () => false }).installer.actionFor(candidate()),
    ).toBe("download-page");
    expect(
      await makeInstaller({ isWritable: vi.fn(async () => false) }).installer.actionFor(
        candidate(),
      ),
    ).toBe("download-page");
    expect(
      await makeInstaller({
        bundlePath: "/private/var/folders/x/AppTranslocation/1/d/Modus.app",
      }).installer.actionFor(candidate()),
    ).toBe("download-page");
    expect(
      await makeInstaller({ bundlePath: "/Volumes/Modus 1.1.0/Modus.app" }).installer.actionFor(
        candidate(),
      ),
    ).toBe("download-page");
    expect(
      await makeInstaller().installer.actionFor(
        candidate({ url: "https://evil.example/Modus-arm64.zip" }),
      ),
    ).toBe("download-page");
  });

  it("spawns the detached swap script and quits", async () => {
    const { installer, deps } = makeInstaller();
    await installer.download(candidate(), () => {});
    await installer.install(candidate());
    expect(deps.spawnDetached).toHaveBeenCalledTimes(1);
    const [file, args, logPath] = vi.mocked(deps.spawnDetached).mock.calls[0] ?? [];
    expect(file).toBe("/bin/sh");
    expect(args?.slice(3)).toEqual([
      "4242",
      bundlePath,
      join(attemptDir(1), "extracted", "Modus.app"),
      macBackupPath(bundlePath),
      "/usr/bin/open",
      "/usr/bin/xattr",
      "6000",
      join(workDir, "install.lock"),
    ]);
    expect(logPath).toBe(join(workDir, "install.log"));
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  it("fails with EACCES when the Applications folder stopped being writable", async () => {
    const isWritable = vi.fn(async () => true);
    const { installer, deps } = makeInstaller({ isWritable });
    await installer.download(candidate(), () => {});
    isWritable.mockResolvedValue(false);
    await expect(installer.install(candidate())).rejects.toMatchObject({ code: "EACCES" });
    expect(deps.spawnDetached).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
  });

  it("removes the backup and staging directory on the next start", async () => {
    mkdirSync(macBackupPath(bundlePath), { recursive: true });
    mkdirSync(attemptDir(1), { recursive: true });
    mkdirSync(join(workDir, "install.lock"));
    writeFileSync(join(workDir, "install.log"), "[modus-update] installed\n");
    logger.info.mockClear();
    await cleanupMacUpdateArtifacts({ bundlePath, workDir, logger });
    expect(logger.info).toHaveBeenCalledWith("previous update install: [modus-update] installed");
    expect(existsSync(macBackupPath(bundlePath))).toBe(false);
    expect(existsSync(workDir)).toBe(false); // attempts, stale lock and log
    expect(readdirSync(join(root, "Applications"))).toEqual(["Modus.app"]);
  });

  it("stages every download attempt in its own directory", async () => {
    const { installer } = makeInstaller();
    await installer.download(candidate(), () => {});
    await installer.download(candidate(), () => {});
    // The first attempt was never handed to a script, so it is replaced.
    expect(attemptsLeft()).toEqual(["1.1.0-a2"]);
  });

  it("never touches a staging directory already handed to an install script", async () => {
    const { installer, deps } = makeInstaller();
    await installer.download(candidate(), () => {});
    await installer.install(candidate());
    // Watchdog fired, the user retries: the first script still waits on attempt 1.
    await installer.download(candidate(), () => {});
    await installer.install(candidate());
    expect(attemptsLeft().sort()).toEqual(["1.1.0-a1", "1.1.0-a2"]);
    const staged = vi.mocked(deps.spawnDetached).mock.calls.map(([, args]) => args[5]);
    expect(staged).toEqual([
      join(attemptDir(1), "extracted", "Modus.app"),
      join(attemptDir(2), "extracted", "Modus.app"),
    ]);
    expect(existsSync(join(attemptDir(1), "extracted", "Modus.app"))).toBe(true);
  });
});
