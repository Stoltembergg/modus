import { describe, expect, it, vi } from "vitest";
import type { TrustedSenderEvent } from "./trusted-sender";

const UPDATE_CHANNELS = [
  "update:get-state",
  "update:install",
  "update:retry",
  "update:restart-now",
  "update:dismiss",
  "update:open-release-page",
  "update:save-ui-state",
  "update:take-restored-ui-state",
];

const UI_STATE = {
  activeWorkspaceId: "ws-1",
  activeSessionId: "s-1",
  drafts: { "s-1": { text: "half-written prompt", mode: "plan" as const } },
  sidebar: { open: true, width: 300 },
  inspector: { open: false, width: 384, tab: "changes" as const },
  settingsOpen: false,
};

async function register() {
  const { registerUpdateIpcHandlers } = await import("./update-ipc");
  const { assertTrustedSender } = await import("./trusted-sender");
  const handlers = new Map<string, (event: TrustedSenderEvent, input?: unknown) => unknown>();
  const ipcMain = {
    handle: vi.fn(
      (channel: string, handler: (event: TrustedSenderEvent, input?: unknown) => unknown) =>
        handlers.set(channel, handler),
    ),
  };
  const service = {
    getState: vi.fn(() => ({ status: "idle" as const })),
    install: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    restartNow: vi.fn(async () => undefined),
    dismiss: vi.fn(),
    openReleasePage: vi.fn(async () => undefined),
    saveUiState: vi.fn(),
    takeRestoredUiState: vi.fn(() => null),
  };
  registerUpdateIpcHandlers(ipcMain, assertTrustedSender, service);
  return { handlers, service };
}

describe("update IPC registration", () => {
  it("registers every update command", async () => {
    const { handlers } = await register();
    expect([...handlers.keys()].sort()).toEqual([...UPDATE_CHANNELS].sort());
  });

  it("rejects untrusted senders before calling the update service", async () => {
    const { handlers, service } = await register();
    const event = { senderFrame: { url: "https://attacker.invalid/" } };
    for (const channel of UPDATE_CHANNELS) {
      const input = channel === "update:save-ui-state" ? UI_STATE : undefined;
      expect(() => handlers.get(channel)?.(event, input)).toThrow(
        "Blocked IPC call from untrusted renderer frame.",
      );
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("forwards trusted calls and rejects unexpected input", async () => {
    const { handlers, service } = await register();
    const { registerTrustedSender } = await import("./trusted-sender");
    const sender = { mainFrame: { url: "file:///index.html" } };
    const unregister = registerTrustedSender(sender, "file:///index.html");
    const trusted = { sender, senderFrame: sender.mainFrame };
    try {
      expect(handlers.get("update:get-state")?.(trusted, undefined)).toEqual({ status: "idle" });
      expect(handlers.get("update:install")?.(trusted, undefined)).toBeUndefined();
      handlers.get("update:retry")?.(trusted, undefined);
      handlers.get("update:dismiss")?.(trusted, undefined);
      expect(handlers.get("update:restart-now")?.(trusted, undefined)).toBeUndefined();
      await handlers.get("update:open-release-page")?.(trusted, undefined);
      expect(service.install).toHaveBeenCalledTimes(1);
      expect(service.retry).toHaveBeenCalledTimes(1);
      expect(service.dismiss).toHaveBeenCalledTimes(1);
      expect(service.restartNow).toHaveBeenCalledTimes(1);
      expect(() => handlers.get("update:restart-now")?.(trusted, { force: true })).toThrow();
      expect(service.restartNow).toHaveBeenCalledTimes(1);
      expect(service.openReleasePage).toHaveBeenCalledTimes(1);
      expect(() => handlers.get("update:install")?.(trusted, { url: "https://evil" })).toThrow();
      expect(service.install).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("validates the UI state payload before keeping it", async () => {
    const { handlers, service } = await register();
    const { registerTrustedSender } = await import("./trusted-sender");
    const sender = { mainFrame: { url: "file:///index.html" } };
    const unregister = registerTrustedSender(sender, "file:///index.html");
    const trusted = { sender, senderFrame: sender.mainFrame };
    const save = (input: unknown) => handlers.get("update:save-ui-state")?.(trusted, input);
    try {
      save(UI_STATE);
      expect(service.saveUiState).toHaveBeenCalledWith(UI_STATE);
      expect(() => save(undefined)).toThrow();
      expect(() => save({ ...UI_STATE, extra: true })).toThrow();
      expect(() => save({ ...UI_STATE, inspector: { ...UI_STATE.inspector, tab: "x" } })).toThrow();
      expect(() => save({ ...UI_STATE, sidebar: { open: true, width: Number.NaN } })).toThrow();
      const huge = { ...UI_STATE, drafts: { "s-1": { text: "x".repeat(100_001), mode: "build" } } };
      expect(() => save(huge)).toThrow();
      const tooMany = Object.fromEntries(
        Array.from({ length: 201 }, (_, i) => [`s-${i}`, { text: "a", mode: "build" }]),
      );
      expect(() => save({ ...UI_STATE, drafts: tooMany })).toThrow();
      // Within the per-draft limit but over the overall byte cap.
      const heavy = Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          `s-${i}`,
          { text: "é".repeat(60_000), mode: "build" },
        ]),
      );
      expect(() => save({ ...UI_STATE, drafts: heavy })).toThrow("UI state too large");
      // Every rejected push clears main's copy instead of keeping an older one.
      expect(service.saveUiState).toHaveBeenCalledTimes(8);
      expect(service.saveUiState.mock.calls.slice(1)).toEqual(Array(7).fill([null]));
      expect(handlers.get("update:take-restored-ui-state")?.(trusted, undefined)).toBeNull();
      expect(() => handlers.get("update:take-restored-ui-state")?.(trusted, {})).toThrow();
    } finally {
      unregister();
    }
  });

  it("writes nothing on quit after a push fails validation", async () => {
    const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createRestoreSnapshotKeeper, restoreSnapshotPath } = await import(
      "../updater/restore-snapshot"
    );
    const { registerUpdateIpcHandlers } = await import("./update-ipc");
    const { assertTrustedSender, registerTrustedSender } = await import("./trusted-sender");
    const workDir = join(mkdtempSync(join(tmpdir(), "modus-restore-ipc-")), "updater");
    const keeper = createRestoreSnapshotKeeper({
      workDir,
      currentVersion: "1.2.0",
      hasPendingUpdate: () => true,
      now: () => 0,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    const handlers = new Map<string, (event: TrustedSenderEvent, input?: unknown) => unknown>();
    registerUpdateIpcHandlers(
      { handle: (channel, handler) => void handlers.set(channel, handler) },
      assertTrustedSender,
      {
        getState: () => ({ status: "ready", version: "1.3.0" }),
        install: async () => undefined,
        retry: async () => undefined,
        restartNow: async () => undefined,
        dismiss: () => undefined,
        openReleasePage: async () => undefined,
        saveUiState: (state) => keeper.remember(state),
        takeRestoredUiState: () => null,
      },
    );
    const sender = { mainFrame: { url: "file:///index.html" } };
    const unregister = registerTrustedSender(sender, "file:///index.html");
    const trusted = { sender, senderFrame: sender.mainFrame };
    const save = (input: unknown) => handlers.get("update:save-ui-state")?.(trusted, input);
    try {
      save(UI_STATE);
      expect(() => save({ ...UI_STATE, settingsOpen: "yes" })).toThrow();
      expect(keeper.writeOnQuit()).toBe(false);
      expect(existsSync(restoreSnapshotPath(workDir))).toBe(false);

      save(UI_STATE);
      const oversized = {
        ...UI_STATE,
        drafts: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [
            `s-${i}`,
            { text: "é".repeat(60_000), mode: "build" },
          ]),
        ),
      };
      expect(() => save(oversized)).toThrow("UI state too large");
      expect(keeper.writeOnQuit()).toBe(false);
      expect(existsSync(restoreSnapshotPath(workDir))).toBe(false);

      save(UI_STATE);
      expect(keeper.writeOnQuit()).toBe(true);
    } finally {
      unregister();
      rmSync(join(workDir, ".."), { recursive: true, force: true });
    }
  });
});
