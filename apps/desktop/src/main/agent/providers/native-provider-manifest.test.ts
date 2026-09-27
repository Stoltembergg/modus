import { describe, expect, it } from "vitest";
import { commandCodeExpectedMetadata } from "./commandcode-models.expected";
import { antigravityExpectedMetadata } from "./antigravity-models.expected";
import {
  COMMANDCODE_PR_HEAD,
  commandCodeModels,
  antigravityModels,
  mergeNativeProviderMetadata,
} from "./native-provider-manifest";

describe("native provider manifest", () => {
  it("pins all 55 Command Code IDs without normalizing case", () => {
    expect(COMMANDCODE_PR_HEAD).toBe("7846a5c1d65f7732d69c96a65df74df4d6f3d521");
    expect(commandCodeModels.map(({ id }) => id)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
      "gpt-5.3-codex",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "google/gemini-3.1-flash-lite",
      "google/gemini-3.5-flash",
      "google/gemini-3.5-flash-lite",
      "google/gemini-3.6-flash",
      "google/gemini-3.7-flash",
      "meta/muse-spark-1.1",
      "meta/muse-spark-1.2",
      "meta/muse-spark-1.2-contributor",
      "MiniMaxAI/MiniMax-M2.5",
      "MiniMaxAI/MiniMax-M2.7",
      "MiniMaxAI/MiniMax-M3",
      "moonshotai/Kimi-K2.5",
      "moonshotai/Kimi-K2.6",
      "moonshotai/Kimi-K2.7-Code",
      "moonshotai/Kimi-K2.7-Code-Highspeed",
      "moonshotai/Kimi-K3",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "poolside/laguna-s-2.1-free",
      "Qwen/Qwen3.6-Max-Preview",
      "Qwen/Qwen3.6-Plus",
      "Qwen/Qwen3.7-Flash",
      "Qwen/Qwen3.7-Max",
      "Qwen/Qwen3.7-Plus",
      "Qwen/Qwen3.8-Max",
      "sakana/fugu-ultra",
      "stepfun/Step-3.5-Flash",
      "stepfun/Step-3.7-Flash",
      "tencent/hy3-paid",
      "thinkingmachines/inkling",
      "thinkingmachines/inkling-small",
      "xai/grok-4.5",
      "xai/grok-4.6",
      "xiaomi/mimo-v2.5",
      "xiaomi/mimo-v2.5-pro",
      "zai-org/GLM-5",
      "zai-org/GLM-5.1",
      "zai-org/GLM-5.2",
      "zai-org/GLM-5.2-Fast",
      "zai-org/GLM-5.3",
    ]);
  });

  it("pins the 11 quota-specific Google model IDs", () => {
    expect(antigravityModels.map(({ id }) => id)).toEqual([
      "antigravity-gemini-3-pro",
      "antigravity-gemini-3.1-pro",
      "antigravity-gemini-3-flash",
      "antigravity-claude-sonnet-4-6",
      "antigravity-claude-opus-4-6-thinking",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
    ]);
    expect(antigravityModels.slice(0, 5).every((model) => model.quotaRoute === "antigravity")).toBe(
      true,
    );
    expect(antigravityModels.slice(5).every((model) => model.quotaRoute === "gemini-cli")).toBe(
      true,
    );
  });

  it("preserves pinned Antigravity names, limits, reasoning variants, and source modalities", () => {
    expect(
      antigravityModels.map(
        ({
          id,
          name,
          quotaRoute,
          contextWindow,
          maxOutputTokens,
          reasoningSupported,
          reasoningVariants,
          sourceModalities,
          input,
        }) => ({
          id,
          name,
          quotaRoute,
          contextWindow,
          maxOutputTokens,
          reasoningSupported,
          reasoningVariants,
          sourceModalities,
          input,
        }),
      ),
    ).toEqual(antigravityExpectedMetadata);
    expect(antigravityModels.every((model) => !("toolCallsSupported" in model))).toBe(true);
  });

  it("marks Command Code pricing unknown and rejects collisions", () => {
    expect(commandCodeModels.every((model) => model.pricingAvailability === "unknown")).toBe(true);
    expect(commandCodeModels.every((model) => !("cost" in model))).toBe(true);
    expect(() =>
      mergeNativeProviderMetadata(
        { providers: { commandcode: [{ id: "gpt-5.4" }] } },
        { providers: { commandcode: commandCodeModels } },
      ),
    ).toThrow(/collision/i);
  });

  it("preserves the pinned display, capability, tier, and limit metadata", () => {
    expect(
      commandCodeModels.map(
        ({
          id,
          name,
          tier,
          reasoningSupported,
          toolCallsSupported,
          contextWindow,
          maxOutputTokens,
        }) => ({
          id,
          name,
          tier,
          reasoningSupported,
          toolCallsSupported,
          contextWindow,
          maxOutputTokens,
        }),
      ),
    ).toEqual(commandCodeExpectedMetadata);
  });

  it("merges without mutating the catalog and rejects duplicate identities", () => {
    const base = { providers: { openai: [{ id: "gpt-4.1" }] } };
    const merged = mergeNativeProviderMetadata(base, {
      providers: { commandcode: commandCodeModels },
    });

    expect(merged.providers.commandcode).toEqual(commandCodeModels);
    expect(base.providers).not.toHaveProperty("commandcode");
    expect(() =>
      mergeNativeProviderMetadata(
        { providers: { commandcode: [{ id: "gpt-5.4" }] } },
        { providers: { commandcode: commandCodeModels } },
      ),
    ).toThrow(/collision/i);
  });
});
