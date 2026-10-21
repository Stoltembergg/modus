// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
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
    const select = screen.getByRole("combobox", { name: "Default model" });
    expect(select.textContent).toBe("Flash");
    expect(select.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    await user.click(select);
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getByRole("group", { name: "Modus" })).toBeTruthy();
    expect(within(listbox).getByRole("group", { name: "OpenAI" })).toBeTruthy();
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Flash", "GPT X"]);
    await user.click(within(listbox).getByRole("option", { name: "GPT X" }));
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
    const select = screen.getByRole("combobox", { name: "Default model" });
    expect(select.textContent).toBe("Fable (unavailable)");
    expect(onSetDefaultModel).not.toHaveBeenCalled();
    await user.click(select);
    await user.click(screen.getByRole("option", { name: "Flash" }));
    expect(onSetDefaultModel).toHaveBeenCalledWith("modus/deepseek/deepseek-flash");
  });

  it("never hides a BYOK model, even if it carries a locked flag", async () => {
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
    const select = screen.getByRole("combobox", { name: "Default model" }) as HTMLButtonElement;
    expect(select.disabled).toBe(false);
    expect(select.textContent).toBe("Choose a model");
    const user = userEvent.setup();
    await user.click(select);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["GPT X"]);
  });
});
