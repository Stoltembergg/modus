import { expect, test } from "vitest";
import * as designOverlay from "./design-overlay";

type SelectionItem = {
  el: { isConnected: boolean };
  payload: { tagName: string };
};

type ContentPart = { type: "text"; text: string } | { type: "element"; index: number };

type RemapSelectionContentParts = (
  contentParts: ContentPart[],
  selectedItems: SelectionItem[],
) => { items: SelectionItem[]; contentParts: ContentPart[] };

test("emits interleaved text with only connected elements remapped to live indices", () => {
  const remap = (
    designOverlay as unknown as {
      remapSelectionContentParts?: RemapSelectionContentParts;
    }
  ).remapSelectionContentParts;

  expect(remap).toBeTypeOf("function");
  if (!remap) return;

  const selectedItems: SelectionItem[] = [
    { el: { isConnected: false }, payload: { tagName: "disconnected" } },
    { el: { isConnected: true }, payload: { tagName: "live-B" } },
    { el: { isConnected: true }, payload: { tagName: "live-C" } },
  ];
  const contentParts: ContentPart[] = [
    { type: "text", text: "before " },
    { type: "element", index: 0 },
    { type: "text", text: " between " },
    { type: "element", index: 1 },
    { type: "text", text: " after " },
    { type: "element", index: 2 },
    { type: "element", index: 99 },
  ];

  const result = remap(contentParts, selectedItems);

  expect(result.items.map((item) => item.payload.tagName)).toEqual(["live-B", "live-C"]);
  expect(result.contentParts).toEqual([
    { type: "text", text: "before " },
    { type: "text", text: " between " },
    { type: "element", index: 0 },
    { type: "text", text: " after " },
    { type: "element", index: 1 },
  ]);
  expect(designOverlay.DESIGN_OVERLAY_BOOTSTRAP).toContain("function remapSelectionContentParts");
  expect(designOverlay.DESIGN_OVERLAY_BOOTSTRAP).toContain(
    "var remapped = remapSelectionContentParts",
  );
});
