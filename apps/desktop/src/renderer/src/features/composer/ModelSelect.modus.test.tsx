// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../../../../shared/contracts";
import { ModelSelect } from "./Composer";
import { setModusPickerStatus, setModusUpgradeHandler } from "./modusPickerState";

afterEach(() => {
  cleanup();
  setModusPickerStatus(undefined);
  setModusUpgradeHandler(undefined);
});

function model(partial: Partial<ModelInfo> & Pick<ModelInfo, "id" | "name">): ModelInfo {
  return {
    provider: "modus",
    providerName: "Modus",
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
  model({ id: "modus/deepseek/deepseek-flash", name: "DeepSeek Flash" }),
  model({ id: "modus/zai/glm-4.6", name: "GLM 4.6", locked: "upgrade" }),
  model({ id: "openai/gpt-5", name: "GPT-5", provider: "openai", providerName: "OpenAI" }),
];

async function openMenu() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Choose model"));
  });
}

describe("ModelSelect with Modus (B4b)", () => {
  it("shows a locked model disabled with an Upgrade invite that opens Account", async () => {
    const onModelChange = vi.fn();
    const openUpgrade = vi.fn();
    setModusPickerStatus("ready");
    setModusUpgradeHandler(openUpgrade);
    render(
      <ModelSelect
        model="modus/deepseek/deepseek-flash"
        models={MODELS}
        onModelChange={onModelChange}
      />,
    );
    await openMenu();
    // The locked model is not a selectable item; only its Upgrade action is.
    expect(screen.queryByRole("menuitem", { name: /^GLM 4\.6$/ })).toBeNull();
    const upgrade = await screen.findByRole("menuitem", {
      name: "Upgrade your plan to use GLM 4.6",
    });
    expect(upgrade.textContent).toBe("Upgrade");
    await act(async () => {
      fireEvent.click(upgrade);
    });
    await waitFor(() => expect(openUpgrade).toHaveBeenCalledTimes(1));
    expect(onModelChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("modus-unavailable")).toBeNull();
  });

  it("falls back to a usable model (never a locked one) when the current id is unknown", () => {
    const lockedFirst = [MODELS[1], MODELS[0], MODELS[2]].filter((item): item is ModelInfo =>
      Boolean(item),
    );
    render(<ModelSelect model="gone/model" models={lockedFirst} onModelChange={vi.fn()} />);
    expect(screen.getByLabelText("Choose model").textContent).toContain("DeepSeek Flash");
  });

  it('says "Modus is unavailable right now." when /v1/models failed', async () => {
    setModusPickerStatus("unavailable");
    render(
      <ModelSelect
        model="openai/gpt-5"
        models={MODELS.filter((item) => item.provider !== "modus")}
        onModelChange={vi.fn()}
      />,
    );
    await openMenu();
    expect((await screen.findByTestId("modus-unavailable")).textContent).toBe(
      "Modus is unavailable right now.",
    );
  });
});
