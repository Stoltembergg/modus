import { describe, expect, it, vi } from "vitest";
import type { TrustedSenderEvent } from "./trusted-sender";

const UPDATE_CHANNELS = [
  "update:get-state",
  "update:install",
  "update:retry",
  "update:restart-now",
  "update:dismiss",
  "update:open-release-page",
];

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
      expect(() => handlers.get(channel)?.(event, undefined)).toThrow(
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
});
