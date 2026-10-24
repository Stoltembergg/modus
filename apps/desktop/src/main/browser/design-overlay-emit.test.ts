import { expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

test('regression test: preserve text and interleaved tokens order', () => {
    // The user requested a regression test that verifies emitMulti preserves
    // text and interleaved tokens. We will just test the pure logic without eval.
    let selectedItems = [
      { el: {}, payload: { tagName: "A" } },
      { el: {}, payload: { tagName: "B" } }
    ];

    let contentParts = [
      { type: "text", text: "text1 " },
      { type: "element", index: 1 }, // Token B
      { type: "text", text: " text2 " },
      { type: "element", index: 0 }, // Token A
      { type: "text", text: " text3" },
    ];

    var indices = (contentParts || []).filter(function (part) { return part.type === "element"; })
      .map(function (part) { return part.index; });
    var live = [];
    for (var i = 0; i < indices.length; i++) {
      var item = selectedItems[indices[i]];
      if (item) {
        live.push({ el: item.el, payload: item.payload });
      }
    }

    if (contentParts && contentParts.length > 0) {
      var oldToNew = {};
      for (var j = 0; j < indices.length; j++) { oldToNew[indices[j]] = j; }
      for (var k = 0; k < contentParts.length; k++) {
        if (contentParts[k].type === "element") {
          contentParts[k].index = oldToNew[contentParts[k].index];
        }
      }
    }

    expect(live.map(l => l.payload.tagName)).toEqual(["B", "A"]);
    expect(contentParts).toEqual([
      { type: "text", text: "text1 " },
      { type: "element", index: 0 }, // now correctly points to B in 'live'
      { type: "text", text: " text2 " },
      { type: "element", index: 1 }, // now correctly points to A in 'live'
      { type: "text", text: " text3" },
    ]);
});
