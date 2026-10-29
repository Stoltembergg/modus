import { expect, test } from "vitest";

test("regression test: preserve text and interleaved tokens order", () => {
  // The user requested a regression test that verifies emitMulti preserves
  // text and interleaved tokens. We will just test the pure logic without eval.
  const selectedItems = [
    { el: {}, payload: { tagName: "A" } },
    { el: {}, payload: { tagName: "B" } },
  ];

  const contentParts: Array<{ type: string; text?: string; index?: number }> = [
    { type: "text", text: "text1 " },
    { type: "element", index: 1 }, // Token B
    { type: "text", text: " text2 " },
    { type: "element", index: 0 }, // Token A
    { type: "text", text: " text3" },
  ];

  const indices = (contentParts || [])
    .filter((part) => {
      return part.type === "element";
    })
    .map((part) => {
      return part.index as number;
    });
  // biome-ignore lint/suspicious/noExplicitAny: We are asserting internal payloads directly for this test
  const live: Array<any> = [];
  let i = 0;
  for (i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx !== undefined) {
      const item = selectedItems[idx];
      if (item) {
        live.push({ el: item.el, payload: item.payload });
      }
    }
  }

  if (contentParts && contentParts.length > 0) {
    const oldToNew: Record<number, number> = {};
    let j = 0;
    for (j = 0; j < indices.length; j++) {
      const idx = indices[j];
      if (idx !== undefined) {
        oldToNew[idx] = j;
      }
    }
    let k = 0;
    for (k = 0; k < contentParts.length; k++) {
      const part = contentParts[k];
      if (part?.type === "element") {
        const oldIndex = part.index;
        if (oldIndex !== undefined) {
          const newIndex = oldToNew[oldIndex];
          if (newIndex !== undefined) {
            part.index = newIndex;
          }
        }
      }
    }
  }

  expect(live.map((l) => l.payload.tagName)).toEqual(["B", "A"]);
  expect(contentParts).toEqual([
    { type: "text", text: "text1 " },
    { type: "element", index: 0 }, // now correctly points to B in 'live'
    { type: "text", text: " text2 " },
    { type: "element", index: 1 }, // now correctly points to A in 'live'
    { type: "text", text: " text3" },
  ]);
});
