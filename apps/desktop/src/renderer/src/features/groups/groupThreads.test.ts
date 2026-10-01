import { describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { buildGroupThreads, replyPreview } from "./groupThreads";

function msg(id: string, body: string, replyTo?: string): GroupMessage {
  return {
    id,
    groupId: "g-1",
    authorKind: "agent",
    authorSessionId: "s-1",
    kind: "message",
    body,
    mentions: [],
    createdAt: `2026-01-01T00:00:0${id}.000Z`,
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
  };
}

describe("buildGroupThreads", () => {
  it("keeps unthreaded messages as roots", () => {
    const threads = buildGroupThreads([msg("1", "a"), msg("2", "b")]);
    expect(threads.map((t) => t.root.id)).toEqual(["1", "2"]);
    expect(threads.every((t) => t.replies.length === 0)).toBe(true);
  });

  it("keeps direct and transitive replies at their canonical chronological position", () => {
    const threads = buildGroupThreads([
      msg("1", "root"),
      msg("2", "reply", "1"),
      msg("3", "nested", "2"),
      msg("4", "other"),
    ]);
    expect(threads.map((thread) => thread.root.id)).toEqual(["1", "2", "3", "4"]);
    expect(threads.every((thread) => thread.replies.length === 0)).toBe(true);
  });

  it("treats dangling reply targets as roots", () => {
    const threads = buildGroupThreads([msg("2", "orphan", "missing")]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.root.id).toBe("2");
  });
});

describe("replyPreview", () => {
  it("truncates long bodies", () => {
    expect(replyPreview("x".repeat(80)).endsWith("…")).toBe(true);
  });
});
