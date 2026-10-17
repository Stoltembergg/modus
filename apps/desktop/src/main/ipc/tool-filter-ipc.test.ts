import { describe, expect, it, vi } from "vitest";
import type { ToolFilterState } from "../../shared/tool-filter";
import { registerToolFilterIpcHandlers, type ToolFilterIpcController } from "./tool-filter-ipc";
import type { TrustedSenderEvent } from "./trusted-sender";

const mocks = vi.hoisted(() => ({
  windows: [] as Array<{
    isDestroyed: () => boolean;
    webContents: { send: ReturnType<typeof vi.fn> };
  }>,
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => mocks.windows,
  },
}));

const mockState: ToolFilterState = {
  enabled: false,
  availability: { available: true },
  download: { phase: "idle" },
  model: "stopped",
  downloadBytes: 390_000_000,
  partialBytes: 0,
};

function setup() {
  const handlers = new Map<string, (event: TrustedSenderEvent, input?: unknown) => unknown>();
  let subscriber: ((state: ToolFilterState) => void) | null = null;

  const controller: ToolFilterIpcController = {
    getState: vi.fn(() => mockState),
    enable: vi.fn(async () => ({ ...mockState, enabled: true })),
    disable: vi.fn(async () => ({ ...mockState, enabled: false })),
    cancelDownload: vi.fn(async () => ({ ...mockState, enabled: false })),
    subscribe: vi.fn((listener) => {
      subscriber = listener;
      return () => {
        subscriber = null;
      };
    }),
  };

  const assertTrustedSender = vi.fn((event: TrustedSenderEvent) => {
    if (event.senderFrame?.url !== "app://trusted/") throw new Error("Blocked");
  });

  registerToolFilterIpcHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    assertTrustedSender,
    controller,
  );

  return {
    handlers,
    controller,
    assertTrustedSender,
    notify: (state: ToolFilterState) => subscriber?.(state),
  };
}

const trusted = { senderFrame: { url: "app://trusted/" } } as TrustedSenderEvent;
const untrusted = { senderFrame: { url: "https://attacker.invalid/" } } as TrustedSenderEvent;

describe("tool-filter IPC", () => {
  it("rejects untrusted senders on all channels", async () => {
    const { handlers, controller } = setup();

    expect(() => handlers.get("tool-filter:get")?.(untrusted)).toThrow("Blocked");
    await expect(handlers.get("tool-filter:enable")?.(untrusted)).rejects.toThrow("Blocked");
    await expect(handlers.get("tool-filter:disable")?.(untrusted)).rejects.toThrow("Blocked");
    await expect(handlers.get("tool-filter:cancel-download")?.(untrusted)).rejects.toThrow(
      "Blocked",
    );

    expect(controller.getState).not.toHaveBeenCalled();
    expect(controller.enable).not.toHaveBeenCalled();
    expect(controller.disable).not.toHaveBeenCalled();
    expect(controller.cancelDownload).not.toHaveBeenCalled();
  });

  it("handles get, enable, disable, and cancelDownload for trusted senders", async () => {
    const { handlers, controller } = setup();

    expect(handlers.get("tool-filter:get")?.(trusted)).toEqual(mockState);
    expect(controller.getState).toHaveBeenCalledTimes(1);

    const enabledState = await handlers.get("tool-filter:enable")?.(trusted);
    expect(enabledState).toEqual({ ...mockState, enabled: true });
    expect(controller.enable).toHaveBeenCalledTimes(1);

    const disabledState = await handlers.get("tool-filter:disable")?.(trusted);
    expect(disabledState).toEqual({ ...mockState, enabled: false });
    expect(controller.disable).toHaveBeenCalledTimes(1);

    const cancelledState = await handlers.get("tool-filter:cancel-download")?.(trusted);
    expect(cancelledState).toEqual({ ...mockState, enabled: false });
    expect(controller.cancelDownload).toHaveBeenCalledTimes(1);
  });

  it("broadcasts state changes to all non-destroyed BrowserWindows on tool-filter:event", () => {
    const activeWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    const destroyedWindow = { isDestroyed: () => true, webContents: { send: vi.fn() } };
    mocks.windows = [activeWindow, destroyedWindow];

    const { notify } = setup();
    const nextState: ToolFilterState = { ...mockState, enabled: true };
    notify(nextState);

    expect(activeWindow.webContents.send).toHaveBeenCalledWith("tool-filter:event", nextState);
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });
});
