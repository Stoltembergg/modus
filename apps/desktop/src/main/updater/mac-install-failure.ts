import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { UpdateAction } from "../../shared/contracts";
import { MAC_INSTALL_EXIT_REASONS } from "./mac-install-script";
import type { UpdateLogger } from "./update-controller";
import { isNewerStableVersion, parseStableVersion } from "./update-policy";

/**
 * Failure marker written by the detached mac install script on any error exit. It
 * lives in the updater work dir (userData/updater); the service takes it on the next
 * start, before that directory is cleaned up.
 */
export type MacInstallFailureMarker = { code: number; reason: string; version: string };

export type PreviousInstallFailure = {
  version: string;
  retryable: boolean;
  action: UpdateAction;
  reason: string;
};

export function macInstallFailurePath(workDir: string): string {
  return join(workDir, "install-failure.json");
}

/** Reads and deletes the marker. Returns null when absent or unreadable. */
export async function takeMacInstallFailure(
  workDir: string,
  logger: UpdateLogger,
): Promise<MacInstallFailureMarker | null> {
  const path = macInstallFailurePath(workDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  await rm(path, { force: true }).catch((error: unknown) => {
    logger.info(`could not remove ${path}: ${String(error)}`);
  });
  try {
    const parsed = JSON.parse(raw) as Partial<MacInstallFailureMarker>;
    if (
      typeof parsed.code === "number" &&
      typeof parsed.reason === "string" &&
      typeof parsed.version === "string" &&
      parseStableVersion(parsed.version)
    ) {
      return { code: parsed.code, reason: parsed.reason, version: parsed.version };
    }
  } catch {
    // fall through
  }
  logger.info(`ignoring malformed update failure marker: ${raw.slice(0, 200)}`);
  return null;
}

/**
 * Exit codes where the app bundle could not be replaced (permissions, macOS App
 * Management/TCC, a new version that does not launch): retrying the same way is
 * unlikely to help, so the failure offers the release page. The rest (app did not
 * quit, lock busy, missing staging) can be retried in place.
 */
const PAGE_ACTION_CODES = new Set([5, 6, 7, 8, 9, 10]);

/**
 * Turns a marker into the failed state to show, or null when the failure is moot
 * because the target version (or a newer one) is what is running now.
 */
export function previousInstallFailure(
  marker: MacInstallFailureMarker,
  currentVersion: string,
): PreviousInstallFailure | null {
  if (!isNewerStableVersion(marker.version, currentVersion)) return null;
  return {
    version: marker.version,
    retryable: true,
    action: PAGE_ACTION_CODES.has(marker.code) ? "download-page" : "install",
    reason: MAC_INSTALL_EXIT_REASONS[marker.code] ?? marker.reason,
  };
}

/**
 * Startup step: takes the marker (deleting it), logs it, and reports the failure to
 * show (via `report`, i.e. controller.reportPreviousFailure) unless it is moot.
 */
export async function restorePreviousMacInstallFailure(input: {
  workDir: string;
  currentVersion: string;
  logger: UpdateLogger;
  report: (failure: PreviousInstallFailure) => void;
}): Promise<PreviousInstallFailure | null> {
  const marker = await takeMacInstallFailure(input.workDir, input.logger);
  if (!marker) return null;
  const failure = previousInstallFailure(marker, input.currentVersion);
  if (!failure) {
    input.logger.info(
      `previous update install reported ${marker.reason} (exit ${marker.code}) for ${marker.version}, but ${input.currentVersion} is running; ignoring`,
    );
    return null;
  }
  input.logger.info(
    `previous update install of ${failure.version} failed: ${failure.reason} (exit ${marker.code})`,
  );
  input.report(failure);
  return failure;
}
