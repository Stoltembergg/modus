import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, net, shell } from "electron";
import type { UpdateRestoreUiState, UpdateState } from "../../shared/contracts";
import { hasPendingDownloadedUpdate } from "../../shared/update-restore";
import { getAgentRuntime } from "../agent/runtime-registry";
import { IPC_CHANNELS } from "../ipc/channels";
import type { UpdateIpcService } from "../ipc/update-ipc";
import {
  configureElectronUpdater,
  createElectronUpdaterInstaller,
  createElectronUpdaterSource,
  type ElectronUpdaterLike,
  pageOnlyInstaller,
} from "./electron-updater-source";
import {
  type PreviousInstallFailure,
  restorePreviousMacInstallFailure,
} from "./mac-install-failure";
import {
  cleanupMacUpdateArtifacts,
  createMacZipInstaller,
  type HttpResponse,
} from "./mac-zip-installer";
import {
  createRestoreSnapshotKeeper,
  type RestoreSnapshotKeeper,
  takeRestoreSnapshot,
} from "./restore-snapshot";
import {
  createUpdateController,
  type PlatformInstaller,
  type UpdateController,
  type UpdateLogger,
} from "./update-controller";
import { errorMessage } from "./update-errors";
import { appliesOnQuitFor, isArm64Mac, releasePageUrl, resolveUpdatePolicy } from "./update-policy";
import type { UpdateTimers } from "./update-scheduler";
import { IDLE } from "./update-state-machine";

const execFileAsync = promisify(execFile);

const updaterLogger: UpdateLogger = {
  debug(message) {
    if (process.env.MODUS_UPDATER_DEBUG === "1") console.info(`[modus-updater] ${message}`);
  },
  info(message) {
    console.info(`[modus-updater] ${message}`);
  },
  warn(message) {
    console.warn(`[modus-updater] ${message}`);
  },
};

const nodeTimers: UpdateTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

let controller: UpdateController | null = null;
let restoreKeeper: RestoreSnapshotKeeper | null = null;
let restoredUiState: UpdateRestoreUiState | null = null;

function updaterWorkDir(): string {
  return join(app.getPath("userData"), "updater");
}

function getRestoreKeeper(): RestoreSnapshotKeeper {
  restoreKeeper ??= createRestoreSnapshotKeeper({
    workDir: updaterWorkDir(),
    currentVersion: app.getVersion(),
    hasPendingUpdate: () => hasPendingDownloadedUpdate(controller?.getState() ?? IDLE),
    now: () => Date.now(),
    logger: updaterLogger,
  });
  return restoreKeeper;
}

/**
 * Takes the UI snapshot left by the previous version (read + delete). Call once at
 * startup, before the window loads and before the macOS cleanup empties the updater dir.
 */
export function takeRestoreSnapshotAtStartup(): void {
  restoredUiState = takeRestoreSnapshot({
    workDir: updaterWorkDir(),
    currentVersion: app.getVersion(),
    now: () => Date.now(),
    logger: updaterLogger,
  });
}

/**
 * Synchronous; call from `before-quit`. Writes the latest UI state only while a
 * downloaded update is pending, so it also covers autoInstallOnAppQuit (a plain quit
 * with a ready update on Windows/AppImage), where beforeInstallRestart never runs.
 */
export function saveRestoreSnapshotOnQuit(): void {
  restoreKeeper?.writeOnQuit();
}

/**
 * Hook run right before the app quits to install an update. The UI state is not
 * collected here: the renderer pushes it ahead of time and before-quit writes it.
 */
export async function beforeInstallRestart(): Promise<void> {}

/** Stable IPC facade: idle/no-op until (and unless) the updater is enabled. */
export function getUpdateService(): UpdateIpcService {
  return {
    getState: () => controller?.getState() ?? IDLE,
    install: async () => controller?.install(),
    retry: async () => controller?.retry(),
    restartNow: async () => controller?.restartNow(),
    dismiss: () => controller?.dismiss(),
    openReleasePage: async () => {
      if (controller) return controller.openReleasePage();
      await shell.openExternal(releasePageUrl());
    },
    saveUiState: (state) => getRestoreKeeper().remember(state),
    takeRestoredUiState: () => {
      const state = restoredUiState;
      restoredUiState = null;
      return state;
    },
  };
}

function broadcastUpdateState(state: UpdateState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents;
    if (window.isDestroyed() || contents.isDestroyed() || contents.isCrashed()) continue;
    contents.send(IPC_CHANNELS.updateStateEvent, state);
  }
}

/** GET via Electron's network stack (system proxy, no download manager, no quarantine). */
function electronHttpGet(url: string): Promise<HttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const request = net.request({
      url,
      method: "GET",
      redirect: "manual",
      useSessionCookies: false,
    });
    let settled = false;
    const abort = () => {
      try {
        request.abort();
      } catch {
        // already finished
      }
    };
    request.on("redirect", (statusCode, _method, redirectUrl) => {
      settled = true;
      resolvePromise({
        statusCode,
        headers: { location: redirectUrl },
        body: (async function* () {})(),
        abort,
      });
    });
    request.on("response", (response) => {
      settled = true;
      resolvePromise({
        statusCode: response.statusCode,
        headers: response.headers,
        body: response as unknown as AsyncIterable<Uint8Array>,
        abort,
      });
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
}

function spawnDetached(file: string, args: string[], logPath: string): void {
  const fd = openSync(logPath, "a", 0o600);
  try {
    spawn(file, args, { detached: true, stdio: ["ignore", fd, fd] }).unref();
  } finally {
    closeSync(fd);
  }
}

async function createPlatformUpdater(
  platform: "win32" | "darwin" | "linux",
  appImage: boolean,
): Promise<ElectronUpdaterLike> {
  const loaded = (await import("electron-updater")) as typeof import("electron-updater") & {
    default?: typeof import("electron-updater");
  };
  const mod = loaded.default ?? loaded;
  // Construct explicitly instead of the platform-guessing `autoUpdater` getter.
  const updater =
    platform === "win32"
      ? new mod.NsisUpdater()
      : platform === "darwin"
        ? new mod.MacUpdater() // check only; never downloadUpdate/quitAndInstall (Squirrel.Mac)
        : appImage
          ? new mod.AppImageUpdater()
          : new mod.DebUpdater(); // check only; deb installs get the release page
  return updater as unknown as ElectronUpdaterLike;
}

export async function startUpdateService(): Promise<void> {
  if (controller) return;
  const policy = resolveUpdatePolicy({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    platform: process.platform,
    env: process.env,
  });
  if (!policy.enabled) {
    if (app.isPackaged) updaterLogger.info(`updates disabled (${policy.reason})`);
    return;
  }

  const installInPlace = policy.installMode === "auto";
  const updater = await createPlatformUpdater(policy.platform, Boolean(process.env.APPIMAGE));
  configureElectronUpdater(updater, {
    platform: policy.platform,
    installInPlace,
    logger: updaterLogger,
  });

  let installer: PlatformInstaller;
  let previousFailure: PreviousInstallFailure | null = null;
  if (!installInPlace) {
    installer = pageOnlyInstaller;
  } else if (policy.platform === "darwin") {
    const bundlePath = resolve(app.getPath("exe"), "../../..");
    const workDir = updaterWorkDir();
    // The script's failure marker lives in workDir: take it before the cleanup.
    await restorePreviousMacInstallFailure({
      workDir,
      currentVersion: app.getVersion(),
      logger: updaterLogger,
      report: (failure) => {
        previousFailure = failure;
      },
    });
    await cleanupMacUpdateArtifacts({ bundlePath, workDir, logger: updaterLogger });
    installer = createMacZipInstaller({
      bundlePath,
      isInApplicationsFolder: () => app.isInApplicationsFolder(),
      arm64Mac: isArm64Mac({
        arch: process.arch,
        runningUnderARM64Translation: app.runningUnderARM64Translation,
      }),
      workDir,
      pid: process.pid,
      httpGet: electronHttpGet,
      exec: async (file, args) => {
        const { stdout } = await execFileAsync(file, args, {
          timeout: 10 * 60_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { stdout: String(stdout) };
      },
      spawnDetached,
      quit: () => app.quit(),
      logger: updaterLogger,
    });
  } else {
    installer = createElectronUpdaterInstaller(updater, {
      appliesOnQuit: appliesOnQuitFor(policy.platform),
    });
  }

  controller = createUpdateController({
    currentVersion: app.getVersion(),
    source: createElectronUpdaterSource(updater, app.getVersion()),
    installer,
    agents: { hasActiveTurns: () => getAgentRuntime().hasActiveTurns() },
    timers: nodeTimers,
    logger: updaterLogger,
    now: () => Date.now(),
    openExternal: (url) => shell.openExternal(url),
    beforeInstallRestart,
  });
  controller.subscribe(broadcastUpdateState);
  // Shown as a retryable failure so the notice can offer Retry / the release page.
  if (previousFailure) controller.reportPreviousFailure(previousFailure);
  controller.start();
  updaterLogger.info(
    `update checks enabled (${policy.platform}, ${installInPlace ? "in-place install" : "release page only"})`,
  );
}

export function stopUpdateService(): void {
  controller?.stop();
}

export function startUpdateServiceInBackground(): void {
  void startUpdateService().catch((error: unknown) => {
    updaterLogger.warn(`could not start the update service: ${errorMessage(error)}`);
  });
}
