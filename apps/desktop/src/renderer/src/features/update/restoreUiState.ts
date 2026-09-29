import type {
  AgentMode,
  UpdateRestoreInspectorTab,
  UpdateRestoreUiState,
} from "../../../../shared/contracts";
import { hasPendingDownloadedUpdate } from "../../../../shared/update-restore";
import { subscribeToUpdateState, type UpdateApi } from "./UpdateToast";

/** Coalesces bursts (typing, panel drags) into one push to main. */
export const UI_STATE_PUSH_DEBOUNCE_MS = 500;
/** Constant typing still reaches main at least this often. */
export const UI_STATE_PUSH_MAX_WAIT_MS = 2000;

const INSPECTOR_TABS: readonly UpdateRestoreInspectorTab[] = [
  "changes",
  "plan",
  "files",
  "subagents",
  "browser",
  "terminal",
  "security",
];

export type UiStateInput = {
  activeWorkspaceId: string | undefined;
  activeSessionId: string | undefined;
  composerDraftBySession: Record<string, { value: string; mode: AgentMode }>;
  /** Sessions the sidebar knows; drafts of anything else are left out. */
  sessionIds: ReadonlySet<string>;
  sidebar: { open: boolean; width: number };
  inspector: { open: boolean; width: number; tab: string };
  settingsOpen: boolean;
};

/** Main rejects widths outside 0..4096; NaN becomes 0 (the panel's own minimum wins). */
function panelWidth(width: number): number {
  return Math.min(4096, Math.max(0, Math.round(width))) || 0;
}

/** The restorable part of the UI: draft text and mode only (no images or context chips). */
export function snapshotUiState(input: UiStateInput): UpdateRestoreUiState {
  const drafts: UpdateRestoreUiState["drafts"] = {};
  for (const [sessionId, draft] of Object.entries(input.composerDraftBySession)) {
    if (draft.value.trim() && input.sessionIds.has(sessionId)) {
      drafts[sessionId] = { text: draft.value, mode: draft.mode };
    }
  }
  const tab = INSPECTOR_TABS.find((known) => known === input.inspector.tab) ?? "changes";
  return {
    activeWorkspaceId: input.activeWorkspaceId ?? null,
    activeSessionId: input.activeSessionId ?? null,
    drafts,
    sidebar: { open: input.sidebar.open, width: panelWidth(input.sidebar.width) },
    inspector: { open: input.inspector.open, width: panelWidth(input.inspector.width), tab },
    settingsOpen: input.settingsOpen,
  };
}

/**
 * All or nothing: a snapshot that names a project or session that no longer exists
 * (active project, active session or any draft) is dropped whole, so a partial restore
 * never mixes the old layout with a different selection.
 */
export function restorableUiState(
  state: UpdateRestoreUiState,
  known: { workspaceIds: ReadonlySet<string>; sessionIds: ReadonlySet<string> },
): UpdateRestoreUiState | null {
  if (state.activeWorkspaceId !== null && !known.workspaceIds.has(state.activeWorkspaceId)) {
    return null;
  }
  if (state.activeSessionId !== null && !known.sessionIds.has(state.activeSessionId)) {
    return null;
  }
  if (Object.keys(state.drafts).some((sessionId) => !known.sessionIds.has(sessionId))) {
    return null;
  }
  return state;
}

export type UiStatePusher = {
  /** Record the current UI state; pushed (debounced) only while an update is pending. */
  update(state: UpdateRestoreUiState): void;
  dispose(): void;
};

/**
 * While a downloaded update is pending, keeps main's copy of the UI state current: one
 * push right when the update becomes pending, then one per burst of changes, debounced,
 * and at least every `maxWaitMs` while changes keep coming.
 * Main writes its latest copy in before-quit, so nothing is requested at shutdown.
 */
export function createUiStatePusher(
  api: Pick<UpdateApi, "getState" | "onStateChange" | "saveUiState">,
  delayMs = UI_STATE_PUSH_DEBOUNCE_MS,
  maxWaitMs = UI_STATE_PUSH_MAX_WAIT_MS,
): UiStatePusher {
  let latest: UpdateRestoreUiState | null = null;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Started by the first change after a push; not reset by later changes.
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (maxWaitTimer !== undefined) clearTimeout(maxWaitTimer);
    timer = undefined;
    maxWaitTimer = undefined;
  };
  const push = () => {
    cancel();
    if (pending && latest) void api.saveUiState(latest).catch(() => undefined);
  };
  const unsubscribe = subscribeToUpdateState(api, (state) => {
    const next = hasPendingDownloadedUpdate(state);
    if (next === pending) return;
    pending = next;
    if (pending) push();
    else cancel();
  });
  return {
    update(state) {
      latest = state;
      if (!pending) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(push, delayMs);
      maxWaitTimer ??= setTimeout(push, maxWaitMs);
    },
    dispose() {
      cancel();
      unsubscribe();
    },
  };
}
