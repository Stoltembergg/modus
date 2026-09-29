import { describe, expect, it } from "vitest";
import { memberLabels, memberLabelText } from "./memberLabels";

describe("memberLabels", () => {
  it("adds a short id suffix only to titles that repeat in the group", () => {
    const labels = memberLabels([
      { sessionId: "3f2a91c0-aaaa", title: "Reviewer" },
      { sessionId: "8b01d2e3-bbbb", title: "reviewer" },
      { sessionId: "c0ffee00-cccc", title: "Planner" },
    ]);
    expect(labels.get("3f2a91c0-aaaa")).toEqual({ title: "Reviewer", suffix: "3f2a" });
    expect(labels.get("8b01d2e3-bbbb")).toEqual({ title: "reviewer", suffix: "8b01" });
    expect(labels.get("c0ffee00-cccc")).toEqual({ title: "Planner" });
    expect(memberLabelText(labels.get("3f2a91c0-aaaa") ?? { title: "" })).toBe("Reviewer · 3f2a");
    expect(memberLabelText({ title: "Planner" })).toBe("Planner");
  });

  it("lengthens the suffix until the duplicates differ", () => {
    const labels = memberLabels([
      { sessionId: "abcd-1111", title: "Reviewer" },
      { sessionId: "abcd-2222", title: "Reviewer" },
    ]);
    expect([...labels.values()].map((label) => label.suffix)).toEqual(["abcd1", "abcd2"]);
  });
});
