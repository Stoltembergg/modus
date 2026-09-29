import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRestoreUiState, UpdateState } from "../../../../shared/contracts";
import {
  MAX_RESTORE_DRAFT_CHARS,
  MAX_RESTORE_DRAFTS,
  MAX_RESTORE_UI_STATE_BYTES,
} from "../../../../shared/update-restore";
import {
  createUiStatePusher,
  fitUiStateToCap,
  isComposerDraftEmpty,
  isNavigationUntouched,
  mergeRestoredDrafts,
  planUiRestore,
  snapshotUiState,
  UI_STATE_PUSH_DEBOUNCE_MS,
  UI_STATE_PUSH_MAX_WAIT_MS,
} from "./restoreUiState";

const STATE: UpdateRestoreUiState = {
  activeWorkspaceId: "ws-1",
  activeSessionId: "s-1",
  drafts: { "s-1": { text: "draft", mode: "build" } },
  hero: { text: "", mode: "build" },
  sidebar: { open: true, width: 300 },
  inspector: { open: false, width: 384, tab: "changes" },
  settingsOpen: false,
};

function fakeApi(initial: UpdateState) {
  const listeners = new Set<(state: UpdateState) => void>();
  const api = {
    getState: vi.fn(async () => initial),
    onStateChange: vi.fn((listener: (state: UpdateState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    saveUiState: vi.fn(async (_state: UpdateRestoreUiState) => undefined),
  };
  const push = (state: UpdateState) => {
    for (const listener of listeners) listener(state);
  };
  return { api, push, listeners };
}

describe("snapshotUiState", () => {
  it("keeps non-empty drafts of known sessions as text and mode only", () => {
    const snapshot = snapshotUiState({
      activeWorkspaceId: undefined,
      activeSessionId: "s-1",
      composerDraftBySession: {
        "s-1": { value: "keep me", mode: "plan", images: [{ id: "img" }] } as never,
        "s-2": { value: "   ", mode: "build" },
        gone: { value: "orphan", mode: "build" },
      },
      heroDraft: { value: "   " },
      heroMode: "plan",
      sessionIds: new Set(["s-1", "s-2"]),
      sidebar: { open: false, width: 301.6 },
      inspector: { open: true, width: Number.POSITIVE_INFINITY, tab: "not-a-tab" },
      settingsOpen: true,
    });
    expect(snapshot).toEqual({
      activeWorkspaceId: null,
      activeSessionId: "s-1",
      drafts: { "s-1": { text: "keep me", mode: "plan" } },
      hero: { text: "", mode: "plan" },
      sidebar: { open: false, width: 302 },
      inspector: { open: true, width: 4096, tab: "changes" },
      settingsOpen: true,
    });
  });
});

describe("snapshotUiState hero", () => {
  it("keeps the start-screen text and mode", () => {
    const snapshot = snapshotUiState({
      activeWorkspaceId: "ws-1",
      activeSessionId: undefined,
      composerDraftBySession: {},
      heroDraft: { value: "an idea\nsecond line" },
      heroMode: "spec",
      sessionIds: new Set(),
      sidebar: { open: true, width: 300 },
      inspector: { open: false, width: 384, tab: "changes" },
      settingsOpen: false,
    });
    expect(snapshot.hero).toEqual({ text: "an idea\nsecond line", mode: "spec" });
  });
});

describe("fitUiStateToCap", () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const draft = (chars: number, char = "é") => ({
    text: char.repeat(chars),
    mode: "build" as const,
  });

  it("leaves a payload under the cap untouched", () => {
    expect(fitUiStateToCap(STATE)).toEqual(STATE);
  });

  it("drops the largest drafts until the payload fits, keeping the rest", () => {
    // "é" is 2 bytes: about 780 KB in total; dropping only the largest is not enough.
    const state = {
      ...STATE,
      drafts: {
        a: draft(99_000),
        b: draft(98_000),
        c: draft(96_000),
        d: draft(97_000),
        small: draft(10, "x"),
      },
    };
    expect(bytes(state)).toBeGreaterThan(MAX_RESTORE_UI_STATE_BYTES);
    const fitted = fitUiStateToCap(state);
    expect(Object.keys(fitted.drafts).sort()).toEqual(["c", "d", "small"]);
    expect(bytes(fitted)).toBeLessThanOrEqual(MAX_RESTORE_UI_STATE_BYTES);
    expect(fitted.sidebar).toEqual(STATE.sidebar);
    expect(fitted.activeSessionId).toBe(STATE.activeSessionId);
  });

  it("counts the hero text as a draft", () => {
    const state = {
      ...STATE,
      drafts: { a: draft(90_000), b: draft(90_000) },
      hero: { text: "é".repeat(99_000), mode: "plan" as const },
    };
    const fitted = fitUiStateToCap(state);
    expect(fitted.hero).toEqual({ text: "", mode: "plan" });
    expect(Object.keys(fitted.drafts).sort()).toEqual(["a", "b"]);
  });

  it("drops drafts over the per-draft limit and keeps at most the draft limit", () => {
    const tooLong = {
      ...STATE,
      drafts: { long: draft(MAX_RESTORE_DRAFT_CHARS + 1, "x"), ok: draft(3, "x") },
    };
    expect(Object.keys(fitUiStateToCap(tooLong).drafts)).toEqual(["ok"]);
    const longHero = {
      ...STATE,
      hero: { text: "x".repeat(MAX_RESTORE_DRAFT_CHARS + 1), mode: "build" as const },
    };
    expect(fitUiStateToCap(longHero).hero.text).toBe("");

    const many = Object.fromEntries(
      Array.from({ length: MAX_RESTORE_DRAFTS + 3 }, (_, i) => [
        `s-${i}`,
        draft(i < 3 ? 50 : 5, "x"),
      ]),
    );
    const fitted = fitUiStateToCap({ ...STATE, drafts: many });
    expect(Object.keys(fitted.drafts)).toHaveLength(MAX_RESTORE_DRAFTS);
    expect(fitted.drafts["s-0"]).toBeUndefined();
    expect(fitted.drafts["s-2"]).toBeUndefined();
    expect(fitted.drafts["s-3"]).toBeDefined();
  });

  it("is applied by snapshotUiState", () => {
    const snapshot = snapshotUiState({
      activeWorkspaceId: "ws-1",
      activeSessionId: "a",
      composerDraftBySession: Object.fromEntries(
        ["a", "b", "c", "d"].map((id, i) => [
          id,
          { value: "é".repeat(80_000 + i), mode: "build" as const },
        ]),
      ),
      heroDraft: { value: "" },
      heroMode: "build",
      sessionIds: new Set(["a", "b", "c", "d"]),
      sidebar: { open: true, width: 300 },
      inspector: { open: false, width: 384, tab: "changes" },
      settingsOpen: false,
    });
    expect(Object.keys(snapshot.drafts).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("isComposerDraftEmpty", () => {
  const empty = { value: "", images: [], selectedSkills: [] };
  it("treats whitespace and empty text parts as empty", () => {
    expect(isComposerDraftEmpty(empty)).toBe(true);
    expect(
      isComposerDraftEmpty({ ...empty, value: "  \n", parts: [{ type: "text", text: " " }] }),
    ).toBe(true);
  });
  it("sees text, images, skills, context chips and inline tokens", () => {
    expect(isComposerDraftEmpty({ ...empty, value: "hi" })).toBe(false);
    expect(isComposerDraftEmpty({ ...empty, images: [{}] })).toBe(false);
    expect(isComposerDraftEmpty({ ...empty, selectedSkills: [{}] })).toBe(false);
    expect(isComposerDraftEmpty({ ...empty, contextItems: [{}] })).toBe(false);
    expect(
      isComposerDraftEmpty({
        ...empty,
        parts: [{ type: "skill", skill: { name: "x", path: "/x" } as never }],
      }),
    ).toBe(false);
  });
});

describe("planUiRestore", () => {
  const known = { workspaceIds: new Set(["ws-1"]), sessionIds: new Set(["s-1", "s-2"]) };
  const layout = { sidebar: STATE.sidebar, inspector: STATE.inspector, settingsOpen: false };

  it("keeps every part when all ids exist", () => {
    const state = { ...STATE, hero: { text: "idea", mode: "plan" as const } };
    expect(planUiRestore(state, known)).toEqual({
      navigation: { activeWorkspaceId: "ws-1", activeSessionId: "s-1" },
      drafts: STATE.drafts,
      hero: { text: "idea", mode: "plan" },
      layout,
    });
    const chats = { ...STATE, activeWorkspaceId: null, activeSessionId: null };
    expect(planUiRestore(chats, known).navigation).toEqual({
      activeWorkspaceId: null,
      activeSessionId: null,
    });
  });

  it.each([
    ["project", { ...STATE, activeWorkspaceId: "ws-gone" }],
    ["session", { ...STATE, activeSessionId: "s-gone" }],
  ])("drops only the navigation when the %s no longer exists", (_label, state) => {
    const plan = planUiRestore(state, known);
    expect(plan.navigation).toBeNull();
    expect(plan.drafts).toEqual(STATE.drafts);
    expect(plan.layout).toEqual(layout);
  });

  it("keeps each draft only if its session still exists", () => {
    const state = {
      ...STATE,
      drafts: {
        "s-1": { text: "one", mode: "build" as const },
        "s-gone": { text: "lost", mode: "plan" as const },
        "s-2": { text: "two", mode: "spec" as const },
      },
    };
    const plan = planUiRestore(state, known);
    expect(plan.drafts).toEqual({
      "s-1": { text: "one", mode: "build" },
      "s-2": { text: "two", mode: "spec" },
    });
    expect(plan.navigation).not.toBeNull();
  });

  it("applies the layout on its own when nothing else survives", () => {
    const state: UpdateRestoreUiState = {
      activeWorkspaceId: "ws-gone",
      activeSessionId: "s-gone",
      drafts: { "s-gone": { text: "lost", mode: "build" } },
      hero: { text: "", mode: "build" },
      sidebar: { open: false, width: 410 },
      inspector: { open: true, width: 700, tab: "terminal" },
      settingsOpen: true,
    };
    expect(planUiRestore(state, { workspaceIds: new Set(), sessionIds: new Set() })).toEqual({
      navigation: null,
      drafts: {},
      hero: null,
      layout: {
        sidebar: { open: false, width: 410 },
        inspector: { open: true, width: 700, tab: "terminal" },
        settingsOpen: true,
      },
    });
  });
});

describe("mergeRestoredDrafts", () => {
  type Draft = { value: string; images: unknown[]; selectedSkills: unknown[]; mode: string };
  const toDraft = (draft: { text: string; mode: string }): Draft => ({
    value: draft.text,
    images: [],
    selectedSkills: [],
    mode: draft.mode,
  });
  const empty = (value = ""): Draft => ({ value, images: [], selectedSkills: [], mode: "build" });

  it("fills missing and empty composers only", () => {
    const current: Record<string, Draft> = {
      typed: empty("user text"),
      blank: empty("  "),
      image: { ...empty(), images: [{ id: "img" }] },
    };
    const merged = mergeRestoredDrafts(
      current,
      {
        typed: { text: "old", mode: "plan" },
        blank: { text: "restored", mode: "plan" },
        image: { text: "old", mode: "plan" },
        fresh: { text: "new", mode: "spec" },
      },
      toDraft,
    );
    expect(merged.typed).toBe(current.typed);
    expect(merged.image).toBe(current.image);
    expect(merged.blank).toEqual(toDraft({ text: "restored", mode: "plan" }));
    expect(merged.fresh).toEqual(toDraft({ text: "new", mode: "spec" }));
  });

  it("returns the same object when nothing applies", () => {
    const current = { typed: empty("mine") };
    expect(mergeRestoredDrafts(current, { typed: { text: "old", mode: "build" } }, toDraft)).toBe(
      current,
    );
    expect(mergeRestoredDrafts(current, {}, toDraft)).toBe(current);
  });

  it("treats a hero composer with context chips as not empty", () => {
    const hero = { value: "", images: [], selectedSkills: [] };
    expect(isComposerDraftEmpty({ ...hero, contextItems: [] })).toBe(true);
    expect(isComposerDraftEmpty({ ...hero, contextItems: [{ type: "file" }] })).toBe(false);
    expect(isComposerDraftEmpty({ ...hero, value: "typed on the start screen" })).toBe(false);
  });
});

describe("isNavigationUntouched", () => {
  it("is true at the startup default", () => {
    expect(isNavigationUntouched({ workspaceId: undefined, sessionId: undefined }, "ws-1")).toBe(
      true,
    );
    expect(isNavigationUntouched({ workspaceId: "ws-1", sessionId: undefined }, "ws-1")).toBe(true);
    expect(isNavigationUntouched({ workspaceId: undefined, sessionId: undefined }, undefined)).toBe(
      true,
    );
  });

  it("is false once the user picked another project or opened a session", () => {
    expect(isNavigationUntouched({ workspaceId: "ws-2", sessionId: undefined }, "ws-1")).toBe(
      false,
    );
    expect(isNavigationUntouched({ workspaceId: "ws-1", sessionId: "s-1" }, "ws-1")).toBe(false);
    expect(isNavigationUntouched({ workspaceId: undefined, sessionId: "s-1" }, "ws-1")).toBe(false);
  });
});

describe("createUiStatePusher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends nothing while no downloaded update is pending", async () => {
    const { api, push } = fakeApi({ status: "idle" });
    const pusher = createUiStatePusher(api);
    await vi.runAllTimersAsync();
    pusher.update(STATE);
    push({ status: "downloading", version: "1.3.0", percent: 50 });
    await vi.advanceTimersByTimeAsync(UI_STATE_PUSH_DEBOUNCE_MS * 4);
    expect(api.saveUiState).not.toHaveBeenCalled();
    pusher.dispose();
  });

  it("pushes at once when an update becomes pending, then debounces changes", async () => {
    const { api, push } = fakeApi({ status: "idle" });
    const pusher = createUiStatePusher(api);
    pusher.update(STATE);
    push({ status: "ready", version: "1.3.0" });
    expect(api.saveUiState).toHaveBeenCalledTimes(1);
    expect(api.saveUiState).toHaveBeenLastCalledWith(STATE);

    const typed = (text: string) => ({
      ...STATE,
      drafts: { "s-1": { text, mode: "build" as const } },
    });
    pusher.update(typed("a"));
    await vi.advanceTimersByTimeAsync(UI_STATE_PUSH_DEBOUNCE_MS - 1);
    pusher.update(typed("ab"));
    await vi.advanceTimersByTimeAsync(UI_STATE_PUSH_DEBOUNCE_MS - 1);
    pusher.update(typed("abc"));
    expect(api.saveUiState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UI_STATE_PUSH_DEBOUNCE_MS);
    expect(api.saveUiState).toHaveBeenCalledTimes(2);
    expect(api.saveUiState).toHaveBeenLastCalledWith(typed("abc"));

    // Staying pending (ready -> installing) does not re-send.
    push({ status: "installing", version: "1.3.0" });
    expect(api.saveUiState).toHaveBeenCalledTimes(2);
    pusher.dispose();
  });

  it("still pushes at least every 2 s while changes keep coming", async () => {
    expect(UI_STATE_PUSH_MAX_WAIT_MS).toBe(2000);
    const { api, push } = fakeApi({ status: "idle" });
    const pusher = createUiStatePusher(api);
    pusher.update(STATE);
    push({ status: "ready", version: "1.3.0" });
    expect(api.saveUiState).toHaveBeenCalledTimes(1);

    const typed = (n: number) => ({
      ...STATE,
      drafts: { "s-1": { text: `t${n}`, mode: "build" as const } },
    });
    // A keystroke every 100 ms for 4.5 s never leaves a 500 ms gap.
    for (let n = 1; n <= 45; n += 1) {
      pusher.update(typed(n));
      await vi.advanceTimersByTimeAsync(100);
    }
    // Pushes at 2 s and 4 s (each with the latest text at that moment).
    expect(api.saveUiState).toHaveBeenCalledTimes(3);
    expect(api.saveUiState.mock.calls[1]?.[0]).toEqual(typed(20));
    expect(api.saveUiState.mock.calls[2]?.[0]).toEqual(typed(40));
    // Typing stops: the trailing debounce sends the final text.
    await vi.advanceTimersByTimeAsync(UI_STATE_PUSH_DEBOUNCE_MS);
    expect(api.saveUiState).toHaveBeenCalledTimes(4);
    expect(api.saveUiState).toHaveBeenLastCalledWith(typed(45));
    await vi.advanceTimersByTimeAsync(UI_STATE_PUSH_MAX_WAIT_MS * 2);
    expect(api.saveUiState).toHaveBeenCalledTimes(4);
    pusher.dispose();
  });

  it("starts pending from the initial getState reply", async () => {
    const { api } = fakeApi({ status: "waiting-for-agents", version: "1.3.0" });
    const pusher = createUiStatePusher(api);
    pusher.update(STATE);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.saveUiState).toHaveBeenCalledWith(STATE);
    pusher.dispose();
  });

  it("cancels a scheduled push when the update stops being pending or on dispose", async () => {
    const { api, push, listeners } = fakeApi({ status: "idle" });
    const pusher = createUiStatePusher(api);
    push({ status: "ready", version: "1.3.0" });
    expect(api.saveUiState).not.toHaveBeenCalled(); // no state recorded yet
    pusher.update(STATE);
    push({ status: "failed", version: "1.3.0", retryable: true, action: "install" });
    await vi.advanceTimersByTimeAsync(UI_STATE_PUSH_DEBOUNCE_MS * 2);
    expect(api.saveUiState).not.toHaveBeenCalled();

    push({ status: "ready", version: "1.3.0" });
    expect(api.saveUiState).toHaveBeenCalledTimes(1);
    pusher.update(STATE);
    pusher.dispose();
    await vi.advanceTimersByTimeAsync(UI_STATE_PUSH_DEBOUNCE_MS * 2);
    expect(api.saveUiState).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it("swallows a rejected push", async () => {
    const { api, push } = fakeApi({ status: "idle" });
    api.saveUiState.mockRejectedValueOnce(new Error("gone"));
    const pusher = createUiStatePusher(api);
    pusher.update(STATE);
    push({ status: "ready", version: "1.3.0" });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.saveUiState).toHaveBeenCalledTimes(1);
    pusher.dispose();
  });
});
