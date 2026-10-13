import { describe, expect, it } from "vitest";
import { visibleSubagentPrompt } from "./subagentPrompt";

describe("visibleSubagentPrompt", () => {
  it("drops the internal definition and keeps only the task", () => {
    const text = [
      '<subagent_definition name="explore">',
      "Explore only. Do not modify files.",
      "</subagent_definition>",
      "",
      "<task>",
      "Research F1 plan specifics",
      "</task>",
    ].join("\n");
    expect(visibleSubagentPrompt(text)).toBe("Research F1 plan specifics");
  });

  it("hides a definition that has no task yet (still streaming)", () => {
    expect(visibleSubagentPrompt('<subagent_definition name="explore">\nExplore only.')).toBe("");
    expect(
      visibleSubagentPrompt(
        '<subagent_definition name="x">\nbody\n</subagent_definition>\n\n<task>\nDo it',
      ),
    ).toBe("Do it");
  });

  it("leaves ordinary messages untouched", () => {
    expect(visibleSubagentPrompt("hello <task>x</task>")).toBe("hello <task>x</task>");
    expect(visibleSubagentPrompt("plain")).toBe("plain");
  });
});
