import type {
  AgentMode,
  UpdateRestoreInspectorTab,
  UpdateRestoreUiState,
} from "../../../../shared/contracts";
import {
  hasPendingDownloadedUpdate,
  MAX_RESTORE_DRAFT_CHARS,
  MAX_RESTORE_DRAFTS,
  MAX_RESTORE_UI_STATE_BYTES,
} from "../../../../shared/update-restore";
import type { MentionEditorPart } from "../composer/MentionEditor";
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
  /** Start-screen composer text; its context chips and images are left out. */
  heroDraft: { value: string };
  heroMode: AgentMode;
  /** Sessions the sidebar knows; drafts of anything else are left out. */
  sessionIds: ReadonlySet<string>;
  sidebar: { open: boolean; width: number };
  inspector: { open: boolean; width: number; tab: string };
  settingsOpen: boolean;
};

/** Nothing typed or attached: safe to fill with a restored draft. */
export function isComposerDraftEmpty(draft: {
  value: string;
  images: readonly unknown[];
  selectedSkills: readonly unknown[];
  parts?: readonly MentionEditorPart[] | undefined;
  contextItems?: readonly unknown[] | undefined;
}): boolean {
  return (
    !draft.value.trim() &&
    draft.images.length === 0 &&
    draft.selectedSkills.length === 0 &&
    (draft.contextItems?.length ?? 0) === 0 &&
    !(draft.parts ?? []).some((part) => part.type !== "text" || part.text.trim() !== "")
  );
}

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
  const heroText = input.heroDraft.value.trim() ? input.heroDraft.value : "";
  const tab = INSPECTOR_TABS.find((known) => known === input.inspector.tab) ?? "changes";
  return fitUiStateToCap({
    activeWorkspaceId: input.activeWorkspaceId ?? null,
    activeSessionId: input.activeSessionId ?? null,
    drafts,
    hero: { text: heroText, mode: input.heroMode },
    sidebar: { open: input.sidebar.open, width: panelWidth(input.sidebar.width) },
    inspector: { open: input.inspector.open, width: panelWidth(input.inspector.width), tab },
    settingsOpen: input.settingsOpen,
  });
}

const encoder = new TextEncoder();

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/**
 * Keeps the snapshot inside main's limits so one huge draft does not cost the rest: a
 * draft over the per-draft limit is dropped, then the largest drafts (the hero text
 * counts as one) go until at most MAX_RESTORE_DRAFTS remain and the payload fits the
 * byte cap. Layout and navigation are never trimmed.
 */
export function fitUiStateToCap(state: UpdateRestoreUiState): UpdateRestoreUiState {
  const HERO = Symbol("hero");
  type Entry = { key: string | typeof HERO; bytes: number };
  const drafts = { ...state.drafts };
  let hero = state.hero;
  const entries: Entry[] = [];
  for (const [sessionId, draft] of Object.entries(drafts)) {
    if (draft.text.length > MAX_RESTORE_DRAFT_CHARS) delete drafts[sessionId];
    else entries.push({ key: sessionId, bytes: byteLength(draft.text) });
  }
  if (hero.text.length > MAX_RESTORE_DRAFT_CHARS) hero = { ...hero, text: "" };
  else if (hero.text) entries.push({ key: HERO, bytes: byteLength(hero.text) });
  entries.sort((a, b) => b.bytes - a.bytes);

  const build = (): UpdateRestoreUiState => ({ ...state, drafts: { ...drafts }, hero });
  const dropLargest = () => {
    const entry = entries.shift();
    if (!entry) return false;
    if (entry.key === HERO) hero = { ...hero, text: "" };
    else delete drafts[entry.key];
    return true;
  };
  while (Object.keys(drafts).length > MAX_RESTORE_DRAFTS) {
    // Only session drafts count towards the limit: skip the hero entry here.
    const index = entries.findIndex((entry) => entry.key !== HERO);
    const [entry] = entries.splice(index, 1);
    if (entry && entry.key !== HERO) delete drafts[entry.key];
  }
  let next = build();
  while (byteLength(next) > MAX_RESTORE_UI_STATE_BYTES && dropLargest()) next = build();
  return next;
}

export type UiRestorePlan = {
  /** null when the project or the session no longer exists: the app keeps its default. */
  navigation: { activeWorkspaceId: string | null; activeSessionId: string | null } | null;
  /** Only drafts whose session still exists. */
  drafts: UpdateRestoreUiState["drafts"];
  /** null when the start-screen composer was empty. */
  hero: UpdateRestoreUiState["hero"] | null;
  /** Sizes, open state, inspector tab and settingsOpen: always applied (already validated). */
  layout: Pick<UpdateRestoreUiState, "sidebar" | "inspector" | "settingsOpen">;
};

/**
 * Splits a snapshot into parts that apply on their own, each checked against what exists
 * now: a missing project or session drops only the navigation, a missing session drops
 * only its draft, and the layout always applies.
 */
export function planUiRestore(
  state: UpdateRestoreUiState,
  known: { workspaceIds: ReadonlySet<string>; sessionIds: ReadonlySet<string> },
): UiRestorePlan {
  const workspaceOk =
    state.activeWorkspaceId === null || known.workspaceIds.has(state.activeWorkspaceId);
  const sessionOk = state.activeSessionId === null || known.sessionIds.has(state.activeSessionId);
  const drafts: UpdateRestoreUiState["drafts"] = {};
  for (const [sessionId, draft] of Object.entries(state.drafts)) {
    if (known.sessionIds.has(sessionId)) drafts[sessionId] = draft;
  }
  return {
    navigation:
      workspaceOk && sessionOk
        ? { activeWorkspaceId: state.activeWorkspaceId, activeSessionId: state.activeSessionId }
        : null,
    drafts,
    hero: state.hero.text ? state.hero : null,
    layout: {
      sidebar: state.sidebar,
      inspector: state.inspector,
      settingsOpen: state.settingsOpen,
    },
  };
}

type ComposerDraftLike = Parameters<typeof isComposerDraftEmpty>[0];

/**
 * Fills restored drafts only into composers that are still empty, so anything typed or
 * attached since startup wins. Returns `current` itself when nothing changes.
 */
export function mergeRestoredDrafts<T extends ComposerDraftLike>(
  current: Record<string, T>,
  drafts: UpdateRestoreUiState["drafts"],
  toDraft: (draft: UpdateRestoreUiState["drafts"][string]) => T,
): Record<string, T> {
  let next = current;
  for (const [sessionId, draft] of Object.entries(drafts)) {
    const existing = current[sessionId];
    if (existing && !isComposerDraftEmpty(existing)) continue;
    if (next === current) next = { ...current };
    next[sessionId] = toDraft(draft);
  }
  return next;
}

/**
 * True while the selection is still the startup default (no session, the first project
 * or none yet): the user has not switched project or session, so restoring is safe.
 */
export function isNavigationUntouched(
  current: { workspaceId: string | undefined; sessionId: string | undefined },
  defaultWorkspaceId: string | undefined,
): boolean {
  return (
    current.sessionId === undefined &&
    (current.workspaceId === undefined || current.workspaceId === defaultWorkspaceId)
  );
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
