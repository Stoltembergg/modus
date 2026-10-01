import { describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { mergeGroupMessages } from "./useGroupMessages";

const msg = (id: string, createdAt: string): GroupMessage => ({
  id,
  groupId: "g",
  authorKind: "user",
  kind: "message",
  body: id,
  mentions: [],
  createdAt,
});

describe("mergeGroupMessages", () => {
  it("dedupes by id and keeps (createdAt, id) order", () => {
    const current = [msg("b", "2"), msg("c", "3")];
    const merged = mergeGroupMessages(current, [msg("a", "1"), msg("c", "3"), msg("d", "3")]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    // Nothing new: the same array (no re-render).
    expect(mergeGroupMessages(merged, [msg("b", "2")])).toBe(merged);
  });
});

describe("canonical message updates", () => {
  it("updates a card by id without moving its original position", () => {
    const current = [
      { ...msg("a", "1"), updatedAt: "2", body: "prefix", sequence: 1, status: "writing" },
      { ...msg("b", "2"), sequence: 2 },
    ] as GroupMessage[];
    const update = {
      ...msg("a", "9"),
      updatedAt: "3",
      body: "prefix suffix",
      sequence: 9,
      status: "completed",
    } as GroupMessage;
    const merged = mergeGroupMessages(current, [update]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b"]);
    expect(merged[0]?.body).toBe("prefix suffix");
    expect(merged[0]?.createdAt).toBe("1");
    expect(mergeGroupMessages(merged, current)[0]?.body).toBe("prefix suffix");
  });
});

describe("message revision ordering", () => {
  it("ignores a duplicate revision instead of regressing a completed card", () => {
    const current = [
      { ...msg("a", "1"), updatedAt: "3", body: "done", status: "completed" },
    ] as GroupMessage[];
    const stale = {
      ...msg("a", "1"),
      updatedAt: "3",
      body: "prefix",
      status: "writing",
    } as GroupMessage;
    expect(mergeGroupMessages(current, [stale])).toBe(current);
  });
});
