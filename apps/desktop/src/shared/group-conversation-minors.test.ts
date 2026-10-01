import { describe, expect, it } from "vitest";
import {
  clearGroupComposerDraft,
  estimateGroupTokens,
  estimateTokensByExecution,
  executionTokenAnchorIds,
  filterMessagesByGroupSearch,
  formatGroupDaySeparator,
  groupComposerDraftKey,
  groupMessageDayKey,
  messageMatchesGroupSearch,
  readGroupComposerDraft,
  withGroupDaySeparators,
  writeGroupComposerDraft,
} from "./group-conversation-minors";

describe("estimateGroupTokens", () => {
  it("ceil-divides by 4", () => {
    expect(estimateGroupTokens("")).toBe(0);
    expect(estimateGroupTokens("abcd")).toBe(1);
    expect(estimateGroupTokens("x".repeat(401))).toBe(101);
  });
});

describe("day separators", () => {
  it("keys by local calendar day", () => {
    expect(groupMessageDayKey("2026-10-01T08:00:00.000Z").length).toBe(10);
  });

  it("labels Today / Yesterday / weekday / date", () => {
    const now = new Date(2026, 9, 1, 12, 0, 0); // Oct 1 local
    const today = new Date(2026, 9, 1, 9, 0, 0).toISOString();
    const yesterday = new Date(2026, 8, 30, 9, 0, 0).toISOString();
    expect(formatGroupDaySeparator(today, now)).toBe("Today");
    expect(formatGroupDaySeparator(yesterday, now)).toBe("Yesterday");
  });

  it("inserts a separator when the day changes", () => {
    const now = new Date(2026, 9, 1, 12, 0, 0);
    const messages = [
      { id: "1", createdAt: new Date(2026, 8, 30, 10, 0, 0).toISOString() },
      { id: "2", createdAt: new Date(2026, 8, 30, 18, 0, 0).toISOString() },
      { id: "3", createdAt: new Date(2026, 9, 1, 9, 0, 0).toISOString() },
    ];
    const items = withGroupDaySeparators(messages, now);
    expect(items.map((item) => item.type)).toEqual(["day", "message", "message", "day", "message"]);
    expect(items[0]).toMatchObject({ type: "day", label: "Yesterday" });
    expect(items[3]).toMatchObject({ type: "day", label: "Today" });
  });
});

describe("search", () => {
  const labels = new Map([["s-1", { title: "Planner" }]]);

  it("matches body and author title", () => {
    expect(
      messageMatchesGroupSearch(
        { body: "Ship login", authorKind: "agent", authorSessionId: "s-1" },
        "plan",
        labels,
      ),
    ).toBe(true);
    expect(messageMatchesGroupSearch({ body: "Hello", authorKind: "user" }, "yo", labels)).toBe(
      true,
    );
    expect(
      filterMessagesByGroupSearch(
        [
          { body: "alpha", authorKind: "user" },
          { body: "beta", authorKind: "agent", authorSessionId: "s-1" },
        ],
        "plan",
        labels,
      ),
    ).toHaveLength(1);
  });
});

describe("execution tokens", () => {
  it("sums estimates per chain and anchors the last message", () => {
    const messages = [
      { id: "u1", chainId: "u1", body: "abcd" },
      { id: "a1", chainId: "u1", body: "abcdefgh" },
      { id: "u2", chainId: "u2", body: "x" },
    ];
    const totals = estimateTokensByExecution(messages);
    expect(totals.get("u1")).toBe(1 + 2);
    expect(totals.get("u2")).toBe(1);
    expect([...executionTokenAnchorIds(messages)].sort()).toEqual(["a1", "u2"]);
  });
});

describe("composer draft storage", () => {
  it("reads and clears per group id", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
    writeGroupComposerDraft("g1", "hello", storage);
    expect(store.get(groupComposerDraftKey("g1"))).toBe("hello");
    expect(readGroupComposerDraft("g1", storage)).toBe("hello");
    clearGroupComposerDraft("g1", storage);
    expect(readGroupComposerDraft("g1", storage)).toBe("");
  });
});
