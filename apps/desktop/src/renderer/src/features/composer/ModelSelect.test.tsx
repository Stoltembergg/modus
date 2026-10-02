// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../../../../shared/contracts";
import { ModelSelect } from "./Composer";
import { MODEL_CHIP_BASE } from "./modelChipStyle";

afterEach(() => {
  cleanup();
});

function model(partial: Partial<ModelInfo> & Pick<ModelInfo, "id" | "name">): ModelInfo {
  return {
    provider: "openai",
    providerName: "OpenAI",
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

const MODELS: ModelInfo[] = [
  model({
    id: "gpt-5",
    name: "GPT-5",
    supportsThinking: true,
    thinkingBudget: { min: 1024, max: 32000 },
    thinkingLevel: "medium",
    thinkingVariant: "4096",
  }),
  model({ id: "sonnet", name: "Claude Sonnet", provider: "anthropic", providerName: "Anthropic" }),
];

async function openMenu(label: string) {
  const trigger = screen.getByLabelText(label);
  await act(async () => {
    fireEvent.click(trigger);
  });
  return trigger;
}

describe("ModelSelect (1:1 composer, still interactive)", () => {
  it("uses the shared chip style for both triggers", () => {
    render(
      <ModelSelect
        model="gpt-5"
        models={MODELS}
        onModelChange={vi.fn()}
        onModelConfigChange={vi.fn()}
      />,
    );
    for (const label of ["Choose model", "Choose effort"]) {
      const trigger = screen.getByLabelText(label);
      expect(trigger.tagName).toBe("BUTTON");
      for (const cls of MODEL_CHIP_BASE.split(" ")) expect(trigger.className).toContain(cls);
    }
  });

  it("selects a model from the menu", async () => {
    const onModelChange = vi.fn();
    render(<ModelSelect model="gpt-5" models={MODELS} onModelChange={onModelChange} />);
    await openMenu("Choose model");
    const item = await screen.findByRole("menuitem", { name: /Claude Sonnet/ });
    await act(async () => {
      fireEvent.click(item);
    });
    await waitFor(() => expect(onModelChange).toHaveBeenCalledWith("sonnet"));
  });

  it("changes the thinking effort (off and token budget)", async () => {
    const onModelConfigChange = vi.fn();
    render(
      <ModelSelect
        model="gpt-5"
        models={MODELS}
        onModelChange={vi.fn()}
        onModelConfigChange={onModelConfigChange}
      />,
    );
    await openMenu("Choose effort");
    const budget = (await screen.findByLabelText("Thinking token budget")) as HTMLInputElement;
    fireEvent.change(budget, { target: { value: "8192" } });
    fireEvent.click(screen.getByLabelText("Apply thinking token budget"));
    expect(onModelConfigChange).toHaveBeenCalledWith("gpt-5", "8192");

    const off = screen.getByRole("menuitem", { name: /Off/ });
    await act(async () => {
      fireEvent.click(off);
    });
    await waitFor(() => expect(onModelConfigChange).toHaveBeenCalledWith("gpt-5", "off"));
  });

  it("keeps the effort trigger disabled when the model has no thinking", () => {
    render(
      <ModelSelect
        model="sonnet"
        models={MODELS}
        onModelChange={vi.fn()}
        onModelConfigChange={vi.fn()}
      />,
    );
    expect((screen.getByLabelText("Choose effort") as HTMLButtonElement).disabled).toBe(true);
  });
});
