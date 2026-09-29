import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRestoreUiState } from "../../shared/contracts";
import {
  createRestoreSnapshotKeeper,
  RESTORE_SNAPSHOT_MAX_AGE_MS,
  RESTORE_SNAPSHOT_SCHEMA_VERSION,
  restoreSnapshotPath,
  takeRestoreSnapshot,
} from "./restore-snapshot";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() });

const UI_STATE: UpdateRestoreUiState = {
  activeWorkspaceId: "ws-1",
  activeSessionId: "s-1",
  drafts: { "s-1": { text: "half-written prompt", mode: "plan" } },
  sidebar: { open: false, width: 280 },
  inspector: { open: true, width: 520, tab: "files" },
  settingsOpen: false,
};

let root: string;
let workDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "modus-restore-"));
  workDir = join(root, "updater");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function keeper(pending: boolean) {
  return createRestoreSnapshotKeeper({
    workDir,
    currentVersion: "1.2.0",
    hasPendingUpdate: () => pending,
    now: () => NOW,
    logger: logger(),
  });
}

function writeFile(content: unknown) {
  const path = restoreSnapshotPath(workDir);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

function file(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: RESTORE_SNAPSHOT_SCHEMA_VERSION,
    fromVersion: "1.2.0",
    createdAt: new Date(NOW - 60_000).toISOString(),
    state: UI_STATE,
    ...overrides,
  };
}

function take(currentVersion = "1.3.0", now = NOW) {
  const log = logger();
  return {
    state: takeRestoreSnapshot({ workDir, currentVersion, now: () => now, logger: log }),
    log,
  };
}

describe("restore snapshot write on quit", () => {
  it("writes the latest state synchronously while an update is pending", () => {
    const k = keeper(true);
    k.remember({ ...UI_STATE, settingsOpen: true });
    k.remember(UI_STATE);
    expect(k.writeOnQuit()).toBe(true);
    const written = JSON.parse(readFileSync(restoreSnapshotPath(workDir), "utf8"));
    expect(written).toEqual({
      schemaVersion: 1,
      fromVersion: "1.2.0",
      createdAt: "2026-09-29T12:00:00.000Z",
      state: UI_STATE,
    });
    expect(existsSync(`${restoreSnapshotPath(workDir)}.tmp`)).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(restoreSnapshotPath(workDir)).mode & 0o777).toBe(0o600);
    }
  });

  it("writes nothing without a pending downloaded update", () => {
    const k = keeper(false);
    k.remember(UI_STATE);
    expect(k.writeOnQuit()).toBe(false);
    expect(existsSync(restoreSnapshotPath(workDir))).toBe(false);
  });

  it("writes nothing when the renderer never pushed a state", () => {
    expect(keeper(true).writeOnQuit()).toBe(false);
    expect(existsSync(restoreSnapshotPath(workDir))).toBe(false);
  });

  it("never throws at quit when the directory cannot be written", () => {
    writeFileSync(join(root, "blocker"), "");
    const log = logger();
    const k = createRestoreSnapshotKeeper({
      workDir: join(root, "blocker", "updater"),
      currentVersion: "1.2.0",
      hasPendingUpdate: () => true,
      now: () => NOW,
      logger: log,
    });
    k.remember(UI_STATE);
    expect(k.writeOnQuit()).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("restore snapshot take at startup", () => {
  it("restores after a version change and deletes the file once read", () => {
    const k = keeper(true);
    k.remember(UI_STATE);
    k.writeOnQuit();
    expect(take("1.3.0").state).toEqual(UI_STATE);
    expect(existsSync(restoreSnapshotPath(workDir))).toBe(false);
    expect(take("1.3.0").state).toBeNull();
  });

  it("returns null when there is no file", () => {
    expect(take().state).toBeNull();
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["a JSON null", "null"],
    ["the same version", file({ fromVersion: "1.3.0" })],
    ["an unknown schema", file({ schemaVersion: 2 })],
    ["a missing schema", file({ schemaVersion: undefined })],
    [
      "a snapshot older than 24 h",
      file({ createdAt: new Date(NOW - RESTORE_SNAPSHOT_MAX_AGE_MS).toISOString() }),
    ],
    ["a snapshot from the future", file({ createdAt: new Date(NOW + 60_000).toISOString() })],
    ["an unreadable date", file({ createdAt: "yesterday" })],
    ["an invalid state", file({ state: { ...UI_STATE, activeSessionId: 42 } })],
    ["an extra state field", file({ state: { ...UI_STATE, attachments: [] } })],
    ["an oversized file", file({ padding: "x".repeat(600 * 1024) })],
  ])("discards %s silently and deletes the file", (_label, content) => {
    const path = writeFile(content);
    const { state, log } = take("1.3.0");
    expect(state).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps a snapshot just under 24 h old", () => {
    writeFile(file({ createdAt: new Date(NOW - RESTORE_SNAPSHOT_MAX_AGE_MS + 1).toISOString() }));
    expect(take("1.3.0").state).toEqual(UI_STATE);
  });
});
