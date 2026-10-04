import { describe, expect, it } from "vitest";
import { normalizeGroupMemberCapabilities } from "./group-capabilities";

describe("group capabilities", () => {
  it("legacy_missing_capabilities_stay_empty", () => {
    expect(normalizeGroupMemberCapabilities({})).toEqual({
      capabilityIds: [],
      supportedTaskKinds: [],
    });
  });
  it("deduplicates and orders explicit metadata deterministically", () => {
    expect(
      normalizeGroupMemberCapabilities({
        capabilityIds: ["review", "plan", "review"],
        supportedTaskKinds: ["docs", "code", "docs"],
      }),
    ).toEqual({ capabilityIds: ["plan", "review"], supportedTaskKinds: ["code", "docs"] });
  });
  it("rejects unknown IDs, task kinds and tool permissions", () => {
    for (const capabilityIds of [["shell"], ["Reviewer"], [" implement "], ["unknown"]]) {
      expect(() =>
        normalizeGroupMemberCapabilities({ capabilityIds, supportedTaskKinds: [] }),
      ).toThrow();
    }
    expect(() =>
      normalizeGroupMemberCapabilities({
        capabilityIds: [],
        supportedTaskKinds: ["shell" as "code"],
      }),
    ).toThrow();
  });
});
