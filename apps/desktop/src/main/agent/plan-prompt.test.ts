import { describe, expect, it } from "vitest";
import { planModePreamble, profileForMode } from "./plan-prompt";

describe("Plan Mode planning prompt", () => {
  it("uses the read-only plan profile and asks for pending structured criteria", () => {
    expect(profileForMode("plan")).toBe("plan");
    const preamble = planModePreamble("plan");
    expect(preamble).toContain("PLAN MODE");
    expect(preamble).toContain("stable requirement IDs");
    expect(preamble).toContain("acceptance criteria");
    expect(preamble).toContain("pending");
    expect(preamble).toContain("evidence");
    expect(preamble).toContain("assumptions");
    expect(preamble).toContain("dependencies");
    expect(preamble).toContain("rollback");
    expect(planModePreamble("build")).toBe("");
  });
});
