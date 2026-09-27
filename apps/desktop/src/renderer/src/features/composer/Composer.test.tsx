import { describe, expect, it } from "vitest";
import { cycleComposerMode } from "./Composer";

describe("cycleComposerMode", () => {
  it.each([
    ["build", "plan"],
    ["plan", "spec"],
    ["spec", "build"],
  ] as const)("cycles %s to %s", (mode, nextMode) => {
    expect(cycleComposerMode(mode)).toBe(nextMode);
  });
});
