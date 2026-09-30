import { describe, expect, it } from "vitest";
import {
  COLLAB_PIPELINE_APPROVAL,
  COLLAB_PIPELINE_NEXT,
  formatGroupKickoffDraft,
} from "./groupKickoff";

describe("formatGroupKickoffDraft", () => {
  it("formats outcome and first owner with a leading @", () => {
    expect(formatGroupKickoffDraft({ outcome: "  Add dark mode  ", firstOwner: "Planner" })).toBe(
      "Outcome: Add dark mode\nFirst owner: @Planner",
    );
  });

  it("strips a duplicate @ on the owner and includes next/approval when set", () => {
    expect(
      formatGroupKickoffDraft({
        outcome: "Ship toggle",
        firstOwner: "@Builder",
        nextSteps: COLLAB_PIPELINE_NEXT,
        approval: COLLAB_PIPELINE_APPROVAL,
      }),
    ).toBe(
      [
        "Outcome: Ship toggle",
        "First owner: @Builder",
        `Next: ${COLLAB_PIPELINE_NEXT}`,
        `Approval: ${COLLAB_PIPELINE_APPROVAL}`,
      ].join("\n"),
    );
  });
});
