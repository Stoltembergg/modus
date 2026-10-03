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

export function setTransparency(transparency: TransparencyPreference): void {
  void appearanceApi()
    ?.set({ transparency })
    .catch(() => undefined);
}
