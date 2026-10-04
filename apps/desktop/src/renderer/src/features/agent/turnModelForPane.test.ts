import { describe, expect, it } from "vitest";
import { turnModelForPane } from "./ChatPane";

const MODELS = [{ id: "openai/gpt-5" }, { id: "modus/zai/glm" }];

describe("L3b turnModelForPane mirrors main's turn model", () => {
  it("a Modus session shows the Modus turn model", () => {
    expect(
      turnModelForPane("openai/gpt-5", "modus/anthropic/claude-fable-5-1", MODELS, "modus/zai/glm"),
    ).toBe("modus/zai/glm");
  });

  it("an own-provider session keeps its stored model; gone → Settings default", () => {
    expect(turnModelForPane("modus/zai/glm", "openai/gpt-5", MODELS, "modus/zai/glm")).toBe(
      "openai/gpt-5",
    );
    expect(turnModelForPane("openai/gpt-5", "gone/model", MODELS, "modus/zai/glm")).toBe(
      "openai/gpt-5",
    );
  });

  it("no stored model: the Settings default, Modus rule when it is a Modus model", () => {
    expect(turnModelForPane("openai/gpt-5", undefined, MODELS, "modus/zai/glm")).toBe(
      "openai/gpt-5",
    );
    expect(turnModelForPane("modus/x/y", undefined, MODELS, "modus/zai/glm")).toBe("modus/zai/glm");
  });
});
