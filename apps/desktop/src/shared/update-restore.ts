import type { UpdateState } from "./contracts";

/** Limits of the UI restore snapshot, shared by the renderer (trimming) and main (validation). */
export const MAX_RESTORE_UI_STATE_BYTES = 512 * 1024;
export const MAX_RESTORE_DRAFTS = 200;
export const MAX_RESTORE_DRAFT_CHARS = 100_000;

/**
 * A downloaded update will be applied by the next quit: the restart is imminent or
 * running (ready, waiting-for-agents, installing), or the handoff already happened and
 * completes when Modus closes (failed with appliesOnQuit). Windows and AppImage also
 * install a `ready` update when the user simply quits (autoInstallOnAppQuit).
 */
export function hasPendingDownloadedUpdate(state: UpdateState): boolean {
  switch (state.status) {
    case "ready":
    case "waiting-for-agents":
    case "installing":
      return true;
    case "failed":
      return state.appliesOnQuit === true;
    default:
      return false;
  }
}
