import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateRestoreUiState } from "../../shared/contracts";
import { MAX_RESTORE_UI_STATE_BYTES, updateSaveUiStateSchema } from "../ipc/schemas";
import type { UpdateLogger } from "./update-controller";

/**
 * UI state carried across an update restart. While a downloaded update is pending the
 * renderer pushes its state (debounced); main keeps the latest in memory and writes it
 * synchronously in `before-quit`. The next start takes the file once (read + delete) and
 * hands it to the renderer only when the version changed and it is fresh.
 */
export const RESTORE_SNAPSHOT_SCHEMA_VERSION = 1;
export const RESTORE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;

export type RestoreSnapshotFile = {
  schemaVersion: number;
  fromVersion: string;
  createdAt: string;
  state: UpdateRestoreUiState;
};

export function restoreSnapshotPath(workDir: string): string {
  return join(workDir, "restore-snapshot.json");
}

export type RestoreSnapshotKeeper = {
  /** Keeps only the latest state (already validated at the IPC boundary). */
  remember(state: UpdateRestoreUiState): void;
  /** Synchronous: runs in `before-quit`. Writes only while an update is pending. */
  writeOnQuit(): boolean;
};

export function createRestoreSnapshotKeeper(deps: {
  workDir: string;
  currentVersion: string;
  hasPendingUpdate: () => boolean;
  now: () => number;
  logger: UpdateLogger;
}): RestoreSnapshotKeeper {
  let latest: UpdateRestoreUiState | null = null;
  return {
    remember(state) {
      latest = state;
    },
    writeOnQuit() {
      if (!latest || !deps.hasPendingUpdate()) return false;
      const file: RestoreSnapshotFile = {
        schemaVersion: RESTORE_SNAPSHOT_SCHEMA_VERSION,
        fromVersion: deps.currentVersion,
        createdAt: new Date(deps.now()).toISOString(),
        state: latest,
      };
      const path = restoreSnapshotPath(deps.workDir);
      const temp = `${path}.tmp`;
      try {
        mkdirSync(deps.workDir, { recursive: true });
        writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
        renameSync(temp, path);
        return true;
      } catch (error) {
        deps.logger.warn(`could not save the UI state for the restart: ${String(error)}`);
        try {
          rmSync(temp, { force: true });
        } catch {
          // nothing was written
        }
        return false;
      }
    },
  };
}

/**
 * Reads and deletes the snapshot (once per start, before anything cleans the updater
 * dir). Returns the state only when it came from another version, is under 24 h old and
 * matches the known schema; everything else is discarded silently (debug log only).
 */
export function takeRestoreSnapshot(deps: {
  workDir: string;
  currentVersion: string;
  now: () => number;
  logger: UpdateLogger;
}): UpdateRestoreUiState | null {
  const path = restoreSnapshotPath(deps.workDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    rmSync(path, { force: true });
  } catch (error) {
    deps.logger.info(`could not remove ${path}: ${String(error)}`);
  }
  const discard = (reason: string) => {
    deps.logger.debug(`discarding the UI restore snapshot: ${reason}`);
    return null;
  };
  if (Buffer.byteLength(raw, "utf8") > MAX_RESTORE_UI_STATE_BYTES) return discard("too large");
  let parsed: Partial<RestoreSnapshotFile> | null;
  try {
    parsed = JSON.parse(raw) as Partial<RestoreSnapshotFile> | null;
  } catch {
    return discard("invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") return discard("not an object");
  if (parsed.schemaVersion !== RESTORE_SNAPSHOT_SCHEMA_VERSION) return discard("unknown schema");
  if (typeof parsed.fromVersion !== "string" || parsed.fromVersion === deps.currentVersion) {
    return discard("same version");
  }
  const createdAt = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : NaN;
  const age = deps.now() - createdAt;
  if (!Number.isFinite(age) || age < 0 || age >= RESTORE_SNAPSHOT_MAX_AGE_MS) {
    return discard("stale");
  }
  // Same size cap and strict shape as the IPC payload: the file is untrusted too.
  const state = updateSaveUiStateSchema.safeParse(parsed.state);
  return state.success ? state.data : discard("invalid state");
}
