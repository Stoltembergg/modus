import { describe, expect, it, vi } from "vitest";
import { selectAutonomousWakeTargets } from "./group-runtime-lib";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/task10-unused" } }));
const members = [
  { sessionId: "lead", title: "Alpha", role: "Lead" },
  { sessionId: "builder", title: "Beta", role: "Builder" },
  { sessionId: "reviewer", title: "Gamma", role: "Reviewer" },
];
describe("untyped intake", () => {
  it("keeps all PT and EN text at the Lead until a typed task exists", () => {
    for (const body of [
      "hello",
      "please review auth PR",
      "implement code fix",
      "implemente a correção".repeat(100),
    ]) {
      expect(selectAutonomousWakeTargets({ body, members, leadSessionId: "lead" })).toEqual([
        "lead",
      ]);
    }
  });
  it("needs user input when the group has no configured Lead", () => {
    expect(selectAutonomousWakeTargets({ body: "review code", members })).toEqual([]);
  });
  it("uses active members when a configured Lead is archived", () => {
    expect(
      selectAutonomousWakeTargets({
        body: "review code",
        members: [
          { sessionId: "lead", title: "Alpha", role: "Lead", archived: true },
          { sessionId: "builder", title: "Beta", role: "Builder" },
          { sessionId: "reviewer", title: "Gamma", role: "Reviewer" },
        ],
        leadSessionId: "lead",
      }),
    ).toEqual(["builder", "reviewer"]);
    expect(
      selectAutonomousWakeTargets({
        body: "hi",
        members: [{ sessionId: "lead", title: "Alpha", role: "Lead", archived: true }],
        leadSessionId: "lead",
      }),
    ).toEqual([]);
  });
});
