import type { BrowserWindow, NativeTheme } from "electron";
import {
  type AppearanceSetInput,
  type AppearanceState,
  type OsAppearance,
  resolveAppearance,
  SOLID_WINDOW_BACKGROUND,
  themeSourceFor,
  WINDOW_SYMBOL_COLOR,
} from "../../shared/appearance";
import type { WindowAppearance } from "../../shared/window-appearance";
import { IPC_CHANNELS } from "../ipc/channels";
import type { AppearanceStore } from "./appearance-store";

export const APPEARANCE_ARGUMENT_PREFIX = "--modus-appearance=";
/** Turning glass off: the renderer paints solid CSS first, then the window goes opaque. */
export const GLASS_OFF_WINDOW_DELAY_MS = 120;
const TRANSPARENT = "#00000000";
const TITLE_BAR_HEIGHT = 36;

type ThemeSource = Pick<
  NativeTheme,
  | "themeSource"
  | "shouldUseDarkColors"
  | "prefersReducedTransparency"
  | "shouldUseHighContrastColors"
  | "inForcedColorsMode"
  | "on"
>;

export type AppearanceWindow = Pick<
  BrowserWindow,
  | "isDestroyed"
  | "setVibrancy"
  | "setBackgroundMaterial"
  | "setBackgroundColor"
  | "setTitleBarOverlay"
  | "on"
  | "once"
> & {
  webContents: Pick<BrowserWindow["webContents"], "send" | "on">;
};

export type AppearanceController = {
  getState(): AppearanceState;
  set(input: AppearanceSetInput): AppearanceState;
  /** Command-line flag the preload reads synchronously for a flash-free first paint. */
  rendererArgument(): string;
  /** Apply the current state to a freshly created window and keep it in sync. */
  attach(window: AppearanceWindow, options: { nativeGlassAvailable: boolean }): void;
};

export function createAppearanceController({
  nativeTheme,
  store,
  windowAppearance,
  schedule = (callback, ms) => {
    setTimeout(callback, ms);
  },
}: {
  nativeTheme: ThemeSource;
  store: AppearanceStore;
  windowAppearance: WindowAppearance;
  schedule?: (callback: () => void, ms: number) => void;
}): AppearanceController {
  let preferences = store.read();
  let host = windowAppearance;
  const windows = new Set<AppearanceWindow>();
  nativeTheme.themeSource = themeSourceFor(preferences.theme);

  const os = (): OsAppearance => ({
    dark: nativeTheme.shouldUseDarkColors,
    reducedTransparency: nativeTheme.prefersReducedTransparency === true,
    highContrast: nativeTheme.shouldUseHighContrastColors || nativeTheme.inForcedColorsMode,
  });
  const compute = (): AppearanceState => resolveAppearance({ window: host, preferences, os: os() });
  let state = compute();

  const send = (window: AppearanceWindow): void => {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.appearanceEvent, state);
  };

  /** Returns false when the OS declined the native material (host downgraded to solid). */
  const apply = (window: AppearanceWindow): boolean => {
    if (window.isDestroyed()) return true;
    const { glass, effectiveTheme } = state;
    if (host.glass === "native" && host.chrome === "macos") {
      window.setVibrancy(glass ? "sidebar" : null);
    }
    if (host.glass === "native" && host.chrome === "windows-overlay") {
      try {
        window.setBackgroundMaterial(glass ? "mica" : "none");
      } catch {
        try {
          window.setBackgroundMaterial("none");
        } catch {
          // The solid colour below keeps the window usable without DWM.
        }
        host = { ...host, glass: "solid" };
        return false;
      }
    }
    if (host.chrome === "windows-overlay") {
      window.setTitleBarOverlay({
        symbolColor: WINDOW_SYMBOL_COLOR[effectiveTheme],
        height: TITLE_BAR_HEIGHT,
      });
    }
    window.setBackgroundColor(glass ? TRANSPARENT : SOLID_WINDOW_BACKGROUND[effectiveTheme]);
    return true;
  };

  const applyAll = (): void => {
    for (const window of windows) {
      if (!apply(window)) {
        refresh();
        return;
      }
    }
  };

  function refresh(): AppearanceState {
    const previous = state;
    state = compute();
    if (JSON.stringify(previous) === JSON.stringify(state)) return state;
    if (previous.glass && !state.glass) {
      // Solid CSS lands first so the window never shows an unpainted frame.
      for (const window of windows) send(window);
      schedule(applyAll, GLASS_OFF_WINDOW_DELAY_MS);
    } else {
      applyAll();
      for (const window of windows) send(window);
    }
    return state;
  }

  nativeTheme.on("updated", () => {
    refresh();
  });

  return {
    getState: () => state,
    set(input) {
      preferences = {
        theme: input.theme ?? preferences.theme,
        transparency: input.transparency ?? preferences.transparency,
      };
      store.write(preferences);
      nativeTheme.themeSource = themeSourceFor(preferences.theme);
      return refresh();
    },
    rendererArgument: () => `${APPEARANCE_ARGUMENT_PREFIX}${JSON.stringify(state)}`,
    attach(window, { nativeGlassAvailable }) {
      if (!nativeGlassAvailable && host.glass === "native") {
        host = { ...host, glass: "solid" };
        state = compute();
      }
      windows.add(window);
      window.once("closed", () => windows.delete(window));
      if (!apply(window)) {
        state = compute();
        apply(window);
      }
      // Electron does not document `updated` for reduced transparency or
      // forced colours, so re-read the OS state whenever the window regains focus.
      window.on("focus", () => {
        refresh();
      });
      window.webContents.on("did-finish-load", () => send(window));
    },
  };
}
