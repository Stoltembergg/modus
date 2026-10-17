import {
  resolveUiLanguage,
  type UiLanguagePreference,
  type UiLanguageState,
} from "../../shared/ui-language";
import { IPC_CHANNELS } from "../ipc/channels";
import type { UiLanguageStore } from "./ui-language-store";

export const UI_LANGUAGE_ARGUMENT_PREFIX = "--modus-ui-language=";

export type UiLanguageWindow = {
  isDestroyed(): boolean;
  on(event: "focus", listener: () => void): unknown;
  once(event: "closed", listener: () => void): unknown;
  webContents: {
    send(channel: string, state: UiLanguageState): void;
    on(event: "did-finish-load", listener: () => void): unknown;
  };
};

export type UiLanguageController = {
  getState(): UiLanguageState;
  set(preference: UiLanguagePreference): UiLanguageState;
  /** Re-read the OS languages (matters under "system"); notifies only on a change. */
  refresh(): UiLanguageState;
  /** Main-process consumers (application menu, …) rebuilt on every change. */
  onChange(listener: (state: UiLanguageState) => void): () => void;
  /** Command-line flag the preload reads synchronously, so the first frame is already translated. */
  rendererArgument(): string;
  attach(window: UiLanguageWindow): void;
};

/**
 * Owns the app language: persisted preference + OS languages → resolved
 * state. Every change is pushed to each window (`uiLanguage:event`) and to the
 * main-process listeners, so the renderer, the native menu, dialogs and
 * notifications all switch without a restart.
 */
export function createUiLanguageController({
  store,
  systemLocales,
}: {
  store: UiLanguageStore;
  systemLocales: () => readonly string[];
}): UiLanguageController {
  let preference = store.read();
  const readOs = (): string[] => {
    try {
      return [...systemLocales()];
    } catch {
      return [];
    }
  };
  let state = resolveUiLanguage(preference, readOs());
  const windows = new Set<UiLanguageWindow>();
  const listeners = new Set<(state: UiLanguageState) => void>();

  const send = (window: UiLanguageWindow): void => {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.uiLanguageEvent, state);
  };

  const update = (next: UiLanguageState): UiLanguageState => {
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    if (changed) {
      for (const window of windows) send(window);
      for (const listener of listeners) {
        try {
          listener(state);
        } catch (error) {
          console.warn("[modus] Language change listener failed.", error);
        }
      }
    }
    return state;
  };

  return {
    getState: () => state,
    set(next) {
      preference = next;
      store.write(preference);
      return update(resolveUiLanguage(preference, readOs()));
    },
    refresh: () => update(resolveUiLanguage(preference, readOs())),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rendererArgument: () => `${UI_LANGUAGE_ARGUMENT_PREFIX}${JSON.stringify(state)}`,
    attach(window) {
      windows.add(window);
      window.once("closed", () => windows.delete(window));
      // Electron has no event for an OS language change: re-check on focus.
      window.on("focus", () => {
        update(resolveUiLanguage(preference, readOs()));
      });
      window.webContents.on("did-finish-load", () => send(window));
    },
  };
}

let current: (() => UiLanguageState) | null = null;

/** Wire the controller for code that only needs the current language (dialogs, notifications). */
export function setCurrentUiLanguageSource(source: (() => UiLanguageState) | null): void {
  current = source;
}

/** `Intl` / catalog tag of the current app language; undefined (English) before the controller exists. */
export function currentUiLocale(): string | undefined {
  try {
    return current?.().intlLocale;
  } catch {
    return undefined;
  }
}
