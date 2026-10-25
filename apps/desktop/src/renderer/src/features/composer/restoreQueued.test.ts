import { describe, expect, it } from "vitest";
import { createEmptyComposerDraft } from "./Composer";
import { restoreQueuedToDraft } from "./restoreQueued";

const image = { type: "image" as const, data: "aW1n", mimeType: "image/png", name: "shot.png" };

describe("restoreQueuedToDraft", () => {
  it("puts queued prompts before typed text, in order, and their images first", () => {
    const draft = {
      ...createEmptyComposerDraft(),
      value: "Typed now.",
      images: [
        { id: "a", name: "old.png", mimeType: "image/png", dataUrl: "data:image/png;base64,b2xk" },
      ],
    };
    const next = restoreQueuedToDraft(draft, [
      { text: "First queued.", attachments: [] },
      { text: "Second queued.", attachments: [image] },
    ]);
    expect(next.value).toBe("First queued.\n\nSecond queued.\n\nTyped now.");
    expect(next.images.map((i) => i.dataUrl)).toEqual([
      "data:image/png;base64,aW1n",
      "data:image/png;base64,b2xk",
    ]);
    expect(next.images[0]?.name).toBe("shot.png");
  });

  it("merges into the first text part of a rich draft and leaves an empty restore alone", () => {
    const draft = {
      ...createEmptyComposerDraft(),
      value: "Hi",
      parts: [{ type: "text" as const, text: "Hi" }],
    };
    expect(restoreQueuedToDraft(draft, [])).toBe(draft);
    expect(restoreQueuedToDraft(draft, [{ text: "Queued.", attachments: [] }]).parts).toEqual([
      { type: "text", text: "Queued.\n\nHi" },
    ]);
  });
});
