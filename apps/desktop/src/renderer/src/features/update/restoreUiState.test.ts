import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRestoreUiState, UpdateState } from "../../../../shared/contracts";
import {
  createUiStatePusher,
  isComposerDraftEmpty,
  restorableUiState,
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

describe("restorableUiState", () => {
  const known = { workspaceIds: new Set(["ws-1"]), sessionIds: new Set(["s-1"]) };

  it("keeps a snapshot whose ids all exist", () => {
    expect(restorableUiState(STATE, known)).toBe(STATE);
    const chats = { ...STATE, activeWorkspaceId: null, activeSessionId: null, drafts: {} };
    expect(restorableUiState(chats, known)).toBe(chats);
  });

  it.each([
    ["project", { ...STATE, activeWorkspaceId: "ws-gone" }],
    ["session", { ...STATE, activeSessionId: "s-gone" }],
    [
      "draft session",
      { ...STATE, drafts: { ...STATE.drafts, "s-gone": { text: "x", mode: "build" as const } } },
    ],
  ])("drops the whole snapshot when a %s no longer exists", (_label, state) => {
    expect(restorableUiState(state, known)).toBeNull();
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
