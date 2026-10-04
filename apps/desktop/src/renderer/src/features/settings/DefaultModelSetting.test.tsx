// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../../../../shared/contracts";
import { DefaultModelSetting } from "./DefaultModelSetting";

afterEach(() => cleanup());

function model(
  partial: Partial<ModelInfo> & Pick<ModelInfo, "id" | "name" | "provider">,
): ModelInfo {
  return {
    available: true,
    enabled: true,
    configured: false,
    source: "builtin",
    supportsThinking: false,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    ...partial,
  };
}

const MODELS: ModelInfo[] = [
  model({
    id: "modus/deepseek/deepseek-flash",
    name: "Flash",
    provider: "modus",
    providerName: "Modus",
  }),
  model({
    id: "modus/anthropic/claude-fable-5-1",
    name: "Fable",
    provider: "modus",
    providerName: "Modus",
    locked: "upgrade",
  }),
  model({ id: "openai/gpt-x", name: "GPT X", provider: "openai", providerName: "OpenAI" }),
];

describe("L3b0 Settings default model picker", () => {
  it("lists models by provider; a locked Modus model has a lock and opens Buy credits, not selected", async () => {
    const user = userEvent.setup();
    const onSetDefaultModel = vi.fn();
    const onBuyCredits = vi.fn();
    render(
      <DefaultModelSetting
        defaultModel="modus/deepseek/deepseek-flash"
        models={MODELS}
        onBuyCredits={onBuyCredits}
        onSetDefaultModel={onSetDefaultModel}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Default model" }) as HTMLSelectElement;
    expect([...select.querySelectorAll("optgroup")].map((group) => group.label)).toEqual([
      "Modus",
      "OpenAI",
    ]);
    expect(select.querySelector("option[data-locked]")?.textContent).toBe(
      "🔒 Fable · Requires a credit pack that includes this model",
    );
    await user.selectOptions(select, "modus/anthropic/claude-fable-5-1");
    expect(onBuyCredits).toHaveBeenCalledTimes(1);
    expect(onSetDefaultModel).not.toHaveBeenCalled();
    expect(select.value).toBe("modus/deepseek/deepseek-flash");
    await user.selectOptions(select, "openai/gpt-x");
    expect(onSetDefaultModel).toHaveBeenCalledWith("openai/gpt-x");
    expect(onBuyCredits).toHaveBeenCalledTimes(1);
  });
});
