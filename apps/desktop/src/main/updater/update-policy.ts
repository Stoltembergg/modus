/**
 * Pure update policy: which builds update, from where, and how. No Electron imports so
 * every rule is unit-testable.
 */

import { RELEASE_REPO } from "../../shared/release-repo";

/** Same repository as electron-builder's `publish` config (both use RELEASE_REPO). */
export const RELEASES_URL = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases`;
export const APP_BUNDLE_ID = "dev.modus.desktop";

export type UpdatePolicy =
  | { enabled: false; reason: "development" | "prerelease-version" | "unsupported-platform" }
  | {
      enabled: true;
      platform: "win32" | "darwin" | "linux";
      /** `download-page`: updates are only offered as a link to the Release page. */
      installMode: "auto" | "download-page";
    };

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableVersion(version: string): [number, number, number] | null {
  const match = STABLE_VERSION.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True only when both are plain X.Y.Z and `candidate` is strictly newer (never downgrade). */
export function isNewerStableVersion(candidate: string, current: string): boolean {
  const next = parseStableVersion(candidate);
  const now = parseStableVersion(current);
  if (!next || !now) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== now[index]) return (next[index] ?? 0) > (now[index] ?? 0);
  }
  return false;
}

export function resolveUpdatePolicy(input: {
  isPackaged: boolean;
  version: string;
  platform: string;
  env: { APPIMAGE?: string | undefined };
}): UpdatePolicy {
  if (!input.isPackaged) return { enabled: false, reason: "development" };
  // Only the stable channel updates. Beta (or any pre-release) builds never
  // auto-update, so a beta tester is not silently moved to stable.
  if (!parseStableVersion(input.version)) return { enabled: false, reason: "prerelease-version" };
  if (input.platform === "win32" || input.platform === "darwin") {
    return { enabled: true, platform: input.platform, installMode: "auto" };
  }
  if (input.platform === "linux") {
    // AppImage sets APPIMAGE; without it this is a deb (or unpacked) install, which
    // cannot replace itself without root: offer the Release page instead.
    return {
      enabled: true,
      platform: "linux",
      installMode: input.env.APPIMAGE ? "auto" : "download-page",
    };
  }
  return { enabled: false, reason: "unsupported-platform" };
}

/**
 * Whether an in-place install handed off at restart still completes if the app quits
 * later than expected, i.e. the install watchdog's "applied when Modus closes" notice.
 * The single source of truth for both installers:
 * - darwin: yes, the detached swap script waits up to 10 minutes for the app to exit;
 * - linux: yes, in-place installs are AppImage only (deb gets the release page) and the
 *   AppImage file is already replaced when the install hands off;
 * - win32: no, the silent NSIS installer gives up when it cannot close the app.
 */
export function appliesOnQuitFor(platform: "win32" | "darwin" | "linux"): boolean {
  return platform === "darwin" || platform === "linux";
}

export function releasePageUrl(version?: string): string {
  return version && parseStableVersion(version)
    ? `${RELEASES_URL}/tag/v${version}`
    : `${RELEASES_URL}/latest`;
}

const ASSET_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Official download URL for a release asset; throws for anything that is not a bare file name. */
export function releaseAssetUrl(version: string, fileName: string): string {
  if (!parseStableVersion(version)) throw new Error(`Invalid release version: ${version}`);
  if (!ASSET_FILE_NAME.test(fileName) || fileName.includes("..")) {
    throw new Error(`Invalid release asset name: ${fileName}`);
  }
  return `${RELEASES_URL}/download/v${version}/${fileName}`;
}

/** GitHub owner/repository names are case-insensitive ("Stoltembergg" == "stoltembergg"). */
function sameGitHubName(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}

/**
 * Only `https://github.com/<RELEASE_REPO>/releases/download/v<X.Y.Z>/<file>`
 * (optionally for one specific version) is accepted as an update download.
 *
 * GitHub owner and repository names are case-insensitive, so only those two segments
 * are compared ignoring case (a URL carrying GitHub's canonical casing still passes).
 * Everything else, including `releases/download`, the tag and the file name, must
 * match exactly.
 */
export function isAllowedReleaseAssetUrl(rawUrl: string, version?: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return false;
  if (url.port || url.username || url.password || url.search || url.hash) return false;
  const segments = url.pathname.split("/");
  if (segments.length !== 7) return false;
  const [leading, owner = "", repo = "", releases, download, tag = "", fileName = ""] = segments;
  if (leading !== "" || releases !== "releases" || download !== "download") return false;
  if (!sameGitHubName(owner, RELEASE_REPO.owner) || !sameGitHubName(repo, RELEASE_REPO.repo)) {
    return false;
  }
  if (!tag.startsWith("v") || !parseStableVersion(tag.slice(1))) return false;
  if (version !== undefined && tag !== `v${version}`) return false;
  return ASSET_FILE_NAME.test(fileName) && !fileName.includes("..");
}

/** GitHub serves release assets through redirects to its asset CDN. HTTPS only. */
const REDIRECT_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export function isAllowedDownloadRedirect(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      REDIRECT_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export type UpdateFile = { url: string; sha512: string; size?: number | undefined };

export function isArm64Mac(input: {
  arch: string;
  runningUnderARM64Translation: boolean;
}): boolean {
  return input.arch === "arm64" || input.runningUnderARM64Translation;
}

/**
 * electron-updater MacUpdater's rule: an arm64 Mac (including an x64 build running
 * under Rosetta) takes the arm64 files when the release has any; otherwise only
 * non-arm64 files are eligible. Then the zip is used.
 */
export function selectMacZip(files: UpdateFile[], arm64Mac: boolean): UpdateFile | undefined {
  const isArm64 = (file: UpdateFile) => file.url.includes("arm64");
  const eligible =
    arm64Mac && files.some(isArm64)
      ? files.filter((file) => isArm64(file))
      : files.filter((file) => !isArm64(file));
  return eligible.find((file) => file.url.endsWith(".zip"));
}

/** The only bundle name the mac installer swaps (electron-builder productName "Modus"). */
export const MAC_BUNDLE_NAME = "Modus.app";

export type MacInstallBlocker =
  | "unexpected-bundle-path"
  | "not-in-applications"
  | "translocated"
  | "mounted-volume"
  | "not-writable";

/** Conditions for replacing the running bundle in place; anything else gets the Release page. */
export function macInstallBlocker(input: {
  bundlePath: string;
  isInApplicationsFolder: boolean;
  parentWritable: boolean;
}): MacInstallBlocker | null {
  // Only swap a bundle named exactly Modus.app. A renamed copy ("Modus 2.app") or the
  // previous version running from the swap backup after a failed rollback
  // (".Modus.app.update-backup") must not become the swap target.
  const path = input.bundlePath.replace(/\/+$/, "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name !== MAC_BUNDLE_NAME || path.endsWith(".update-backup")) {
    return "unexpected-bundle-path";
  }
  if (input.bundlePath.includes("/AppTranslocation/")) return "translocated";
  if (input.bundlePath.includes("/Volumes/")) return "mounted-volume";
  if (!input.isInApplicationsFolder) return "not-in-applications";
  if (!input.parentWritable) return "not-writable";
  return null;
}
