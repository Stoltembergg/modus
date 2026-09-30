import { describe, expect, it } from "vitest";
import { type MemberRef, selectAutonomousWakeTargets } from "./group-runtime-lib";

const members: MemberRef[] = [
  { sessionId: "lead", title: "Alpha", role: "Lead", description: "Coordinates the room" },
  { sessionId: "builder", title: "Beta", role: "Builder", description: "Implements code changes" },
  { sessionId: "reviewer", title: "Gamma", role: "Reviewer", description: "Reviews pull requests" },
];

describe("selectAutonomousWakeTargets", () => {
  it("falls back to the lead when the message has no specialty cues", () => {
    expect(
      selectAutonomousWakeTargets({
        body: "hello team",
        members,
        leadSessionId: "lead",
      }),
    ).toEqual(["lead"]);
  });

  it("wakes a specialty match without requiring a Lead", () => {
    expect(
      selectAutonomousWakeTargets({
        body: "please review the auth PR",
        members,
      }),
    ).toEqual(["reviewer"]);
  });

  it("wakes the builder for implement/fix language", () => {
    expect(
      selectAutonomousWakeTargets({
        body: "implement the toggle fix",
        members,
        leadSessionId: "lead",
      }),
    ).toEqual(["builder"]);
  });

  it("prefers an open-task owner when titles align", () => {
    expect(
      selectAutonomousWakeTargets({
        body: "continue the toggle work",
        members,
        leadSessionId: "lead",
        openTasks: [{ status: "in_progress", title: "toggle work", ownerSessionId: "builder" }],
      }),
    ).toEqual(["builder"]);
  });

  it("never returns empty when members exist and lead is absent", () => {
    expect(
      selectAutonomousWakeTargets({
        body: "hi",
        members: [
          { sessionId: "a", title: "One" },
          { sessionId: "b", title: "Two" },
        ],
      }),
    ).toEqual(["a"]);
  });

  it("skips archived members", () => {
    expect(
      selectAutonomousWakeTargets({
        body: "review please",
        members: [
          { sessionId: "reviewer", title: "Gamma", role: "Reviewer", archived: true },
          { sessionId: "lead", title: "Alpha", role: "Lead" },
        ],
        leadSessionId: "lead",
      }),
    ).toEqual(["lead"]);
  });
});
