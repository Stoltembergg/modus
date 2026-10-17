import { useSyncExternalStore } from "react";
import type { UiLanguagePreference, UiLanguageState } from "../../../shared/ui-language";

/**
 * Renderer side of the app language. The main process owns the preference
 * (userData/ui-language.json) and resolves "system" against the OS; here the
 * resolved tag becomes `<html lang>`, which every catalog hook (`useUiLocale`)
 * and every `Intl` formatter (`uiIntl.ts`) reads. Switching is therefore
 * live: one attribute change re-renders every translated component.
 */
type UiLanguageApi = NonNullable<Window["modus"]>["app"]["uiLanguage"];

function api(): UiLanguageApi | undefined {
  return typeof window === "undefined" ? undefined : window.modus?.app?.uiLanguage;
}

let state: UiLanguageState | null = null;
const listeners = new Set<() => void>();

/** Apply a state from main: `<html lang>` + subscribers (the Settings selector). */
export function applyUiLanguageState(next: UiLanguageState | null | undefined): void {
  if (!next || typeof next.intlLocale !== "string") return;
  state = next;
  if (typeof document !== "undefined") document.documentElement.lang = next.intlLocale;
  for (const listener of listeners) listener();
}

let unsubscribe: (() => void) | null = null;

/** Before first render: paint in the stored language, then follow main's changes. */
export function initUiLanguage(): void {
  const bridge = api();
  if (!bridge) return;
  applyUiLanguageState(bridge.initial);
  unsubscribe?.();
  unsubscribe = bridge.onChange(applyUiLanguageState);
  if (!bridge.initial) {
    void bridge
      .get()
      .then(applyUiLanguageState)
      .catch(() => undefined);
  }
}

export async function setUiLanguagePreference(preference: UiLanguagePreference): Promise<void> {
  const bridge = api();
  if (!bridge) return;
  applyUiLanguageState(await bridge.set(preference));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const readState = () => state;

/** Resolved language state for the selector; null outside Electron. */
export function useUiLanguageState(): UiLanguageState | null {
  return useSyncExternalStore(subscribe, readState, readState);
}

/** Test hook: forget the module state between tests. */
export function resetUiLanguageForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  state = null;
  listeners.clear();
}
