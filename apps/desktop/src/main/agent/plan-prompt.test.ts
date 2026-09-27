import { describe, expect, it } from "vitest";
import { planModePreamble, profileForMode } from "./plan-prompt";

describe("Spec Mode planning prompt", () => {
  it("uses the read-only plan profile and asks for pending structured criteria", () => {
    expect(profileForMode("spec")).toBe("plan");
    const preamble = planModePreamble("spec");
    expect(preamble).toContain("SPEC MODE");
    expect(preamble).toContain("stable requirement IDs");
    expect(preamble).toContain("acceptance criteria");
    expect(preamble).toContain("pending");
    expect(preamble).toContain("evidence");
    expect(preamble).toContain("assumptions");
    expect(planModePreamble("build")).toBe("");
  });
});
