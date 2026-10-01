import { describe, expect, it } from "vitest";
import { groupWorkingShimmerNames, shouldShowGroupWorkingShimmer } from "./workingShimmer";

describe("workingShimmer", () => {
  const labels = new Map([
    ["s-lead", { title: "Planner" }],
    ["s-build", { title: "Builder" }],
  ]);

  it("hides when idle", () => {
    expect(shouldShowGroupWorkingShimmer([])).toBe(false);
  });

  it("shows when an agent is running/queued without streamed text", () => {
    expect(
      shouldShowGroupWorkingShimmer([
        {
          sessionId: "s-build",
          mode: "running",
          live: { streamText: "", collapsed: false },
        },
      ]),
    ).toBe(true);
    expect(
      groupWorkingShimmerNames(
        [
          {
            sessionId: "s-build",
            mode: "running",
            live: { streamText: "", collapsed: false },
          },
        ],
        labels,
      ),
    ).toEqual(["Builder"]);
  });

  it("clears when streamed writing makes progress obvious", () => {
    expect(
      shouldShowGroupWorkingShimmer([
        {
          sessionId: "s-build",
          mode: "running",
          live: { streamText: "Patching resolveWithin…", collapsed: false },
        },
      ]),
    ).toBe(false);
  });

  it("prefers running names over queued when both need an indicator", () => {
    expect(
      groupWorkingShimmerNames(
        [
          {
            sessionId: "s-lead",
            mode: "queued",
            live: { streamText: "", collapsed: false },
          },
          {
            sessionId: "s-build",
            mode: "running",
            live: { streamText: "", collapsed: false },
          },
        ],
        labels,
      ),
    ).toEqual(["Builder"]);
  });

  it("never sticky-shows collapsed done rows", () => {
    expect(
      shouldShowGroupWorkingShimmer([
        {
          sessionId: "s-build",
          mode: "running",
          live: { streamText: "", collapsed: true },
        },
      ]),
    ).toBe(false);
  });
});
