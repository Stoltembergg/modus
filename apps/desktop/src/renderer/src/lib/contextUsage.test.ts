import { describe, expect, it } from "vitest";
import { clampPercent, contextUsagePercent, formatUsagePercent } from "./contextUsage";

describe("clampPercent", () => {
  it("returns 0 for non-numbers, NaN, and Infinity", () => {
    expect(clampPercent(null)).toBe(0);
    expect(clampPercent(undefined)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampPercent(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("clamps values below 0 to 0", () => {
    expect(clampPercent(-10)).toBe(0);
    expect(clampPercent(-0.1)).toBe(0);
  });

  it("clamps values above 100 to 100", () => {
    expect(clampPercent(101)).toBe(100);
    expect(clampPercent(1000)).toBe(100);
  });

  it("returns values between 0 and 100 unchanged", () => {
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(50)).toBe(50);
    expect(clampPercent(100)).toBe(100);
    expect(clampPercent(33.3)).toBe(33.3);
  });
});

describe("contextUsagePercent", () => {
  it("returns undefined for undefined input", () => {
    expect(contextUsagePercent(undefined)).toBeUndefined();
  });

  it("uses provided percent directly if valid", () => {
    expect(contextUsagePercent({ percent: 50, tokens: 10, contextWindow: 100 })).toBe(50);
    expect(contextUsagePercent({ percent: -10, tokens: 10, contextWindow: 100 })).toBe(0);
    expect(contextUsagePercent({ percent: 110, tokens: 10, contextWindow: 100 })).toBe(100);
  });

  it("falls back to tokens/window calculation if percent is missing or invalid", () => {
    expect(
      contextUsagePercent({
        percent: undefined as unknown as number,
        tokens: 50,
        contextWindow: 100,
      }),
    ).toBe(50);
    expect(contextUsagePercent({ percent: Number.NaN, tokens: 25, contextWindow: 100 })).toBe(25);
  });

  it("clamps the calculated percentage", () => {
    expect(
      contextUsagePercent({
        percent: undefined as unknown as number,
        tokens: 150,
        contextWindow: 100,
      }),
    ).toBe(100);
    expect(
      contextUsagePercent({
        percent: undefined as unknown as number,
        tokens: -10,
        contextWindow: 100,
      }),
    ).toBe(0);
  });

  it("returns undefined if percent is invalid and window is <= 0", () => {
    expect(
      contextUsagePercent({
        percent: undefined as unknown as number,
        tokens: 50,
        contextWindow: 0,
      }),
    ).toBeUndefined();
    expect(
      contextUsagePercent({
        percent: undefined as unknown as number,
        tokens: 50,
        contextWindow: -10,
      }),
    ).toBeUndefined();
  });

  it("returns undefined if both percent and tokens are invalid", () => {
    expect(
      contextUsagePercent({
        percent: undefined as unknown as number,
        tokens: undefined as unknown as number,
        contextWindow: 100,
      }),
    ).toBeUndefined();
  });
});

describe("formatUsagePercent", () => {
  it("formats valid numbers with % and rounding", () => {
    expect(formatUsagePercent(0)).toBe("0%");
    expect(formatUsagePercent(50)).toBe("50%");
    expect(formatUsagePercent(100)).toBe("100%");
    expect(formatUsagePercent(33.3)).toBe("33%");
    expect(formatUsagePercent(33.6)).toBe("34%");
  });

  it("returns '—' for non-finite or missing values", () => {
    expect(formatUsagePercent(null)).toBe("—");
    expect(formatUsagePercent(undefined)).toBe("—");
    expect(formatUsagePercent(Number.NaN)).toBe("—");
    expect(formatUsagePercent(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatUsagePercent(Number.NEGATIVE_INFINITY)).toBe("—");
  });
});
