import { useEffect, useState } from "react";
import type {
  AppearanceState,
  LookPreference,
  TransparencyPreference,
} from "../../../shared/appearance";
import { setThemeLook } from "./theme";

function appearanceApi() {
  return typeof window === "undefined" ? undefined : window.modus?.app.appearance;
}

/** Main-process appearance state (null outside Electron, e.g. tests and the web preview). */
export function useAppearanceState(): AppearanceState | null {
  const [state, setState] = useState<AppearanceState | null>(
    () => appearanceApi()?.initial ?? null,
  );
  useEffect(() => {
    const api = appearanceApi();
    if (!api) return;
    const unsubscribe = api.onChange(setState);
    void api
      .get()
      .then(setState)
      .catch(() => undefined);
    return unsubscribe;
  }, []);
  return state;
}

/** Reflect the applied Transparency mode onto <html data-transparency> (full | sidebar | off). */
export function applyTransparencyAttribute(state: Pick<AppearanceState, "glassMode">): void {
  document.documentElement.dataset.transparency = state.glassMode;
}

/** Reflect the look onto <html data-ui> (classic | new) and let the theme drop Eye-care Dark in the new look. */
export function applyLookAttribute(state: Pick<AppearanceState, "look">): void {
  void state;
  const look = "new";
  document.documentElement.dataset.ui = look;
  setThemeLook(look);
}

/** Keep <html data-transparency> and <html data-ui> on the main-process state; index.html set the first frame. */
export function initAppearanceAttributes(): void {
  const api = appearanceApi();
  if (!api) {
    if (!document.documentElement.dataset.ui) {
      document.documentElement.dataset.ui = "new";
    }
    return;
  }
  const apply = (state: AppearanceState): void => {
    applyTransparencyAttribute(state);
    applyLookAttribute(state);
  };
  if (api.initial) apply(api.initial);
  api.onChange(apply);
}

export function setTransparency(transparency: TransparencyPreference): void {
  void appearanceApi()
    ?.set({ transparency })
    .catch(() => undefined);
}
