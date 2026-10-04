import { describe, expect, it, vi } from "vitest";
import {
  isModusModelId,
  modelOptionLabel,
  openBuyCredits,
  pickModel,
  setBuyCreditsHandler,
  showsModusUnavailable,
} from "./modusModels";

const MODELS = [
  { id: "modus/deepseek/deepseek-flash", name: "Flash" },
  { id: "modus/anthropic/claude-fable-5-1", name: "Fable", locked: true },
  { id: "openai/gpt-x", name: "GPT X" },
];

describe("L3b0 Modus model helpers", () => {
  it("a locked model is never selected: it opens Buy credits instead", () => {
    const select = vi.fn();
    const onLocked = vi.fn();
    pickModel(MODELS, "modus/anthropic/claude-fable-5-1", select, onLocked);
    expect(select).not.toHaveBeenCalled();
    expect(onLocked).toHaveBeenCalledTimes(1);
    pickModel(MODELS, "openai/gpt-x", select, onLocked);
    expect(select).toHaveBeenCalledWith("openai/gpt-x");
    expect(onLocked).toHaveBeenCalledTimes(1);
  });

  it("the default locked action is the app's Buy credits handler", () => {
    const handler = vi.fn();
    setBuyCreditsHandler(handler);
    try {
      pickModel(MODELS, "modus/anthropic/claude-fable-5-1", vi.fn());
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      setBuyCreditsHandler(undefined);
    }
    expect(() => openBuyCredits()).not.toThrow();
  });

  it("labels locked models with a lock and the (generic) unlock text, per locale", () => {
    expect(modelOptionLabel(MODELS[0] as (typeof MODELS)[number])).toBe("Flash");
    expect(modelOptionLabel(MODELS[1] as (typeof MODELS)[number], "pt-BR")).toBe(
      "🔒 Fable · Requer um pacote de créditos que inclua este modelo",
    );
  });

  it("the unavailable notice is only for Modus sessions while the router is unavailable", () => {
    expect(isModusModelId("modus/deepseek/deepseek-flash")).toBe(true);
    expect(isModusModelId("openai/gpt-x")).toBe(false);
    expect(isModusModelId(undefined)).toBe(false);
    expect(showsModusUnavailable("unavailable", ["openai/gpt-x", "modus/zai/glm"])).toBe(true);
    expect(showsModusUnavailable("unavailable", ["openai/gpt-x", undefined])).toBe(false);
    expect(showsModusUnavailable("ready", ["modus/zai/glm"])).toBe(false);
    expect(showsModusUnavailable(undefined, ["modus/zai/glm"])).toBe(false);
  });
});
