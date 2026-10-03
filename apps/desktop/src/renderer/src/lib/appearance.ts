import { useEffect, useState } from "react";
import type { AppearanceState, TransparencyPreference } from "../../../shared/appearance";

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

/** Keep <html data-transparency> on the main-process state; index.html set the first frame. */
export function initAppearanceAttributes(): void {
  const api = appearanceApi();
  if (!api) return;
  if (api.initial) applyTransparencyAttribute(api.initial);
  api.onChange(applyTransparencyAttribute);
}

export function setTransparency(transparency: TransparencyPreference): void {
  void appearanceApi()
    ?.set({ transparency })
    .catch(() => undefined);
}
