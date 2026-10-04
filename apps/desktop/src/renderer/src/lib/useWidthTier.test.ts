import { describe, expect, it } from "vitest";
import { widthTier } from "./useWidthTier";

describe("widthTier (L3c)", () => {
  const bp = { md: 380, lg: 520 };
  it("maps a bar width to sm / md / lg", () => {
    expect(widthTier(300, bp)).toBe("sm");
    expect(widthTier(379.5, bp)).toBe("sm");
    expect(widthTier(380, bp)).toBe("md");
    expect(widthTier(519, bp)).toBe("md");
    expect(widthTier(520, bp)).toBe("lg");
    expect(widthTier(1400, bp)).toBe("lg");
  });
  it("an unmeasured bar keeps the full layout", () => {
    expect(widthTier(0, bp)).toBe("lg");
    expect(widthTier(Number.NaN, bp)).toBe("lg");
  });
});
