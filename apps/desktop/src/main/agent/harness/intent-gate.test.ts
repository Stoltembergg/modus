import { describe, expect, it } from "vitest";
import { evaluateIntentGate } from "./intent-gate";

const input = (text: string, contextPaths: string[] = []) => ({
  text,
  mode: "build" as const,
  contextPaths,
  changedPaths: [],
});

describe("evaluateIntentGate", () => {
  it("proceeds for a clear low-consequence request", () => {
    expect(evaluateIntentGate(input("Fix the typo in the button label"))).toEqual({
      action: "proceed",
    });
  });

  it("suggests planning for complex scoped work", () => {
    expect(
      evaluateIntentGate(
        input("Implement the cross-cutting feature", [
          "src/main/a.ts",
          "src/main/b.ts",
          "src/renderer/c.tsx",
          "src/shared/d.ts",
        ]),
      ),
    ).toMatchObject({ action: "suggest_plan", classification: { complexity: "complex" } });
  });

  it("asks a generic clarifying question for material ambiguity without embedding intent text", () => {
    const result = evaluateIntentGate(input("Which deployment option should I choose?"));
    expect(result).toMatchObject({
      action: "clarify",
      default: "Use a conservative default and proceed.",
      question: { header: expect.stringContaining("requirement or target"), multiSelect: false },
    });
    expect(JSON.stringify(result)).not.toContain("Which deployment option");
  });

  it("confirms consequential destructive requests with a generic question", () => {
    const result = evaluateIntentGate(input("Delete the production database"));
    expect(result).toMatchObject({
      action: "confirm",
      question: { header: "Confirm consequential action", multiSelect: false },
    });
    expect(JSON.stringify(result)).not.toContain("production database");
  });

  it("does not confirm read-only security review or Plan Mode migration discussion", () => {
    expect(evaluateIntentGate(input("Review the security of the authentication changes"))).toEqual({
      action: "proceed",
    });
    expect(
      evaluateIntentGate({ ...input("Discuss the database migration plan"), mode: "plan" }),
    ).not.toMatchObject({ action: "confirm" });
  });

  it("confirms explicit destructive Build effects and destructive flags, but not Plan Mode flags", () => {
    expect(evaluateIntentGate(input("Delete production data"))).toMatchObject({
      action: "confirm",
    });
    expect(evaluateIntentGate(input("Please delete production data"))).toMatchObject({
      action: "confirm",
    });
    expect(evaluateIntentGate(input("I want you to delete production data"))).toMatchObject({
      action: "confirm",
    });
    expect(
      evaluateIntentGate({ ...input("Apply the requested operation"), hasDestructiveAction: true }),
    ).toMatchObject({ action: "confirm" });
    expect(
      evaluateIntentGate({
        ...input("Discuss the migration"),
        mode: "plan",
        hasDestructiveAction: true,
      }),
    ).not.toMatchObject({ action: "confirm" });
  });

  it("detects direct destructive clauses anywhere without confirming discussion or routine edits", () => {
    expect(
      evaluateIntentGate(input("Back up the database, then delete production data")),
    ).toMatchObject({ action: "confirm" });
    expect(evaluateIntentGate(input("Explain whether we should delete production data"))).toEqual({
      action: "proceed",
    });
    expect(evaluateIntentGate(input("Review the security implications of deleting data"))).toEqual({
      action: "proceed",
    });
    expect(evaluateIntentGate(input("Remove the unused import"))).toEqual({ action: "proceed" });
  });

  it("confirms deleting a personal account or dropping a named table", () => {
    expect(evaluateIntentGate(input("Delete my account"))).toMatchObject({ action: "confirm" });
    expect(evaluateIntentGate(input("Drop the orders table"))).toMatchObject({ action: "confirm" });
  });

  it("asks for the missing decision and keeps free-text input out of the gate artifact", () => {
    const result = evaluateIntentGate(input("Which deployment option should I choose?"));
    expect(result).toMatchObject({
      action: "clarify",
      question: { header: expect.stringContaining("requirement or target") },
    });
    expect(JSON.stringify(result)).not.toContain("Which deployment option");
  });
});
