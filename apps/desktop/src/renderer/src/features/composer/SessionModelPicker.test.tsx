// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../../../../shared/contracts";
import { SessionModelPicker } from "./SessionModelPicker";

function model(id: string, name: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name,
    provider: id.split("/")[0] ?? id,
    available: true,
    enabled: true,
    configured: true,
    source: "builtin",
    supportsThinking: false,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    ...extra,
  };
}

const MODELS: ModelInfo[] = [
  model("openai/gpt-5", "GPT-5", {
    supportsThinking: true,
    thinkingLevel: "high",
    thinkingLevels: ["low", "medium", "high"],
  }),
  model("anthropic/sonnet", "Claude Sonnet"),
  model("modus/locked", "Locked Pro", { provider: "modus", locked: "upgrade" }),
];

const setModel = vi.fn();
const setDefault = vi.fn();

beforeEach(() => {
  setModel.mockReset().mockResolvedValue({});
  setDefault.mockReset();
  Object.assign(window, {
    modus: { agent: { setModel }, model: { setDefault } },
  });
});
afterEach(cleanup);

function renderPicker(extra: Partial<Parameters<typeof SessionModelPicker>[0]> = {}) {
  const props = {
    sessionId: "s1",
    storedModelId: "anthropic/sonnet" as string | undefined,
    defaultModelId: "openai/gpt-5",
    models: MODELS,
    modelsReady: true,
    isRunning: false,
    onBlockedChange: vi.fn(),
    onError: vi.fn(),
    onChanged: vi.fn(),
    ...extra,
  };
  render(<SessionModelPicker {...props} />);
  return props;
}

const trigger = () => screen.getByTestId("model-picker-trigger");

describe("SessionModelPicker", () => {
  it("shows the chat's saved model", () => {
    const props = renderPicker();
    expect(trigger().textContent).toContain("Claude Sonnet");
    expect(props.onBlockedChange).toHaveBeenLastCalledWith(false);
  });

  it("shows Default (X) when the chat has no saved model", () => {
    renderPicker({ storedModelId: undefined });
    expect(trigger().textContent).toContain("Default (GPT-5)");
  });

  it("is disabled while a run is active", () => {
    renderPicker({ isRunning: true });
    expect(trigger().hasAttribute("disabled") || trigger().dataset.disabled !== undefined).toBe(
      true,
    );
  });

  it("asks to pick and blocks send when the saved model is unusable", () => {
    for (const storedModelId of ["gone/model", "modus/locked"]) {
      const props = renderPicker({ storedModelId });
      expect(trigger().textContent).toContain("Pick a model");
      expect(props.onBlockedChange).toHaveBeenLastCalledWith(true);
      cleanup();
    }
  });

  it("hides locked models and changes only this chat", async () => {
    const user = userEvent.setup();
    const props = renderPicker();
    await user.click(trigger());
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).queryByRole("option", { name: "Locked Pro" })).toBeNull();
    await user.click(within(listbox).getByRole("option", { name: "GPT-5" }));
    await waitFor(() =>
      expect(setModel).toHaveBeenCalledWith({ sessionId: "s1", model: "openai/gpt-5" }),
    );
    expect(props.onChanged).toHaveBeenCalled();
    expect(setDefault).not.toHaveBeenCalled();
  });

  it("shows the effort chip only for models with thinking options and sends the variant", async () => {
    renderPicker();
    expect(screen.queryByTestId("session-effort-picker")).toBeNull();
    cleanup();

    const user = userEvent.setup();
    renderPicker({ storedModelId: "openai/gpt-5" });
    await user.click(screen.getByTestId("session-effort-picker"));
    await user.click(await screen.findByRole("menuitem", { name: "low" }));
    await waitFor(() =>
      expect(setModel).toHaveBeenCalledWith({
        sessionId: "s1",
        model: "openai/gpt-5",
        thinkingVariant: "low",
      }),
    );
  });

  it("does not block while the catalog is still loading", () => {
    const props = renderPicker({ models: [], modelsReady: false });
    expect(props.onBlockedChange).toHaveBeenLastCalledWith(false);
    expect(trigger().textContent).not.toContain("Pick a model");
  });

  it("tells screen readers why it is disabled during a run", () => {
    renderPicker({ isRunning: true });
    expect(trigger().getAttribute("aria-description")).toBe(
      "Can't change the model while a run is active.",
    );
  });

  it("reports a refused change", async () => {
    setModel.mockRejectedValue(
      new Error(
        "Error invoking remote method 'agent:set-model': Error: Can't change the model while a run is active.",
      ),
    );
    const user = userEvent.setup();
    const props = renderPicker();
    await user.click(trigger());
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByRole("option", { name: "GPT-5" }));
    await waitFor(() =>
      expect(props.onError).toHaveBeenCalledWith("Can't change the model while a run is active."),
    );
    expect(props.onChanged).not.toHaveBeenCalled();
  });
});
