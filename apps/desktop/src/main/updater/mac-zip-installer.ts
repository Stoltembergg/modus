import { createHash, randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { macInstallFailurePath } from "./mac-install-failure";
import { MAC_INSTALL_WAIT_MS, macInstallScriptArgs } from "./mac-install-script";
import type { PlatformInstaller, UpdateCandidate, UpdateLogger } from "./update-controller";
import { UpdateInstallError } from "./update-errors";
import {
  APP_BUNDLE_ID,
  appliesOnQuitFor,
  isAllowedDownloadRedirect,
  isAllowedReleaseAssetUrl,
  macInstallBlocker,
  selectMacZip,
  type UpdateFile,
} from "./update-policy";

/**
 * macOS installer for unsigned (ad-hoc signed) builds. electron-updater only checks;
 * its MacUpdater would hand the zip to Squirrel.Mac, which rejects unsigned apps.
 * Here: download the zip ourselves (no Chromium download manager, so no quarantine),
 * verify sha512 + size, extract with ditto, verify the bundle, then a detached script
 * swaps the bundle after the app quits.
 */

export type HttpResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Releases the connection when the body is abandoned. */
  abort(): void;
};
/** GET without following redirects (each hop is validated here). */
export type HttpGet = (url: string) => Promise<HttpResponse>;
export type ExecFile = (file: string, args: string[]) => Promise<{ stdout: string }>;
export type SpawnDetached = (file: string, args: string[], logPath: string) => void;

export type MacZipInstallerDeps = {
  /** /Applications/Modus.app (the running bundle). */
  bundlePath: string;
  isInApplicationsFolder: () => boolean;
  arm64Mac: boolean;
  /** Private staging directory (userData/updater). */
  workDir: string;
  pid: number;
  httpGet: HttpGet;
  exec: ExecFile;
  spawnDetached: SpawnDetached;
  quit: () => void;
  logger: UpdateLogger;
  isWritable?: (dir: string) => Promise<boolean>;
  /** Abort when no bytes arrive for this long. */
  stallTimeoutMs?: number;
  /** Unique id per download attempt (staging directory name). */
  newAttemptId?: () => string;
};

const MAX_REDIRECTS = 5;
const STALL_TIMEOUT_MS = 60_000;

export function macBackupPath(bundlePath: string): string {
  return join(dirname(bundlePath), `.${basename(bundlePath)}.update-backup`);
}

/** Held (mkdir) by the detached install script so two scripts never swap at once. */
export function macInstallLockPath(workDir: string): string {
  return join(workDir, "install.lock");
}

function defaultAttemptId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export async function isDirWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs on startup (after takeMacInstallFailure): a leftover backup means the previous
 * update installed and relaunched.
 */
export async function cleanupMacUpdateArtifacts(input: {
  bundlePath: string;
  workDir: string;
  logger: UpdateLogger;
}): Promise<void> {
  // The detached install script logs here; surface its outcome once before cleaning up.
  try {
    const log = await readFile(join(input.workDir, "install.log"), "utf8");
    const lines = log.trim().split("\n").slice(-5).join(" | ");
    if (lines) input.logger.info(`previous update install: ${lines}`);
  } catch {
    // no previous install
  }
  for (const target of [macBackupPath(input.bundlePath), input.workDir]) {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      // A leftover backup can be hundreds of MB: never drop this silently.
      input.logger.info(`could not remove ${target}: ${String(error)}`);
    }
  }
}

function pageError(message: string, cause?: unknown): UpdateInstallError {
  return new UpdateInstallError(message, { retryable: false, action: "download-page", cause });
}

function retryableError(message: string, cause?: unknown): UpdateInstallError {
  return new UpdateInstallError(message, { retryable: true, action: "install", cause });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function nextChunk(
  iterator: AsyncIterator<Uint8Array>,
  stallTimeoutMs: number,
): Promise<IteratorResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(retryableError("Update download stalled")), stallTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Downloads `file` to `destination`, following only allowlisted HTTPS redirects, and
 * verifies size and sha512 (base64, as in latest-mac.yml) while streaming.
 */
export async function downloadVerifiedFile(input: {
  file: UpdateFile & { size: number };
  version: string;
  destination: string;
  httpGet: HttpGet;
  onProgress: (percent: number) => void;
  stallTimeoutMs?: number;
}): Promise<void> {
  if (!isAllowedReleaseAssetUrl(input.file.url, input.version)) {
    throw pageError(`Refusing update download from ${input.file.url}`);
  }
  let url = input.file.url;
  let response: HttpResponse | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const current = await input.httpGet(url);
    if (current.statusCode >= 300 && current.statusCode < 400) {
      current.abort();
      const location = headerValue(current.headers.location);
      if (!location) throw retryableError(`Redirect without location from ${url}`);
      const next = new URL(location, url).toString();
      if (!isAllowedDownloadRedirect(next)) throw pageError(`Refusing update redirect to ${next}`);
      url = next;
      continue;
    }
    if (current.statusCode !== 200) {
      current.abort();
      throw retryableError(`Update download failed with HTTP ${current.statusCode}`);
    }
    response = current;
    break;
  }
  if (!response) throw retryableError("Too many redirects while downloading the update");

  const hash = createHash("sha512");
  const out = createWriteStream(input.destination, { flags: "wx", mode: 0o600 });
  const outClosed = new Promise<void>((resolve, reject) => {
    out.on("close", resolve);
    out.on("error", reject);
  });
  let received = 0;
  let lastPercent = -1;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    while (true) {
      const { done, value } = await nextChunk(iterator, input.stallTimeoutMs ?? STALL_TIMEOUT_MS);
      if (done) break;
      received += value.byteLength;
      if (received > input.file.size)
        throw retryableError("Update download is larger than expected");
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", resolve));
      const percent = Math.floor((received / input.file.size) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        input.onProgress(percent);
      }
    }
  } catch (error) {
    response.abort();
    await iterator.return?.();
    out.destroy();
    await outClosed.catch(() => undefined);
    throw error;
  }
  out.end();
  await outClosed;
  if (received !== input.file.size) {
    throw retryableError(`Update size mismatch: expected ${input.file.size}, got ${received}`);
  }
  const digest = hash.digest("base64");
  if (digest !== input.file.sha512) {
    throw retryableError("Update sha512 mismatch");
  }
}

async function findSingleApp(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const apps = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (apps.length !== 1 || !apps[0]) {
    throw retryableError(`Expected one .app in the update archive, found ${apps.length}`);
  }
  return join(dir, apps[0].name);
}

async function readPlistString(exec: ExecFile, plistPath: string, key: string): Promise<string> {
  const { stdout } = await exec("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath]);
  return stdout.trim();
}

export function createMacZipInstaller(deps: MacZipInstallerDeps): PlatformInstaller {
  const isWritable = deps.isWritable ?? isDirWritable;
  const newAttemptId = deps.newAttemptId ?? defaultAttemptId;
  /**
   * Each download gets its own staging directory, so a retry never writes into the
   * directory an already spawned install script is waiting to move. Directories
   * handed to a script are left alone; everything is removed on the next start.
   */
  let staged: { version: string; appPath: string; attemptDir: string; handedOff: boolean } | null =
    null;

  const blocker = async () =>
    macInstallBlocker({
      bundlePath: deps.bundlePath,
      isInApplicationsFolder: deps.isInApplicationsFolder(),
      parentWritable: await isWritable(dirname(deps.bundlePath)),
    });

  const zipFor = (candidate: UpdateCandidate) => {
    const file = selectMacZip(candidate.files, deps.arm64Mac);
    if (!file || !isAllowedReleaseAssetUrl(file.url, candidate.version)) return undefined;
    if (typeof file.size !== "number" || file.size <= 0 || !file.sha512) return undefined;
    return { ...file, size: file.size };
  };

  return {
    // The detached script keeps waiting for the app to exit, up to MAC_INSTALL_WAIT_MS
    // from its spawn in install(); the service drops the promise at the same deadline.
    appliesOnQuit: appliesOnQuitFor("darwin"),
    handOffDeadlineMs: MAC_INSTALL_WAIT_MS,
    async actionFor(candidate) {
      if (!zipFor(candidate)) {
        deps.logger.info(
          `no installable mac zip for ${candidate.version}; offering the release page`,
        );
        return "download-page";
      }
      const reason = await blocker();
      if (reason) {
        deps.logger.info(`in-place update unavailable (${reason}); offering the release page`);
        return "download-page";
      }
      return "install";
    },

    async download(candidate, onProgress) {
      const file = zipFor(candidate);
      if (!file) throw pageError(`No installable mac zip for ${candidate.version}`);
      if (staged && !staged.handedOff) {
        await rm(staged.attemptDir, { recursive: true, force: true }).catch(() => undefined);
      }
      staged = null;
      const attemptDir = join(deps.workDir, "attempts", `${candidate.version}-${newAttemptId()}`);
      const extractDir = join(attemptDir, "extracted");
      const zipPath = join(attemptDir, "update.zip");
      await mkdir(extractDir, { recursive: true, mode: 0o700 });
      try {
        await downloadVerifiedFile({
          file,
          version: candidate.version,
          destination: zipPath,
          httpGet: deps.httpGet,
          onProgress,
          ...(deps.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: deps.stallTimeoutMs }),
        });
        // ditto keeps the framework symlinks, permissions and signatures intact.
        await deps.exec("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
        await rm(zipPath, { force: true });
        const appPath = await findSingleApp(extractDir);
        const plist = join(appPath, "Contents", "Info.plist");
        const bundleId = await readPlistString(deps.exec, plist, "CFBundleIdentifier");
        if (bundleId !== APP_BUNDLE_ID) throw pageError(`Unexpected bundle id ${bundleId}`);
        const bundleVersion = await readPlistString(deps.exec, plist, "CFBundleShortVersionString");
        if (bundleVersion !== candidate.version) {
          throw pageError(
            `Unexpected bundle version ${bundleVersion}, expected ${candidate.version}`,
          );
        }
        try {
          await deps.exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
        } catch (error) {
          throw pageError("The downloaded app failed codesign verification", error);
        }
        staged = { version: candidate.version, appPath, attemptDir, handedOff: false };
      } catch (error) {
        await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
        if (error instanceof UpdateInstallError) throw error;
        const code = (error as { code?: unknown })?.code;
        if (code === "EACCES" || code === "EPERM") throw error;
        throw retryableError(`Update preparation failed: ${String(error)}`, error);
      }
    },

    async install(candidate) {
      if (!staged || staged.version !== candidate.version) {
        throw retryableError(`Update ${candidate.version} is not downloaded`);
      }
      const reason = await blocker();
      if (reason === "not-writable") {
        throw Object.assign(new Error(`${dirname(deps.bundlePath)} is not writable`), {
          code: "EACCES",
        });
      }
      if (reason) throw pageError(`In-place update unavailable (${reason})`);
      try {
        await stat(staged.appPath);
      } catch (error) {
        staged = null;
        throw retryableError("The downloaded update is missing", error);
      }
      deps.spawnDetached(
        "/bin/sh",
        macInstallScriptArgs({
          pid: deps.pid,
          bundlePath: deps.bundlePath,
          stagedAppPath: staged.appPath,
          backupPath: macBackupPath(deps.bundlePath),
          lockPath: macInstallLockPath(deps.workDir),
          markerPath: macInstallFailurePath(deps.workDir),
          version: candidate.version,
        }),
        join(deps.workDir, "install.log"),
      );
      staged.handedOff = true;
      deps.quit();
    },
  };
}
