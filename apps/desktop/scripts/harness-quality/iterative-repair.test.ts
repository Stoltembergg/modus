import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODE_REPAIR_FIXTURE } from "./code-repair";
import {
  ITERATIVE_REPAIR_FIXTURE,
  iterativeRepairFeedback,
  verifyIterativeRepairCandidate,
} from "./iterative-repair";

const reference = readFileSync(new URL("./code-repair/reference.ts.txt", import.meta.url), "utf8");
const original = CODE_REPAIR_FIXTURE.files["command-line.ts"] ?? "";

describe("iterative repair evaluation", () => {
  it("reuses the independent behavioral verifier and exposes only fixed failed-check IDs", () => {
    const checks = verifyIterativeRepairCandidate(original);
    const feedback = iterativeRepairFeedback(original);

    expect(checks.some(({ passed }) => !passed)).toBe(true);
    expect(feedback.passed).toBe(false);
    expect(feedback.failedCheckIds).toContain("round-trip-double-quote");
    expect(Object.keys(feedback).sort()).toEqual(["failedCheckIds", "passed"]);
    expect(JSON.stringify(feedback)).not.toContain("expected");
    expect(iterativeRepairFeedback(reference)).toEqual({ passed: true, failedCheckIds: [] });
  });

  it("keeps the extension corpus separate and limits edits to the real source file", () => {
    expect(ITERATIVE_REPAIR_FIXTURE.id).toBe("repair-command-line-iterative-pt");
    expect(ITERATIVE_REPAIR_FIXTURE.writable).toEqual(["command-line.ts"]);
    expect(ITERATIVE_REPAIR_FIXTURE.files["command-line.ts"]).toBe(original);
    expect(ITERATIVE_REPAIR_FIXTURE.prompt).toContain("fixture_verify_repair");
  });
});
