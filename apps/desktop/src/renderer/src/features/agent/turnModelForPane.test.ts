import { describe, expect, it } from "vitest";
import { turnModelForPane } from "./ChatPane";

const MODELS = [{ id: "openai/gpt-5" }, { id: "modus/zai/glm" }];

describe("turnModelForPane preserves explicit session selection", () => {
  it("keeps the exact model stored by a Modus session", () => {
    expect(
      turnModelForPane("openai/gpt-5", "modus/anthropic/claude-fable-5-1", MODELS, "modus/zai/glm"),
    ).toBe("modus/anthropic/claude-fable-5-1");
  });

  it("keeps a BYOK model even after it disappears from the available model catalog", () => {
    expect(turnModelForPane("modus/zai/glm", "openai/gpt-5", MODELS, "modus/zai/glm")).toBe(
      "openai/gpt-5",
    );
    expect(turnModelForPane("openai/gpt-5", "gone/model", MODELS, "modus/zai/glm")).toBe(
      "gone/model",
    );
  });

  it("uses the Settings default only when there is no session model", () => {
    expect(turnModelForPane("openai/gpt-5", undefined, MODELS, "modus/zai/glm")).toBe(
      "openai/gpt-5",
    );
    expect(turnModelForPane("modus/x/y", undefined, MODELS, "modus/zai/glm")).toBe("modus/x/y");
  });
});
