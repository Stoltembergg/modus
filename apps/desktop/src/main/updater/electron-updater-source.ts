import type {
  PlatformInstaller,
  UpdateCandidate,
  UpdateLogger,
  UpdateSource,
} from "./update-controller";
import { UpdateInstallError } from "./update-errors";
import {
  isAllowedReleaseAssetUrl,
  isNewerStableVersion,
  parseStableVersion,
  releaseAssetUrl,
  type UpdateFile,
} from "./update-policy";

/**
 * The slice of electron-updater's AppUpdater this module uses, so tests can pass a fake.
 * electron-updater is pinned to 6.8.3 to stay in step with electron-builder 26.8.x
 * (see electron-builder.config.ts / docs/releasing.md); upgrade both together, below
 * electron-builder v28.
 */
export type ElectronUpdaterLike = {
  channel: string | null;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableWebInstaller: boolean;
  logger: {
    info(message?: unknown): void;
    warn(message?: unknown): void;
    error(message?: unknown): void;
    debug?(message: string): void;
  } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
  removeListener(
    event: "download-progress",
    listener: (progress: { percent: number }) => void,
  ): unknown;
  checkForUpdates(): Promise<{
    isUpdateAvailable?: boolean;
    updateInfo: { version: string; files: Array<{ url: string; sha512: string; size?: number }> };
  } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};

export function configureElectronUpdater(
  updater: ElectronUpdaterLike,
  options: { platform: NodeJS.Platform; installInPlace: boolean; logger: UpdateLogger },
): void {
  // The channel setter flips allowDowngrade to true, so set it first and override after.
  updater.channel = "latest";
  updater.allowDowngrade = false;
  // The constructor enables pre-releases for pre-release app versions; stable only.
  updater.allowPrerelease = false;
  // Downloads start only when the user clicks Install.
  updater.autoDownload = false;
  updater.disableWebInstaller = true;
  // macOS never downloads through electron-updater (Squirrel.Mac rejects unsigned apps).
  // Elsewhere a downloaded update still installs if the user quits before the restart.
  updater.autoInstallOnAppQuit = options.installInPlace && options.platform !== "darwin";
  // electron-updater logs every step (and every failed check) through console by
  // default. Keep its chatter at debug; our controller decides what is worth logging.
  const debug = (message?: unknown) => options.logger.debug(`electron-updater: ${String(message)}`);
  updater.logger = { info: debug, warn: debug, error: debug, debug };
  // AppUpdater is an EventEmitter: an "error" event without a listener would throw.
  // Failures also reject the checkForUpdates()/downloadUpdate() promises we handle.
  updater.on("error", (error) => {
    options.logger.debug(`electron-updater error event: ${error?.message ?? String(error)}`);
  });
}

/** Resolves yml file entries (bare asset names) to official release URLs; drops anything else. */
export function toReleaseFiles(
  version: string,
  files: Array<{ url: string; sha512: string; size?: number }>,
) {
  const resolved: UpdateFile[] = [];
  for (const file of files) {
    let url: string;
    try {
      url = /^https?:\/\//i.test(file.url) ? file.url : releaseAssetUrl(version, file.url);
    } catch {
      continue;
    }
    if (!isAllowedReleaseAssetUrl(url, version)) continue;
    resolved.push({ url, sha512: file.sha512, size: file.size });
  }
  return resolved;
}

export function createElectronUpdaterSource(
  updater: ElectronUpdaterLike,
  currentVersion: string,
): UpdateSource {
  return {
    async check(): Promise<UpdateCandidate | null> {
      const result = await updater.checkForUpdates();
      if (!result || result.isUpdateAvailable === false) return null;
      const { version } = result.updateInfo;
      if (!parseStableVersion(version) || !isNewerStableVersion(version, currentVersion))
        return null;
      return { version, files: toReleaseFiles(version, result.updateInfo.files ?? []) };
    },
  };
}

/** Windows (NSIS) and Linux AppImage: electron-updater downloads (sha512-checked) and installs. */
export function createElectronUpdaterInstaller(updater: ElectronUpdaterLike): PlatformInstaller {
  return {
    async actionFor() {
      return "install";
    },
    async download(candidate, onProgress) {
      if (candidate.files.length === 0) {
        throw new UpdateInstallError(`No official release asset for ${candidate.version}`, {
          retryable: false,
          action: "download-page",
        });
      }
      const listener = (progress: { percent: number }) => {
        if (Number.isFinite(progress?.percent)) onProgress(progress.percent);
      };
      updater.on("download-progress", listener);
      try {
        await updater.downloadUpdate();
      } finally {
        updater.removeListener("download-progress", listener);
      }
    },
    async install() {
      // Silent NSIS install, relaunch afterwards. Emits before-quit, so the app's quit
      // cleanup still runs.
      updater.quitAndInstall(true, true);
    },
  };
}

/** Linux deb (and any install that cannot replace itself): only link to the release. */
export const pageOnlyInstaller: PlatformInstaller = {
  async actionFor() {
    return "download-page";
  },
  async download() {
    throw new UpdateInstallError("This install can only be updated from the release page", {
      retryable: false,
      action: "download-page",
    });
  },
  async install() {
    throw new UpdateInstallError("This install can only be updated from the release page", {
      retryable: false,
      action: "download-page",
    });
  },
};
