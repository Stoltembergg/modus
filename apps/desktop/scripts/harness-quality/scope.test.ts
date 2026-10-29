import { describe, expect, it } from "vitest";
import { FIXTURE_VERIFY_REPAIR_TOOL, fixtureToolDecision } from "./scope";

const input = {
  root: "/tmp/quality-fixture",
  files: ["command-line.ts"],
  writable: ["command-line.ts"],
  selectedModel: "provider/model",
  delegationAllowed: false,
  tasksStarted: 0,
  repairVerifierAllowed: true,
};

describe("iterative repair tool scope", () => {
  it("allows only the empty-argument verifier call for the designated fixture", () => {
    expect(
      fixtureToolDecision({ ...input, toolName: FIXTURE_VERIFY_REPAIR_TOOL, args: {} }),
    ).toBeUndefined();
  });

  it.each([
    ["unexpected fields", { path: "../../secret" }],
    ["null", null],
    ["array", []],
  ])("rejects verifier arguments containing %s", (_label, args) => {
    expect(
      fixtureToolDecision({ ...input, toolName: FIXTURE_VERIFY_REPAIR_TOOL, args }),
    ).toMatchObject({ block: true });
  });

  it("rejects verifier calls for other fixtures and keeps shell unavailable", () => {
    expect(
      fixtureToolDecision({
        ...input,
        repairVerifierAllowed: false,
        toolName: FIXTURE_VERIFY_REPAIR_TOOL,
        args: {},
      }),
    ).toMatchObject({ block: true });
    expect(fixtureToolDecision({ ...input, toolName: "bash", args: {} })).toMatchObject({
      block: true,
    });
  });
});
