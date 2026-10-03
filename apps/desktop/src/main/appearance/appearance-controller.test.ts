import { describe, expect, it, vi } from "vitest";
import {
  type AppearancePreferences,
  DEFAULT_APPEARANCE_PREFERENCES,
} from "../../shared/appearance";
import { resolveWindowAppearance } from "../../shared/window-appearance";
import {
  APPEARANCE_ARGUMENT_PREFIX,
  type AppearanceWindow,
  createAppearanceController,
  GLASS_OFF_WINDOW_DELAY_MS,
} from "./appearance-controller";

function fakeNativeTheme(dark = true) {
  const listeners: (() => void)[] = [];
  return {
    themeSource: "system" as "system" | "light" | "dark",
    shouldUseDarkColors: dark,
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
    inForcedColorsMode: false,
    on: vi.fn((_event: string, listener: () => void) => {
      listeners.push(listener);
    }),
    emitUpdated: () => {
      for (const listener of listeners) listener();
    },
  };
}

function fakeWindow() {
  const handlers = new Map<string, () => void>();
  const calls: string[] = [];
  const window = {
    isDestroyed: () => false,
    setVibrancy: vi.fn((v: unknown): void => {
      calls.push(`vibrancy:${v}`);
    }),
    setBackgroundMaterial: vi.fn((m: unknown): void => {
      calls.push(`material:${m}`);
    }),
    setBackgroundColor: vi.fn((c: unknown): void => {
      calls.push(`bg:${c}`);
    }),
    setTitleBarOverlay: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
    once: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
    webContents: {
      send: vi.fn((_channel: string, state: { glass: boolean }) =>
        calls.push(`send:${state.glass}`),
      ),
      on: vi.fn((event: string, handler: () => void) => handlers.set(`wc:${event}`, handler)),
    },
  };
  return { window: window as unknown as AppearanceWindow, raw: window, handlers, calls };
}

function setup({
  platform = "darwin",
  version = "15.0.0",
  stored = DEFAULT_APPEARANCE_PREFERENCES,
  dark = true,
}: {
  platform?: string;
  version?: string;
  stored?: AppearancePreferences;
  dark?: boolean;
} = {}) {
  const nativeTheme = fakeNativeTheme(dark);
  const store = { read: vi.fn(() => ({ ...stored })), write: vi.fn() };
  const scheduled: (() => void)[] = [];
  const schedule = vi.fn((callback: () => void, ms: number) => {
    expect(ms).toBe(GLASS_OFF_WINDOW_DELAY_MS);
    scheduled.push(callback);
  });
  const controller = createAppearanceController({
    nativeTheme: nativeTheme as unknown as Parameters<
      typeof createAppearanceController
    >[0]["nativeTheme"],
    store,
    windowAppearance: resolveWindowAppearance(platform, version),
    schedule,
  });
  return { controller, nativeTheme, store, scheduled };
}

describe("appearance controller", () => {
  it("syncs nativeTheme.themeSource from the stored theme before any window exists", () => {
    expect(
      setup({ stored: { theme: "dark-plus", transparency: "auto" } }).nativeTheme.themeSource,
    ).toBe("dark");
    expect(
      setup({ stored: { theme: "light", transparency: "auto" } }).nativeTheme.themeSource,
    ).toBe("light");
    expect(
      setup({ stored: { theme: "system", transparency: "auto" } }).nativeTheme.themeSource,
    ).toBe("system");
  });

  it("passes the first-paint state to the preload as a command-line flag", () => {
    const { controller } = setup();
    const arg = controller.rendererArgument();
    expect(arg.startsWith(APPEARANCE_ARGUMENT_PREFIX)).toBe(true);
    expect(JSON.parse(arg.slice(APPEARANCE_ARGUMENT_PREFIX.length))).toMatchObject({
      theme: "dark",
      transparency: "auto",
      glass: true,
      material: "vibrancy",
    });
  });

  it("turns macOS vibrancy off for the light theme as soon as the window is attached", () => {
    const { controller } = setup({ stored: { theme: "light", transparency: "auto" } });
    const { window, raw } = fakeWindow();
    controller.attach(window, { nativeGlassAvailable: true });
    expect(raw.setVibrancy).toHaveBeenCalledWith(null);
    expect(raw.setBackgroundColor).toHaveBeenCalledWith("#ffffff");
  });

  it("persists Off, paints solid CSS first and only then makes the window opaque", () => {
    const { controller, store, scheduled } = setup();
    const { window, calls } = fakeWindow();
    controller.attach(window, { nativeGlassAvailable: true });
    calls.length = 0;

    expect(controller.set({ transparency: "off" })).toMatchObject({
      glass: false,
      blockedBy: "user",
    });
    expect(store.write).toHaveBeenCalledWith({ theme: "dark", transparency: "off" });
    expect(calls).toEqual(["send:false"]);
    for (const callback of scheduled) callback();
    expect(calls).toEqual(["send:false", "vibrancy:null", "bg:#131314"]);

    calls.length = 0;
    controller.set({ transparency: "auto" });
    expect(calls).toEqual(["vibrancy:sidebar", "bg:#00000000", "send:true"]);
  });

  it("follows the OS through nativeTheme `updated` and window focus", () => {
    const { controller, nativeTheme } = setup({
      stored: { theme: "system", transparency: "auto" },
    });
    const { window, raw, handlers } = fakeWindow();
    controller.attach(window, { nativeGlassAvailable: true });
    raw.webContents.send.mockClear();

    nativeTheme.shouldUseDarkColors = false;
    nativeTheme.emitUpdated();
    expect(controller.getState()).toMatchObject({ effectiveTheme: "light", glass: false });

    nativeTheme.shouldUseDarkColors = true;
    nativeTheme.emitUpdated();
    nativeTheme.prefersReducedTransparency = true;
    handlers.get("focus")?.();
    expect(controller.getState()).toMatchObject({
      glass: false,
      blockedBy: "os-reduced-transparency",
    });
    expect(raw.webContents.send).toHaveBeenCalledTimes(3);
  });

  it("does not resend when nothing changed", () => {
    const { controller, nativeTheme } = setup();
    const { window, raw } = fakeWindow();
    controller.attach(window, { nativeGlassAvailable: true });
    raw.webContents.send.mockClear();
    nativeTheme.emitUpdated();
    controller.set({ theme: "dark" });
    expect(raw.webContents.send).not.toHaveBeenCalled();
  });

  it("uses Mica on Windows 11, tints the caption buttons and falls back to solid when DWM declines", () => {
    const { controller } = setup({ platform: "win32", version: "10.0.22631" });
    const ok = fakeWindow();
    controller.attach(ok.window, { nativeGlassAvailable: true });
    expect(ok.raw.setBackgroundMaterial).toHaveBeenCalledWith("mica");
    expect(ok.raw.setTitleBarOverlay).toHaveBeenCalledWith({ symbolColor: "#d8d8d7", height: 36 });

    const failing = setup({ platform: "win32", version: "10.0.22631" });
    const broken = fakeWindow();
    broken.raw.setBackgroundMaterial.mockImplementation((material: unknown) => {
      if (material === "mica") throw new Error("DWM declined");
    });
    failing.controller.attach(broken.window, { nativeGlassAvailable: true });
    expect(failing.controller.getState()).toMatchObject({ glass: false, blockedBy: "platform" });
    expect(broken.raw.setBackgroundColor).toHaveBeenLastCalledWith("#131314");
  });

  it("treats a window created without native glass as a solid host", () => {
    const { controller } = setup();
    const { window, raw } = fakeWindow();
    controller.attach(window, { nativeGlassAvailable: false });
    expect(controller.getState()).toMatchObject({ glass: false, blockedBy: "platform" });
    expect(raw.setVibrancy).not.toHaveBeenCalled();
  });

  it("re-sends the state after every renderer load", () => {
    const { controller } = setup();
    const { window, raw, handlers } = fakeWindow();
    controller.attach(window, { nativeGlassAvailable: true });
    handlers.get("wc:did-finish-load")?.();
    expect(raw.webContents.send).toHaveBeenCalledWith(
      "appearance:event",
      expect.objectContaining({ glass: true }),
    );
  });
});
