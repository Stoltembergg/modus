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
    unlockPack: { id: "credits_25k", credits: 25000 },
  }),
  model({ id: "openai/gpt-x", name: "GPT X", provider: "openai", providerName: "OpenAI" }),
];

describe("L3b0 Settings default model picker", () => {
  it("lists models by provider, hides a locked Modus model, and selects on change", async () => {
    const user = userEvent.setup();
    const onSetDefaultModel = vi.fn();
    render(
      <DefaultModelSetting
        defaultModel="modus/deepseek/deepseek-flash"
        models={MODELS}
        onSetDefaultModel={onSetDefaultModel}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Default model" }) as HTMLSelectElement;
    expect(
      [...select.querySelectorAll("optgroup")].map((group) => [group.label, group.textContent]),
    ).toEqual([
      ["Modus", "Flash"],
      ["OpenAI", "GPT X"],
    ]);
    expect(select.querySelector('option[value="modus/anthropic/claude-fable-5-1"]')).toBeNull();
    expect(select.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    await user.selectOptions(select, "openai/gpt-x");
    expect(onSetDefaultModel).toHaveBeenCalledWith("openai/gpt-x");
  });

  it("keeps a saved default that is now locked as '(unavailable)' without changing it", async () => {
    const user = userEvent.setup();
    const onSetDefaultModel = vi.fn();
    render(
      <DefaultModelSetting
        defaultModel="modus/anthropic/claude-fable-5-1"
        models={MODELS}
        onSetDefaultModel={onSetDefaultModel}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Default model" }) as HTMLSelectElement;
    expect(select.value).toBe("modus/anthropic/claude-fable-5-1");
    expect(select.selectedOptions[0]?.textContent).toBe("Fable (unavailable)");
    expect(select.selectedOptions[0]?.parentElement).toBe(select);
    expect(onSetDefaultModel).not.toHaveBeenCalled();
    await user.selectOptions(select, "modus/deepseek/deepseek-flash");
    expect(onSetDefaultModel).toHaveBeenCalledWith("modus/deepseek/deepseek-flash");
  });

  it("never hides a BYOK model, even if it carries a locked flag", () => {
    render(
      <DefaultModelSetting
        defaultModel={undefined}
        models={[
          model({
            id: "openai/gpt-x",
            name: "GPT X",
            provider: "openai",
            providerName: "OpenAI",
            locked: "upgrade",
          }),
        ]}
        onSetDefaultModel={vi.fn()}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Default model" }) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Choose a model",
      "GPT X",
    ]);
  });
});
