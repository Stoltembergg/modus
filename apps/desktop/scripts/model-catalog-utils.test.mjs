import { describe, expect, it } from "vitest";
import { omitEmptyProviders } from "../../../scripts/model-catalog-utils.mjs";

describe("model catalog generation", () => {
  it("omits providers that have no built-in models", () => {
    const providers = {
      anthropic: [{ id: "claude-example" }],
      typesafe: [],
      openai: [{ id: "gpt-example" }],
    };

    expect(omitEmptyProviders(providers)).toEqual({
      anthropic: providers.anthropic,
      openai: providers.openai,
    });
  });
});
