import { describe, expect, it } from "vitest";
import { turnModelForPane } from "./ChatPane";

describe("turnModelForPane preserves explicit session selection", () => {
  it("keeps the exact model stored by a Modus session", () => {
    expect(turnModelForPane("openai/gpt-5", "modus/anthropic/claude-fable-5-1")).toBe(
      "modus/anthropic/claude-fable-5-1",
    );
  });

  it("keeps a BYOK model even after it disappears from the available model catalog", () => {
    expect(turnModelForPane("modus/zai/glm", "openai/gpt-5")).toBe("openai/gpt-5");
    expect(turnModelForPane("openai/gpt-5", "gone/model")).toBe("gone/model");
  });

  it("uses the Settings default only when there is no session model", () => {
    expect(turnModelForPane("openai/gpt-5", undefined)).toBe("openai/gpt-5");
    expect(turnModelForPane("modus/x/y", undefined)).toBe("modus/x/y");
  });
});
