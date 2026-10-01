import { describe, expect, it } from "vitest";
import { formatGroupProgressLabel, groupAgentProgressShimmerLabel } from "./group-progress-label";

describe("group-progress-label", () => {
  it("shows queued with age instead of opaque Working", () => {
    expect(
      formatGroupProgressLabel({
        phase: "Queued",
        presenceState: "queued",
        startedAt: 1_000,
        nowMs: 13_000,
        locale: "en",
      }),
    ).toBe("Queued · 12s");
    expect(
      formatGroupProgressLabel({
        phase: "Queued",
        presenceState: "queued",
        startedAt: 1_000,
        nowMs: 13_000,
        locale: "pt",
      }),
    ).toBe("Na fila · 12s");
  });

  it("maps idle model wait and running tests to concrete labels", () => {
    expect(
      formatGroupProgressLabel({
        phase: "Waiting on model",
        presenceState: "thinking",
        locale: "en",
      }),
    ).toBe("Waiting on model…");
    expect(
      formatGroupProgressLabel({
        phase: "Working",
        presenceState: "running_tool",
        activity: "Running tests",
        locale: "en",
      }),
    ).toBe("Running tests…");
  });

  it("builds shimmer copy with agent name + phase", () => {
    expect(
      groupAgentProgressShimmerLabel({
        names: ["Builder"],
        phaseLabel: "Waiting on model…",
        locale: "en",
      }),
    ).toBe("Builder · Waiting on model…");
    expect(
      groupAgentProgressShimmerLabel({
        names: ["Planner", "Builder"],
        phaseLabel: "Queued · 8s",
        locale: "pt",
      }),
    ).toBe("Planner e Builder · Queued · 8s");
  });
});
