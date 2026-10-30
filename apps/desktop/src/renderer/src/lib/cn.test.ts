import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("combines multiple standard string class names", () => {
    expect(cn("class1", "class2", "class3")).toBe("class1 class2 class3");
  });

  it("handles falsy values by ignoring them", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(cn("class1", false, "class2", null, "class3", undefined, "", 0 as any)).toBe(
      "class1 class2 class3",
    );
  });

  it("handles when only falsy values are provided", () => {
    expect(cn(false, null, undefined, "")).toBe("");
  });

  it("handles when no arguments are provided", () => {
    expect(cn()).toBe("");
  });

  it("handles conditional classnames", () => {
    const isTrue = true;
    const isFalse = false;
    expect(cn("base-class", isTrue && "active-class", isFalse && "inactive-class")).toBe(
      "base-class active-class",
    );
  });
});
