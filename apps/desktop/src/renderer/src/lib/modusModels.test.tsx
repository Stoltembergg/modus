// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildModelPickerGroups,
  isHiddenPickerModel,
  isModusModel,
  isModusModelId,
  ModelOptions,
  type PickableModel,
  selectableModels,
  showsModusUnavailable,
} from "./modusModels";

afterEach(() => cleanup());

/** A mixed list in the main process order (Modus first, locked last within Modus). */
const MODELS: PickableModel[] = [
  {
    id: "modus/zai/glm-5-3-flash",
    name: "GLM-5.3-Flash",
    provider: "modus",
    providerName: "Modus",
  },
  { id: "modus/anthropic/claude-opus-5-5", name: "Claude Opus 5.5", provider: "modus" },
  {
    id: "modus/anthropic/claude-fable-5-1",
    name: "Claude Fable 5.1",
    provider: "modus",
    locked: true,
  },
  {
    id: "openrouter/z-ai/glm-5.3-flash",
    name: "GLM-5.3-Flash",
    provider: "openrouter",
    providerName: "OpenRouter",
  },
  {
    id: "openrouter/anthropic/claude-fable-5",
    name: "Claude Fable 5",
    provider: "openrouter",
    providerName: "OpenRouter",
  },
  { id: "anthropic/claude-x", name: "Claude X", provider: "anthropic", providerName: "Anthropic" },
  { id: "acme/acme-1", name: "Acme 1", provider: "acme", providerName: "zeta Relay" },
  {
    id: "deepseek/deepseek-v4",
    name: "DeepSeek V4",
    provider: "deepseek",
    providerName: "DeepSeek",
  },
];

const shape = (models: readonly PickableModel[], saved?: string | null) => {
  const { loose, groups } = buildModelPickerGroups(models, saved);
  return {
    loose,
    groups: groups.map((group) => [group.providerId, group.label, group.models.map((m) => m.id)]),
  };
};

describe("buildModelPickerGroups", () => {
  it("groups by provider: Modus first, then providers alphabetical by display name; locked Modus hidden", () => {
    expect(shape(MODELS)).toEqual({
      loose: [],
      groups: [
        ["modus", "Modus", ["modus/zai/glm-5-3-flash", "modus/anthropic/claude-opus-5-5"]],
        ["anthropic", "Anthropic", ["anthropic/claude-x"]],
        ["deepseek", "DeepSeek", ["deepseek/deepseek-v4"]],
        [
          "openrouter",
          "OpenRouter",
          ["openrouter/z-ai/glm-5.3-flash", "openrouter/anthropic/claude-fable-5"],
        ],
        ["acme", "zeta Relay", ["acme/acme-1"]],
      ],
    });
  });

  it("keeps the given order inside a group", () => {
    const reversed = [...MODELS].reverse();
    expect(shape(reversed).groups[0]).toEqual([
      "modus",
      "Modus",
      ["modus/anthropic/claude-opus-5-5", "modus/zai/glm-5-3-flash"],
    ]);
  });

  it("only Modus models can be hidden: a BYOK model flagged locked is still listed", () => {
    const byok = {
      id: "openai/gpt-x",
      name: "GPT X",
      provider: "openai",
      providerName: "OpenAI",
      locked: true,
    };
    expect(isHiddenPickerModel(byok)).toBe(false);
    expect(isHiddenPickerModel({ id: "modus/a/b", name: "B", locked: true })).toBe(true);
    expect(isHiddenPickerModel({ id: "modus/a/b", name: "B" })).toBe(false);
    expect(selectableModels([byok]).map((m) => m.id)).toEqual(["openai/gpt-x"]);
    expect(shape([byok]).groups).toEqual([["openai", "OpenAI", ["openai/gpt-x"]]]);
  });

  // Real ids: the Modus router id `deepseek/deepseek-flash` is registered under provider "modus"
  // as `modus/deepseek/deepseek-flash`; pi's bundled DeepSeek model is `deepseek/deepseek-flash`.
  const modusDeepseek: PickableModel = {
    id: "modus/deepseek/deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    provider: "modus",
    providerName: "Modus",
  };
  const byokDeepseek: PickableModel = {
    id: "deepseek/deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    provider: "deepseek",
    providerName: "DeepSeek",
  };

  it("Modus membership is by origin: a Modus model whose router id collides with a bundled/BYOK id is in the Modus group", () => {
    const models: PickableModel[] = [
      { id: "modus/zai/glm-5-3-flash", name: "GLM-5.3-Flash", provider: "modus" },
      modusDeepseek,
      { id: "modus/anthropic/claude-opus-5-5", name: "Claude Opus 5.5", provider: "modus" },
      byokDeepseek,
    ];
    const { groups } = buildModelPickerGroups(models);
    expect(groups.map((group) => [group.providerId, group.models])).toEqual([
      ["modus", [models[0], modusDeepseek, models[2]]],
      ["deepseek", [byokDeepseek]],
    ]);
    expect(isModusModel(modusDeepseek)).toBe(true);
    expect(isModusModel(byokDeepseek)).toBe(false);
  });

  it("hides a locked Modus-catalog model", () => {
    const locked = { ...modusDeepseek, id: "modus/deepseek/deepseek-pro", locked: true };
    expect(isHiddenPickerModel(locked)).toBe(true);
    expect(selectableModels([locked])).toEqual([]);
    expect(shape([locked]).groups).toEqual([]);
  });

  it("a BYOK model with the same name and router id as a locked Modus model is never hidden and keeps its own group", () => {
    const lockedByok = { ...byokDeepseek, locked: true };
    const lockedModus = { ...modusDeepseek, locked: true };
    expect(isModusModel(lockedByok)).toBe(false);
    expect(isHiddenPickerModel(lockedByok)).toBe(false);
    expect(shape([lockedModus, lockedByok]).groups).toEqual([
      ["deepseek", "DeepSeek", ["deepseek/deepseek-flash"]],
    ]);
  });

  it("defensive: a provider === 'modus' model without the modus/ prefix still counts as Modus (grouped, hidden when locked)", () => {
    const unprefixed = {
      id: "deepseek/deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      provider: "modus",
    };
    expect(isModusModel(unprefixed)).toBe(true);
    expect(shape([unprefixed]).groups).toEqual([["modus", "Modus", ["deepseek/deepseek-flash"]]]);
    expect(isHiddenPickerModel({ ...unprefixed, locked: true })).toBe(true);
  });

  it("falls back to the modus/ prefix only when a model has no provider", () => {
    expect(isModusModel({ id: "modus/a/b", name: "B" })).toBe(true);
    expect(isModusModel({ id: "a/b", name: "B" })).toBe(false);
    expect(shape([{ id: "modus/a/b", name: "B" }]).groups).toEqual([
      ["modus", "Modus", ["modus/a/b"]],
    ]);
  });

  it("drops empty groups (all Modus models locked)", () => {
    const allLocked = MODELS.map((m) => (isModusModelId(m.id) ? { ...m, locked: true } : m));
    expect(shape(allLocked).groups.map(([id]) => id)).toEqual([
      "anthropic",
      "deepseek",
      "openrouter",
      "acme",
    ]);
    expect(shape([]).groups).toEqual([]);
  });

  it("derives the provider from the id prefix when the model carries none", () => {
    expect(shape([{ id: "groq/llama", name: "Llama" }]).groups).toEqual([
      ["groq", "groq", ["groq/llama"]],
    ]);
  });

  it("keeps a saved model that is no longer listed as a loose (unavailable) option", () => {
    // Locked Modus model: named from the list.
    expect(shape(MODELS, "modus/anthropic/claude-fable-5-1").loose).toEqual([
      { id: "modus/anthropic/claude-fable-5-1", label: "Claude Fable 5.1 (unavailable)" },
    ]);
    // Gone entirely: the id.
    expect(shape(MODELS, "gone/model").loose).toEqual([
      { id: "gone/model", label: "gone/model (unavailable)" },
    ]);
    // Listed, empty or absent: nothing loose.
    expect(shape(MODELS, "anthropic/claude-x").loose).toEqual([]);
    expect(shape(MODELS, "").loose).toEqual([]);
    expect(shape(MODELS, null).loose).toEqual([]);
  });
});

describe("ModelOptions", () => {
  it("renders the loose option, then one optgroup per provider, with no emoji or lock text", () => {
    const { container } = render(
      <select defaultValue="modus/anthropic/claude-fable-5-1">
        <ModelOptions models={MODELS} savedModelId="modus/anthropic/claude-fable-5-1" />
      </select>,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    const loose = [...select.children].filter((el) => el.tagName === "OPTION");
    expect(loose.map((el) => el.textContent)).toEqual(["Claude Fable 5.1 (unavailable)"]);
    expect(
      [...select.querySelectorAll("optgroup")].map((group) => [
        group.label,
        group.dataset.provider,
        [...group.querySelectorAll("option")].map((option) => option.textContent),
      ]),
    ).toEqual([
      ["Modus", "modus", ["GLM-5.3-Flash", "Claude Opus 5.5"]],
      ["Anthropic", "anthropic", ["Claude X"]],
      ["DeepSeek", "deepseek", ["DeepSeek V4"]],
      ["OpenRouter", "openrouter", ["GLM-5.3-Flash", "Claude Fable 5"]],
      ["zeta Relay", "acme", ["Acme 1"]],
    ]);
    expect(select.value).toBe("modus/anthropic/claude-fable-5-1");
    expect(select.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(select.querySelector("[data-locked]")).toBeNull();
  });
});

describe("Modus unavailable notice", () => {
  it("is only for Modus sessions while the router is unavailable", () => {
    expect(isModusModelId("modus/deepseek/deepseek-flash")).toBe(true);
    expect(isModusModelId("openai/gpt-x")).toBe(false);
    expect(isModusModelId(undefined)).toBe(false);
    expect(showsModusUnavailable("unavailable", ["openai/gpt-x", "modus/zai/glm"])).toBe(true);
    expect(showsModusUnavailable("unavailable", ["openai/gpt-x", undefined])).toBe(false);
    expect(showsModusUnavailable("ready", ["modus/zai/glm"])).toBe(false);
    expect(showsModusUnavailable(undefined, ["modus/zai/glm"])).toBe(false);
  });
});
