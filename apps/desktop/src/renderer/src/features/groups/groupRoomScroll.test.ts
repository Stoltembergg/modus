import { describe, expect, it } from "vitest";
import { isNearBottom } from "../../../../shared/group-room-transcript";

describe("group room scroll-follow gating", () => {
  it("follows only when near the bottom", () => {
    expect(isNearBottom(1000, 960, 40)).toBe(true);
    expect(isNearBottom(1000, 500, 40)).toBe(false);
  });
});
