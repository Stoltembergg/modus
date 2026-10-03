import { useSyncExternalStore } from "react";
import type { ModusModelsStatus } from "../../../../shared/contracts";

/**
 * B4b: Modus state for the model picker without threading props through every Composer
 * host. App feeds it from ModelSettingsState.modus and registers the "Upgrade" action
 * (Settings › Account).
 */
type ModusPickerState = { status: ModusModelsStatus; openUpgrade: (() => void) | undefined };

let state: ModusPickerState = { status: "off", openUpgrade: undefined };
const listeners = new Set<() => void>();

function update(patch: Partial<ModusPickerState>): void {
  const next = { ...state, ...patch };
  if (next.status === state.status && next.openUpgrade === state.openUpgrade) return;
  state = next;
  for (const listener of listeners) listener();
}

export function setModusPickerStatus(status: ModusModelsStatus | undefined): void {
  update({ status: status ?? "off" });
}

export function setModusUpgradeHandler(openUpgrade: (() => void) | undefined): void {
  update({ openUpgrade });
}

export function useModusPickerState(): ModusPickerState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}
