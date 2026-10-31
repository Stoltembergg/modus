import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../../shared/contracts";
import { lookupModel, modelIdentityLabel } from "./modelIdentity";

function model(partial: Partial<ModelInfo> & Pick<ModelInfo, "id" | "name">): ModelInfo {
  return {
    provider: "openai",
    available: true,
    enabled: true,
    configured: true,
    source: "builtin",
    supportsThinking: false,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    ...partial,
  };
}

describe("lookupModel", () => {
  it("resolves by catalog id and ignores unknowns", () => {
    const catalog = [model({ id: "openai/gpt-5.6-terra", name: "GPT 5.6 Terra" })];
    expect(lookupModel(catalog, "openai/gpt-5.6-terra")?.name).toBe("GPT 5.6 Terra");
    expect(lookupModel(catalog, "missing/model")).toBeUndefined();
    expect(lookupModel(undefined, "openai/gpt-5.6-terra")).toBeUndefined();
  });

  it("returns undefined when given an empty catalog", () => {
    expect(lookupModel([], "openai/gpt-5.6-terra")).toBeUndefined();
  });

  it("returns undefined when given an empty or undefined model id", () => {
    const catalog = [model({ id: "openai/gpt-5.6-terra", name: "GPT 5.6 Terra" })];
    expect(lookupModel(catalog, undefined)).toBeUndefined();
    expect(lookupModel(catalog, "")).toBeUndefined();
  });
});

describe("modelIdentityLabel", () => {
  it("uses the catalog display name without inventing casing from the id", () => {
    expect(modelIdentityLabel(model({ id: "openai/gpt-5.6-terra", name: "GPT 5.6 Terra" }))).toBe(
      "GPT 5.6 Terra",
    );
  });

  it("appends the provider-facing thinking label when thinking is on", () => {
    expect(
      modelIdentityLabel(
        model({
          id: "openai/gpt-5.6-terra",
          name: "GPT 5.6 Terra",
          supportsThinking: true,
          thinkingLevel: "high",
          thinkingLevels: ["off", "high"],
          thinkingVariant: "high",
          thinkingOptions: [
            { value: "off", label: "Off", level: "off" },
            { value: "high", label: "High", level: "high" },
          ],
        }),
      ),
    ).toBe("GPT 5.6 Terra High");
  });

  it("omits Off so the label stays a product name", () => {
    expect(
      modelIdentityLabel(
        model({
          id: "openai/gpt-5.6-terra",
          name: "GPT 5.6 Terra",
          supportsThinking: true,
          thinkingLevel: "off",
          thinkingVariant: "off",
          thinkingOptions: [{ value: "off", label: "Off", level: "off" }],
        }),
      ),
    ).toBe("GPT 5.6 Terra");
  });

  it("appends budget tokens as thinking label when the model uses thinking budget", () => {
    expect(
      modelIdentityLabel(
        model({
          id: "anthropic/claude-3.7-sonnet",
          name: "Claude 3.7 Sonnet",
          supportsThinking: true,
          thinkingLevel: "high",
          thinkingVariant: "1024",
          thinkingBudget: { min: 1024, max: 2048 },
        }),
      ),
    ).toBe("Claude 3.7 Sonnet 1,024 tokens");
  });

  it("ignores empty thinking labels", () => {
    expect(
      modelIdentityLabel(
        model({
          id: "test/model",
          name: "Test Model",
          supportsThinking: true,
          thinkingLevel: "xhigh",
          thinkingVariant: "xhigh",
          thinkingOptions: [{ value: "xhigh", label: "", level: "xhigh" }],
        }),
      ),
    ).toBe("Test Model");
  });
});
