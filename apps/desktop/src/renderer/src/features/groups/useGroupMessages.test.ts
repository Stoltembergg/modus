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
