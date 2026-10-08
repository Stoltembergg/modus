import { describe, expect, it } from "vitest";
import { projectMemoryHints } from "./runtime-memory-helper";
import {
  PLAN_CHECK_LABELS,
  requestsCheck,
  requiredChecksForRun,
  todoContinuationMessage,
} from "./runtime-qa-helper";
import {
  composeSubagentPrompt,
  escapeContextText,
  isSubagentBusy,
  MAX_SUBAGENTS_PER_SESSION,
} from "./runtime-subagent-helper";

describe("runtime-qa-helper", () => {
  it("detects affirmative check requests", () => {
    expect(requestsCheck("please run tests now", /\b(?:tests?|vitest|jest)\b/i)).toBe(true);
    expect(requestsCheck("run typecheck and verify", /\btype[ -]?check\b/i)).toBe(true);
  });

  it("respects negated clauses", () => {
    expect(requestsCheck("don't run tests", /\b(?:tests?|vitest|jest)\b/i)).toBe(false);
    expect(requestsCheck("run tests, but do not run typecheck", /\btype[ -]?check\b/i)).toBe(false);
    expect(requestsCheck("run tests, but do not run typecheck", /\b(?:tests?|vitest|jest)\b/i)).toBe(true);
  });

  it("derives required checks for run correctly", () => {
    const checks = requiredChecksForRun({
      message: "run tests and lint",
      sessionId: "s-1",
      context: [],
      delivery: "normal",
      mode: "build",
    });
    expect(checks).toContain("tests");
    expect(checks).toContain("lint");
    expect(checks).not.toContain("typecheck");
  });

  it("formats todo continuation messages with and without QA", () => {
    const withQA = todoContinuationMessage(["npm run test"], true);
    expect(withQA).toContain("Eligible existing project check scripts: npm run test");

    const withoutQA = todoContinuationMessage([], false);
    expect(withoutQA).toContain("This is the single bounded continuation");
    expect(withoutQA).not.toContain("Eligible existing project check scripts");
  });

  it("maps plan check labels accurately", () => {
    expect(PLAN_CHECK_LABELS.tests).toBe("Tests");
    expect(PLAN_CHECK_LABELS.typecheck).toBe("Typecheck");
    expect(PLAN_CHECK_LABELS.lint).toBe("Lint");
    expect(PLAN_CHECK_LABELS.build).toBe("Build");
  });
});

describe("runtime-subagent-helper", () => {
  it("determines subagent busy status correctly", () => {
    expect(isSubagentBusy("starting")).toBe(true);
    expect(isSubagentBusy("running")).toBe(true);
    expect(isSubagentBusy("blocked")).toBe(true);
    expect(isSubagentBusy("idle")).toBe(false);
    expect(isSubagentBusy("completed")).toBe(false);
    expect(isSubagentBusy("error")).toBe(false);
    expect(isSubagentBusy("cancelled")).toBe(false);
  });

  it("composes subagent prompt with definition wrapping", () => {
    const prompt = composeSubagentPrompt({
      prompt: "Research the bug",
      subagent: {
        name: "researcher",
        body: "You are a code researcher.",
      },
    });
    expect(prompt).toContain('<subagent_definition name="researcher">');
    expect(prompt).toContain("You are a code researcher.");
    expect(prompt).toContain("<task>\nResearch the bug\n</task>");
  });

  it("returns raw prompt if subagent has no body", () => {
    const prompt = composeSubagentPrompt({
      prompt: "Direct task",
    });
    expect(prompt).toBe("Direct task");
  });

  it("escapes context text properly", () => {
    expect(escapeContextText("<test & 'quote'>")).toBe("&lt;test &amp; 'quote'&gt;");
  });

  it("defines MAX_SUBAGENTS_PER_SESSION as 6", () => {
    expect(MAX_SUBAGENTS_PER_SESSION).toBe(6);
  });
});

describe("runtime-memory-helper", () => {
  it("extracts paths and symbols from context items", () => {
    const hints = projectMemoryHints(
      [
        { type: "file", path: "src/main.ts" },
        {
          type: "design-element",
          element: {
            id: "de-1",
            tabId: "t-1",
            url: "http://localhost:3000",
            componentName: "AppHeader",
            source: { file: "src/header.tsx", line: 1 },
            label: "Header",
            tagName: "header",
            domPath: "div.container > header",
            rect: { x: 0, y: 0, width: 100, height: 50 },
          },
        },
      ],
      process.cwd(),
    );
    expect(hints.symbols).toContain("AppHeader");
  });
});
