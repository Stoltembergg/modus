import { describe, expect, it } from "vitest";
import { stepLitCells } from "./GridBackground";

describe("stepLitCells", () => {
  it("keeps the cell under the pointer lit and fades the trail while the pointer stays inside", () => {
    const lit = new Map<string, number>();
    stepLitCells(lit, "0:0", 0.25);
    stepLitCells(lit, "1:0", 0.25);
    expect(lit.get("1:0")).toBe(1);
    expect(lit.get("0:0")).toBe(0.75);
    for (let i = 0; i < 3; i++) stepLitCells(lit, "1:0", 0.25);
    expect(lit.has("0:0")).toBe(false);
    expect(lit.get("1:0")).toBe(1);
  });

  it("fades everything once the pointer is gone (also used when the grid is still)", () => {
    const lit = new Map([["2:3", 1]]);
    for (let i = 0; i < 4; i++) stepLitCells(lit, null, 0.25);
    expect(lit.size).toBe(0);
  });
});
