import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  isMentionHref,
  linkMentionsInMarkdown,
  mentionHref,
  mentionSuggestions,
  splitMentions,
} from "./groupMentions";

const MEMBERS = [
  { sessionId: "s-alpha", title: "Alpha" },
  { sessionId: "s-alpha-2", title: "Alpha Two" },
  { sessionId: "s-rev-1", title: "Reviewer" },
  { sessionId: "s-rev-2", title: "reviewer" },
];

describe("group mentions", () => {
  it("splits @title (longest first, case-insensitive) and @sessionId into chips", () => {
    expect(splitMentions("@alpha two and @Alpha, then @s-rev-2!", MEMBERS)).toEqual([
      { kind: "mention", text: "@alpha two", sessionIds: ["s-alpha-2"], label: "Alpha Two" },
      { kind: "text", text: " and " },
      { kind: "mention", text: "@Alpha", sessionIds: ["s-alpha"], label: "Alpha" },
      { kind: "text", text: ", then " },
      { kind: "mention", text: "@s-rev-2", sessionIds: ["s-rev-2"], label: "reviewer" },
      { kind: "text", text: "!" },
    ]);
    // A shared title mentions both; a longer word is no mention.
    expect(splitMentions("@Reviewer", MEMBERS)[0]).toMatchObject({
      sessionIds: ["s-rev-1", "s-rev-2"],
    });
    expect(splitMentions("@Alphabet", MEMBERS)).toEqual([{ kind: "text", text: "@Alphabet" }]);
  });

  it("links mentions in markdown outside code only", () => {
    const out = linkMentionsInMarkdown("Hi @Alpha, run `@Alpha` then\n```\n@Alpha\n```", MEMBERS);
    expect(out).toBe(
      `Hi [@Alpha](${mentionHref(["s-alpha"])}), run \`@Alpha\` then\n\`\`\`\n@Alpha\n\`\`\``,
    );
    expect(isMentionHref(mentionHref(["s-alpha"]))).toBe(true);
    expect(isMentionHref("https://modus.workspace/file?path=a")).toBe(false);
  });

  it("finds the @query at the caret", () => {
    expect(activeMentionQuery("hello @Al", 9)).toEqual({ start: 6, query: "Al" });
    expect(activeMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMentionQuery("mail a@b", 8)).toBeNull();
    expect(activeMentionQuery("@Al done", 8)).toBeNull();
  });

  it("suggests by title; a shared title inserts the session id", () => {
    expect(mentionSuggestions("al", MEMBERS).map((s) => [s.title, s.insert])).toEqual([
      ["Alpha", "Alpha"],
      ["Alpha Two", "Alpha Two"],
    ]);
    expect(mentionSuggestions("rev", MEMBERS)).toEqual([
      { sessionId: "s-rev-1", title: "Reviewer", insert: "s-rev-1", duplicateTitle: true },
      { sessionId: "s-rev-2", title: "reviewer", insert: "s-rev-2", duplicateTitle: true },
    ]);
    expect(mentionSuggestions("", MEMBERS)).toHaveLength(4);
  });
});
