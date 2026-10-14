// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cloneElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_FALLBACK_INSTRUCTIONS,
  AGENT_FALLBACK_ROLE,
  AGENT_GENERATION_WARNING,
  AGENT_TEMPLATES,
} from "../../../../shared/agent-templates";
import type {
  AgentGroupWithMembers,
  AgentInfo,
  GenerateAgentProfileInput,
  GeneratedAgentProfile,
  NewGroupAgentInput,
} from "../../../../shared/contracts";
import { encodeGroupErrorMessage } from "../../../../shared/group-errors";
import type { PickableModel } from "../../lib/modusModels";
import { GROUP_ERROR_MESSAGES } from "../groups/groupErrors";
import { AGENT_GENERATED_HINT, AgentDialog, CUSTOM_WORK_TYPES_WARNING } from "./AgentDialog";
import { AGENT_NAME_REQUIRED, agentDialogError, needsProfileGeneration } from "./agentDialogModel";
import { normalizeSearch } from "./ModelPicker";

/**
 * Motion's presence flag. happy-dom finishes exit animations instantly, so the "exiting"
 * window (AnimatePresence keeps the dialog mounted while isPresent is false) is simulated here.
 */
const presence = vi.hoisted(() => ({ current: true }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useIsPresent: () => presence.current,
}));

const MODELS = [
  { id: "m-1", name: "Model 1" },
  { id: "m-2", name: "Model 2" },
];

const member = (agentId: string, name: string, agentRole = "") => ({
  groupId: "g-1",
  sessionId: `room-${agentId}`,
  agentId,
  name,
  agentRole,
  joinedAt: "2026-01-01T00:00:00.000Z",
});

const GROUP: AgentGroupWithMembers = {
  id: "g-1",
  name: "Release squad",
  workspaceId: "ws-1",
  mode: "free",
  members: [member("a-1", "Ana", "Reviewer"), member("a-2", "Bo", "Builder")],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const ANA: AgentInfo = {
  id: "a-1",
  groupId: "g-1",
  name: "Ana",
  role: "Reviewer",
  instructions: "Review every diff.",
  modelId: "m-1",
  avatarFace: "wink",
  avatarColor: "teal",
  avatarShape: "squircle",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const GENERATED: GeneratedAgentProfile = {
  role: "Release notes writer",
  instructions: "Keep the changelog tidy.",
  generated: true,
};

function renderDialog({
  agent,
  group = GROUP,
  models = MODELS,
  generate = vi.fn(async (_input: GenerateAgentProfileInput) => GENERATED),
  create = vi.fn(async (_input: unknown) => undefined),
  defaultModelId = "m-2",
}: {
  agent?: AgentInfo;
  group?: AgentGroupWithMembers;
  models?: readonly PickableModel[];
  generate?: (input: GenerateAgentProfileInput) => Promise<GeneratedAgentProfile>;
  create?: ReturnType<typeof vi.fn<(input: unknown) => Promise<undefined>>>;
  defaultModelId?: string;
} = {}) {
  const onUpdate = vi.fn(async (_input: unknown) => undefined);
  const onOpenChange = vi.fn();
  const element = (
    <AgentDialog
      agent={agent}
      defaultModelId={defaultModelId}
      group={group}
      models={models}
      onCreate={create}
      onGenerate={generate}
      onOpenChange={onOpenChange}
      onUpdate={onUpdate}
      open
    />
  );
  const view = render(element);
  const dialog = screen.getByRole("dialog");
  // A fresh element so React re-renders (the same element reference would bail out).
  const rerender = () => view.rerender(cloneElement(element));
  return { dialog, generate, create, onUpdate, onOpenChange, rerender };
}

const field = (dialog: HTMLElement, name: string | RegExp) =>
  within(dialog).getByRole("textbox", { name }) as HTMLInputElement;

/** The model picker trigger (a Base UI combobox); `data-value` carries the model id. */
const modelTrigger = (dialog: HTMLElement) =>
  within(dialog).getByRole("combobox", { name: "Model" }) as HTMLButtonElement;

async function openModels(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.click(modelTrigger(dialog));
  return screen.findByRole("listbox");
}

const groupLabel = (group: HTMLElement) =>
  group.ownerDocument.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent ??
  null;

afterEach(() => {
  cleanup();
  presence.current = true;
});

describe("agentDialogModel", () => {
  const context = { custom: true, takenNames: ["Ana"], availableModelIds: ["m-1"] };
  const draft = { name: "Cy", role: "", instructions: "", modelId: "m-1" };

  it("requires a name unique in the group and, for a custom agent, an available model", () => {
    expect(agentDialogError(draft, context)).toBeNull();
    expect(agentDialogError({ ...draft, name: "  " }, context)).toBe(AGENT_NAME_REQUIRED);
    expect(agentDialogError({ ...draft, name: " ana " }, context)).toBe(
      GROUP_ERROR_MESSAGES["agent-name-taken"],
    );
    expect(agentDialogError({ ...draft, modelId: "" }, context)).toBe(
      GROUP_ERROR_MESSAGES["agent-model-required"],
    );
    expect(agentDialogError({ ...draft, modelId: "gone" }, context)).toBe(
      GROUP_ERROR_MESSAGES["agent-model-unavailable"],
    );
    // A template agent may use the app default; a saved model is kept as-is.
    expect(agentDialogError({ ...draft, modelId: "" }, { ...context, custom: false })).toBeNull();
    expect(
      agentDialogError({ ...draft, modelId: "gone" }, { ...context, savedModelId: "gone" }),
    ).toBeNull();
  });

  it("generates only for a custom agent with no role and no instructions", () => {
    expect(needsProfileGeneration({ role: " ", instructions: "" }, true)).toBe(true);
    expect(needsProfileGeneration({ role: "Writer", instructions: "" }, true)).toBe(false);
    expect(needsProfileGeneration({ role: "", instructions: "Do X" }, true)).toBe(false);
    expect(needsProfileGeneration({ role: "", instructions: "" }, false)).toBe(false);
  });
});

describe("AgentDialog", () => {
  it("groups models by provider and hides a locked Modus model (never a BYOK one)", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog({
      agent: ANA,
      models: [
        { id: "modus/zai/glm-5-3-flash", name: "GLM-5.3-Flash", provider: "modus" },
        { id: "modus/anthropic/claude-fable-5-1", name: "Fable", provider: "modus", locked: true },
        { id: "m-1", name: "Model 1", provider: "relay", providerName: "Relay" },
        {
          id: "openrouter/z-ai/glm-5.3-flash",
          name: "GLM-5.3-Flash",
          provider: "openrouter",
          providerName: "OpenRouter",
        },
        {
          id: "byok/locked",
          name: "BYOK flagged",
          provider: "byok",
          providerName: "Acme",
          locked: true,
        },
      ],
    });
    expect(modelTrigger(dialog).dataset.value).toBe("m-1");
    const listbox = await openModels(user, dialog);
    const groups = within(listbox).getAllByRole("group");
    expect(groups.map((group) => group.dataset.provider)).toEqual([
      "modus",
      "byok",
      "openrouter",
      "relay",
    ]);
    expect(groups.map(groupLabel)).toEqual(["Modus", "Acme", "OpenRouter", "Relay"]);
    // Sticky group headers use the shared glass strip (solid unless Full transparency), not a
    // solid bg-elevated fill.
    for (const group of groups) {
      const label = group.firstElementChild as HTMLElement;
      expect(label.classList.contains("sticky-glass-strip")).toBe(true);
      expect(label.dataset.strip).toBe("elevated");
      expect(label.className).not.toContain("bg-elevated");
    }
    expect(
      groups.map((group) =>
        within(group)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ),
    ).toEqual([["GLM-5.3-Flash"], ["BYOK flagged"], ["GLM-5.3-Flash"], ["Model 1"]]);
    expect(within(listbox).queryByRole("option", { name: "Fable" })).toBeNull();
    expect(listbox.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    // Custom agents get no "App default" entry.
    expect(within(listbox).queryByRole("option", { name: "App default" })).toBeNull();
  });

  it("keeps a saved model that is now locked as '(unavailable)' and saving does not change it", async () => {
    const user = userEvent.setup();
    const { dialog, onUpdate } = renderDialog({
      agent: { ...ANA, modelId: "modus/anthropic/claude-fable-5-1" },
      models: [
        ...MODELS,
        { id: "modus/anthropic/claude-fable-5-1", name: "Fable", provider: "modus", locked: true },
      ],
    });
    expect(modelTrigger(dialog).dataset.value).toBe("modus/anthropic/claude-fable-5-1");
    expect(modelTrigger(dialog).textContent).toBe("Fable (unavailable)");
    await user.clear(field(dialog, "Instructions"));
    await user.type(field(dialog, "Instructions"), "Review twice.");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).not.toHaveProperty("modelId");
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("does not preselect a locked Modus default for a new custom agent", () => {
    const { dialog } = renderDialog({
      defaultModelId: "modus/x/locked",
      models: [...MODELS, { id: "modus/x/locked", name: "Locked", locked: true }],
    });
    expect(modelTrigger(dialog).dataset.value).toBe("");
    expect(modelTrigger(dialog).textContent).toBe("Choose a model");
  });

  it("shows every field with a 48 px animated preview that follows face and color", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog();
    for (const name of ["Name", "Custom role", "Instructions", /What should it help with/]) {
      expect(field(dialog, name)).toBeTruthy();
    }
    expect(within(dialog).getByRole("combobox", { name: "Role" })).toBeTruthy();
    expect(modelTrigger(dialog).dataset.value).toBe("m-2");
    const preview = within(dialog)
      .getAllByTestId("agent-avatar")
      .find((avatar) => avatar.dataset.size === "48");
    expect(preview?.dataset.state).toBe("idle");
    await user.click(within(dialog).getByRole("button", { name: "Face sleepy" }));
    await user.click(within(dialog).getByRole("button", { name: "Color violet" }));
    expect(preview?.dataset.face).toBe("sleepy");
    expect(preview?.dataset.color).toBe("violet");
    expect(within(dialog).getAllByRole("button", { name: /^Face / })).toHaveLength(8);
    expect(within(dialog).getAllByRole("button", { name: /^Shape / })).toHaveLength(10);
    expect(within(dialog).getAllByRole("button", { name: /^Color / })).toHaveLength(22);
  });

  it("a custom agent needs a name (unique in the group) and a model", async () => {
    const user = userEvent.setup();
    const { dialog, generate, create } = renderDialog({ models: [] });
    await user.click(within(dialog).getByRole("button", { name: "Generate" }));
    expect(within(dialog).getByRole("alert").textContent).toBe(AGENT_NAME_REQUIRED);
    await user.type(field(dialog, "Name"), "ANA");
    expect(within(dialog).getByRole("alert").textContent).toBe(
      GROUP_ERROR_MESSAGES["agent-name-taken"],
    );
    await user.clear(field(dialog, "Name"));
    await user.type(field(dialog, "Name"), "Cy");
    expect(within(dialog).getByRole("alert").textContent).toBe(
      GROUP_ERROR_MESSAGES["agent-model-required"],
    );
    expect(within(dialog).getByRole("button", { name: "Regenerate" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(generate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("with an empty role and instructions the button reads Generate; after generating it reads Create and saves", async () => {
    const user = userEvent.setup();
    const { dialog, generate, create, onOpenChange } = renderDialog();
    expect(within(dialog).queryByRole("button", { name: "Create" })).toBeNull();
    await user.type(field(dialog, "Name"), "Cy");
    await user.type(field(dialog, /What should it help with/), "release notes");
    await user.click(within(dialog).getByRole("button", { name: "Generate" }));
    expect(generate).toHaveBeenCalledWith({
      groupId: "g-1",
      modelId: "m-2",
      name: "Cy",
      description: "release notes",
    });
    await waitFor(() => expect(field(dialog, "Custom role").value).toBe(GENERATED.role));
    expect(field(dialog, "Instructions").value).toBe(GENERATED.instructions);
    expect(within(dialog).getByTestId("agent-dialog-notice").textContent).toBe(
      AGENT_GENERATED_HINT,
    );
    expect(create).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole("button", { name: "Generate" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeTruthy();

    await user.clear(field(dialog, "Custom role"));
    await user.type(field(dialog, "Custom role"), "Scribe");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      groupId: "g-1",
      name: "Cy",
      role: "Scribe",
      instructions: GENERATED.instructions,
      modelId: "m-2",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("with a role or instructions typed, Create saves without generating", async () => {
    const user = userEvent.setup();
    const { dialog, generate, create } = renderDialog();
    await user.type(field(dialog, "Name"), "Cy");
    expect(within(dialog).getByRole("button", { name: "Generate" })).toBeTruthy();
    await user.type(field(dialog, "Custom role"), "Scribe");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(generate).not.toHaveBeenCalled();
  });

  it("the fallback fills Generalist + the default instructions and shows the warning", async () => {
    const user = userEvent.setup();
    const generate = vi.fn(async () => ({
      role: AGENT_FALLBACK_ROLE,
      instructions: AGENT_FALLBACK_INSTRUCTIONS,
      generated: false,
      warning: AGENT_GENERATION_WARNING,
    }));
    const { dialog, create } = renderDialog({ generate });
    await user.type(field(dialog, "Name"), "Cy");
    await user.click(within(dialog).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(field(dialog, "Custom role").value).toBe(AGENT_FALLBACK_ROLE));
    expect(field(dialog, "Instructions").value).toBe(AGENT_FALLBACK_INSTRUCTIONS);
    const notice = within(dialog).getByTestId("agent-dialog-notice");
    expect(notice.textContent).toBe(AGENT_GENERATION_WARNING);
    expect(notice.dataset.warning).toBe("true");
    expect(create).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeTruthy();
  });

  it("a rejected generation (model validation) shows the group error", async () => {
    const user = userEvent.setup();
    const generate = vi.fn(async () => {
      throw new Error(encodeGroupErrorMessage("agent-model-unavailable", "gone"));
    });
    const { dialog } = renderDialog({ generate });
    await user.type(field(dialog, "Name"), "Cy");
    await user.click(within(dialog).getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe(
        GROUP_ERROR_MESSAGES["agent-model-unavailable"],
      ),
    );
    expect(field(dialog, "Custom role").value).toBe("");
    // Nothing was generated: the button still offers Generate.
    expect(within(dialog).getByRole("button", { name: "Generate" })).toBeTruthy();
  });

  it("edit: Regenerate replaces only the instructions (excluding itself); Save sends the changes", async () => {
    const user = userEvent.setup();
    const { dialog, generate, onUpdate } = renderDialog({ agent: ANA });
    expect(field(dialog, "Name").value).toBe("Ana");
    expect(field(dialog, "Instructions").value).toBe("Review every diff.");
    expect(
      within(dialog).getByRole("button", { name: "Face wink" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));
    expect(generate).toHaveBeenCalledWith({
      groupId: "g-1",
      modelId: "m-1",
      name: "Ana",
      agentId: "a-1",
    });
    await waitFor(() => expect(field(dialog, "Instructions").value).toBe(GENERATED.instructions));
    // The chosen role stays: no switch to Custom with the generated label.
    expect(
      (within(dialog).getByRole("combobox", { name: "Role" }) as HTMLSelectElement).value,
    ).toBe("reviewer");
    expect(within(dialog).queryByRole("textbox", { name: "Custom role" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Color pink" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    // The model did not change: it is not sent (the IPC revalidates only a changed model).
    expect(onUpdate).toHaveBeenCalledWith({
      id: "a-1",
      name: "Ana",
      role: "Reviewer",
      instructions: GENERATED.instructions,
      avatarFace: "wink",
      avatarColor: "pink",
      avatarShape: "squircle",
    });
  });

  it("group editing disables occupied shapes and keeps the current shape selectable", () => {
    const [firstMember, secondMember] = GROUP.members;
    if (!firstMember || !secondMember) throw new Error("expected two group members");
    const group: AgentGroupWithMembers = {
      ...GROUP,
      members: [
        { ...firstMember, avatarShape: "triangle" },
        { ...secondMember, avatarShape: "pentagon" },
      ],
    };
    const { dialog } = renderDialog({ agent: { ...ANA, avatarShape: "triangle" }, group });
    const currentShape = within(dialog).getByRole("button", { name: "Shape triangle" });
    const occupiedShape = within(dialog).getByRole("button", { name: "Shape pentagon" });
    expect(currentShape.getAttribute("aria-pressed")).toBe("true");
    expect((currentShape as HTMLButtonElement).disabled).toBe(false);
    expect((occupiedShape as HTMLButtonElement).disabled).toBe(true);
  });

  it("an IPC error keeps the dialog open with its message", async () => {
    const user = userEvent.setup();
    const create = vi.fn(async (_input: unknown): Promise<undefined> => {
      throw new Error(encodeGroupErrorMessage("group-max-members", "full"));
    });
    const { dialog, onOpenChange } = renderDialog({ create });
    await user.type(field(dialog, "Name"), "Cy");
    await user.type(field(dialog, "Custom role"), "Scribe");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe(
        GROUP_ERROR_MESSAGES["group-max-members"],
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("a template agent may use the app default model and has no Regenerate", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog({
      agent: (({ modelId: _modelId, ...rest }) => ({ ...rest, templateId: "reviewer" }))(ANA),
    });
    expect(modelTrigger(dialog).dataset.value).toBe("");
    expect(modelTrigger(dialog).textContent).toBe("App default");
    expect(within(dialog).queryByRole("button", { name: "Regenerate" })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: /What should it help with/ })).toBeNull();
    const first = within(await openModels(user, dialog)).getAllByRole("option")[0];
    expect(first?.textContent).toBe("App default");
    expect(first?.getAttribute("aria-selected")).toBe("true");
  });

  it("requires a user choice when the explicit default is unavailable", async () => {
    const user = userEvent.setup();
    const create = vi.fn(async () => undefined);
    const { dialog } = renderDialog({ models: MODELS.slice(0, 1), create });
    expect(modelTrigger(dialog).dataset.value).toBe("");
    await user.type(field(dialog, "Name"), "Cy");
    await user.type(field(dialog, "Custom role"), "Scribe");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe(
        GROUP_ERROR_MESSAGES["agent-model-required"],
      ),
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe("AgentDialog model picker", () => {
  const MIXED: readonly PickableModel[] = [
    { id: "m-1", name: "Model 1", provider: "relay", providerName: "Relay" },
    { id: "m-2", name: "Model 2", provider: "relay", providerName: "Relay" },
    { id: "or/glm", name: "GLM-5.3-Flash", provider: "openrouter", providerName: "OpenRouter" },
    { id: "modus/zai/glm", name: "GLM Modus", provider: "modus" },
  ];

  it("opens with the keyboard, filters by typing and selects with Enter; Save sends it", async () => {
    const user = userEvent.setup();
    const { dialog, onUpdate } = renderDialog({ agent: ANA, models: MIXED });
    const trigger = modelTrigger(dialog);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // The dialog moves focus to Name first; then focus the trigger.
    await waitFor(() => expect(document.activeElement).toBe(field(dialog, "Name")));
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const listbox = await screen.findByRole("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const search = screen.getByRole("combobox", { name: "Search models" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    await user.keyboard("model 2");
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Model 2"]);
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(trigger.dataset.value).toBe("m-2");
    expect(trigger.textContent).toBe("Model 2");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({ modelId: "m-2" });
  });

  it("arrow keys move through every group and the selected option carries the check", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog({ agent: ANA, models: MIXED });
    const listbox = await openModels(user, dialog);
    const options = within(listbox).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "GLM Modus",
      "GLM-5.3-Flash",
      "Model 1",
      "Model 2",
    ]);
    const selected = options.filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.textContent)).toEqual(["Model 1"]);
    expect(selected[0]?.querySelector("svg")).not.toBeNull();
    expect(options[0]?.querySelector("svg")).toBeNull();
    await user.keyboard("{ArrowUp}{ArrowUp}{Enter}");
    await waitFor(() => expect(modelTrigger(dialog).dataset.value).toBe("modus/zai/glm"));
  });

  it("search matches provider names and shows an empty state", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog({ agent: ANA, models: MIXED });
    const listbox = await openModels(user, dialog);
    const search = screen.getByRole("combobox", { name: "Search models" });
    await user.type(search, "openrouter");
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["GLM-5.3-Flash"]);
    await user.clear(search);
    await user.type(search, "zzz");
    expect(within(listbox).queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No models match")).toBeTruthy();
  });

  it("Esc closes the picker, keeps the value and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const { dialog, onOpenChange } = renderDialog({ agent: ANA, models: MIXED });
    await openModels(user, dialog);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(modelTrigger(dialog).dataset.value).toBe("m-1");
    await waitFor(() => expect(document.activeElement).toBe(modelTrigger(dialog)));
    // Esc only closed the picker, not the dialog.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("a saved model that is no longer listed is offered at the top as '(unavailable)'", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog({ agent: { ...ANA, modelId: "gone/model" }, models: MIXED });
    expect(modelTrigger(dialog).dataset.value).toBe("gone/model");
    expect(modelTrigger(dialog).textContent).toBe("gone/model (unavailable)");
    const listbox = await openModels(user, dialog);
    const [loose] = within(listbox).getAllByRole("group");
    expect(loose?.dataset.provider).toBeUndefined();
    const [saved] = within(loose as HTMLElement).getAllByRole("option");
    expect(saved?.textContent).toBe("gone/model (unavailable)");
    expect(saved?.getAttribute("aria-selected")).toBe("true");
    await user.click(within(listbox).getByRole("option", { name: "Model 2" }));
    await waitFor(() => expect(modelTrigger(dialog).dataset.value).toBe("m-2"));
  });
  it("search ignores case and accents in the query and the names", async () => {
    expect(normalizeSearch("ÉTOILE")).toBe("etoile");
    expect(normalizeSearch("Pokémon")).toBe("pokemon");
    expect(normalizeSearch("café")).toBe("cafe");
    const user = userEvent.setup();
    const { dialog } = renderDialog({
      agent: ANA,
      models: [
        ...MIXED,
        { id: "x/poke", name: "Pokémon Mini", provider: "relay", providerName: "Relay" },
        { id: "x/etoile", name: "ÉTOILE 2", provider: "relay", providerName: "Relay" },
        { id: "x/cafe", name: "Cafe Latte", provider: "relay", providerName: "Relay" },
      ],
    });
    const listbox = await openModels(user, dialog);
    const search = screen.getByRole("combobox", { name: "Search models" });
    const shown = () =>
      within(listbox)
        .queryAllByRole("option")
        .map((o) => o.textContent);
    for (const [query, name] of [
      ["pokemon", "Pokémon Mini"], // accent mid-word in the name
      ["etoile", "ÉTOILE 2"], // accent at the start, uppercase name
      ["café", "Cafe Latte"], // accent in the query
      ["POKÉ", "Pokémon Mini"],
    ] as const) {
      await user.clear(search);
      await user.type(search, query);
      expect(shown(), query).toEqual([name]);
    }
  });

  it("Home and End jump to the first and last option across groups", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog({ agent: ANA, models: MIXED });
    const listbox = await openModels(user, dialog);
    const highlighted = () => listbox.querySelector("[data-highlighted]")?.textContent;
    await waitFor(() => expect(highlighted()).toBe("Model 1"));
    await user.keyboard("{Home}");
    expect(highlighted()).toBe("GLM Modus");
    await user.keyboard("{End}");
    expect(highlighted()).toBe("Model 2");
    await user.keyboard("{Home}{Enter}");
    await waitFor(() => expect(modelTrigger(dialog).dataset.value).toBe("modus/zai/glm"));
  });

  it("Esc with a query closes the picker, keeps the value, returns focus and clears the query", async () => {
    const user = userEvent.setup();
    const { dialog, onOpenChange } = renderDialog({ agent: ANA, models: MIXED });
    await openModels(user, dialog);
    await user.type(screen.getByRole("combobox", { name: "Search models" }), "glm");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(modelTrigger(dialog).dataset.value).toBe("m-1");
    await waitFor(() => expect(document.activeElement).toBe(modelTrigger(dialog)));
    expect(onOpenChange).not.toHaveBeenCalled();
    const listbox = await openModels(user, dialog);
    expect(
      (screen.getByRole("combobox", { name: "Search models" }) as HTMLInputElement).value,
    ).toBe("");
    expect(within(listbox).getAllByRole("option")).toHaveLength(MIXED.length);
  });
});

describe("AgentDialog exit guard", () => {
  const form = (dialog: HTMLElement) =>
    within(dialog).getByTestId("agent-dialog") as HTMLFormElement;

  it("a second Save after saving is ignored, and the exiting dialog is inert", async () => {
    const user = userEvent.setup();
    const { dialog, onUpdate, onOpenChange, rerender } = renderDialog({ agent: ANA });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    // The button stays disabled through the exit instead of re-enabling in `finally`.
    expect(within(dialog).getByRole("button", { name: "Saving…" })).toHaveProperty(
      "disabled",
      true,
    );
    // Re-entry (Enter / a racing click) before the host re-renders: ignored.
    fireEvent.submit(form(dialog));
    // The host now plays the exit (AnimatePresence: isPresent false).
    presence.current = false;
    rerender();
    expect(form(dialog).hasAttribute("inert")).toBe(true);
    expect(form(dialog).getAttribute("aria-hidden")).toBe("true");
    fireEvent.submit(form(dialog));
    fireEvent.click(within(dialog).getByText("Cancel"));
    await Promise.resolve();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("while exiting, Save, Create and Regenerate do nothing", async () => {
    presence.current = false;
    const generate = vi.fn(async (_input: GenerateAgentProfileInput) => GENERATED);
    const { dialog, onUpdate, onOpenChange } = renderDialog({ agent: ANA, generate });
    expect(form(dialog).hasAttribute("inert")).toBe(true);
    fireEvent.click(within(dialog).getByText("Regenerate"));
    fireEvent.submit(form(dialog));
    await Promise.resolve();
    expect(generate).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  function renderDraft(onAdd: (input: unknown) => void, onOpenChange = vi.fn()) {
    render(
      <AgentDialog
        draft={{
          title: "Draft",
          seed: "seed",
          takenNames: [],
          roles: [],
          initial: {
            name: "Build",
            role: "Builder",
            instructions: "Ship it.",
            templateId: "builder",
          },
          onAdd,
        }}
        models={MODELS}
        onGenerate={async () => GENERATED}
        onOpenChange={onOpenChange}
        open
      />,
    );
    return { dialog: screen.getByRole("dialog"), onOpenChange };
  }

  it("group draft: Add adds the member once, even when submitted again during the exit", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const { dialog, onOpenChange } = renderDraft(onAdd);
    await user.click(within(dialog).getByRole("button", { name: "Add to group" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Still mounted (exit animation): a second click / Enter must not add a duplicate.
    await user.click(within(dialog).getByRole("button", { name: "Add to group" }));
    fireEvent.submit(form(dialog));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("group draft: nothing is added while the dialog is exiting", () => {
    presence.current = false;
    const onAdd = vi.fn();
    const { dialog, onOpenChange } = renderDraft(onAdd);
    expect(form(dialog).hasAttribute("inert")).toBe(true);
    fireEvent.submit(form(dialog));
    expect(onAdd).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("AgentDialog work types follow the role", () => {
  const roleSelect = (dialog: HTMLElement) =>
    within(dialog).getByRole("combobox", { name: "Role" }) as HTMLSelectElement;
  const workTypes = (dialog: HTMLElement) =>
    within(dialog).getByTestId("agent-work-types").textContent;
  const noLists = (payload: unknown) => {
    expect(payload).not.toHaveProperty("capabilityIds");
    expect(payload).not.toHaveProperty("supportedTaskKinds");
  };

  it("has no work type checkboxes or template button; Role offers the seven roles and Custom", () => {
    const { dialog } = renderDialog({ agent: ANA });
    expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(dialog).queryByText(/Apply capabilities/)).toBeNull();
    expect(within(dialog).queryByText(/Choose the work this agent supports/)).toBeNull();
    expect([...roleSelect(dialog).options].map((option) => option.text)).toEqual([
      "Lead",
      "Builder",
      "Reviewer",
      "Explorer",
      "Librarian",
      "Advisor",
      "Designer",
      "Custom",
    ]);
    expect(roleSelect(dialog).value).toBe("reviewer");
  });

  it("shows what the agent handles as a plain sentence", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog();
    // A new custom agent starts on Custom: no implement, review or code.
    expect(roleSelect(dialog).value).toBe("custom");
    expect(workTypes(dialog)).toBe(
      "Handles docs, research and question tasks. Researches and writes docs.",
    );
    await user.selectOptions(roleSelect(dialog), "builder");
    expect(workTypes(dialog)).toBe("Handles code tasks. Implements and verifies.");
    expect(workTypes(dialog)).not.toContain("·");
  });

  it("warns before replacing hand-picked work types, and recalculates on save", async () => {
    const user = userEvent.setup();
    const { dialog, onUpdate } = renderDialog({
      agent: { ...ANA, capabilityIds: ["verify"], supportedTaskKinds: ["code"] },
    });
    expect(workTypes(dialog)).toBe("Handles code tasks. Verifies.");
    expect(within(dialog).queryByText(CUSTOM_WORK_TYPES_WARNING)).toBeNull();
    await user.selectOptions(roleSelect(dialog), "builder");
    expect(within(dialog).getByText(CUSTOM_WORK_TYPES_WARNING)).toBeTruthy();
    expect(CUSTOM_WORK_TYPES_WARNING).toBe(
      "This agent has custom work types that will be replaced.",
    );
    expect(workTypes(dialog)).toBe("Handles code tasks. Implements and verifies.");
    // Back to the old role: nothing is replaced, no warning.
    await user.selectOptions(roleSelect(dialog), "reviewer");
    expect(within(dialog).queryByText(CUSTOM_WORK_TYPES_WARNING)).toBeNull();
    await user.selectOptions(roleSelect(dialog), "builder");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({ id: "a-1", role: "Builder" });
    noLists(onUpdate.mock.calls[0]?.[0]);
  });

  it("does not warn when the saved work types are the old role's", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog({
      agent: { ...ANA, capabilityIds: ["review"], supportedTaskKinds: ["code", "review"] },
    });
    await user.selectOptions(roleSelect(dialog), "librarian");
    expect(within(dialog).queryByText(CUSTOM_WORK_TYPES_WARNING)).toBeNull();
    expect(workTypes(dialog)).toBe(
      "Handles docs, research and question tasks. Researches and writes docs.",
    );
  });

  it("an agent saved without work types shows its template's", () => {
    const { dialog } = renderDialog({ agent: { ...ANA, role: "Builder", templateId: "builder" } });
    expect(roleSelect(dialog).value).toBe("builder");
    expect(workTypes(dialog)).toBe("Handles code tasks. Implements and verifies.");
  });

  it("a free-text role is Custom and keeps its label", async () => {
    const user = userEvent.setup();
    const { dialog, onUpdate } = renderDialog({ agent: { ...ANA, role: "Release notes" } });
    expect(roleSelect(dialog).value).toBe("custom");
    expect(field(dialog, "Custom role").value).toBe("Release notes");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({ role: "Release notes" });
  });

  it("Regenerate keeps the chosen role, so the work types never change silently", async () => {
    const user = userEvent.setup();
    // A non-template Builder with empty lists (derived as Builder).
    const { dialog, onUpdate } = renderDialog({ agent: { ...ANA, role: "Builder" } });
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(field(dialog, "Instructions").value).toBe(GENERATED.instructions));
    expect(roleSelect(dialog).value).toBe("builder");
    expect(workTypes(dialog)).toBe("Handles code tasks. Implements and verifies.");
    expect(within(dialog).queryByText(CUSTOM_WORK_TYPES_WARNING)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      role: "Builder",
      instructions: GENERATED.instructions,
    });
    cleanup();

    // A Custom agent keeps its own label too.
    const custom = renderDialog({ agent: { ...ANA, role: "Release notes" } });
    await user.click(within(custom.dialog).getByRole("button", { name: "Regenerate" }));
    await waitFor(() =>
      expect(field(custom.dialog, "Instructions").value).toBe(GENERATED.instructions),
    );
    expect(field(custom.dialog, "Custom role").value).toBe("Release notes");
  });

  it("saving without touching Role sends the stored role text unchanged", async () => {
    const user = userEvent.setup();
    for (const stored of ["Planner", "oracle", " builder "]) {
      const { dialog, onUpdate } = renderDialog({ agent: { ...ANA, role: stored } });
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
      expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({ role: stored.trim() });
      cleanup();
    }
    // A changed selection sends the role's label.
    const { dialog, onUpdate } = renderDialog({ agent: { ...ANA, role: "Planner" } });
    expect(roleSelect(dialog).value).toBe("lead");
    await user.selectOptions(roleSelect(dialog), "advisor");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({ role: "Advisor" });
  });

  it("leaving the role and coming back sends the original text and shows no warning", async () => {
    const user = userEvent.setup();
    const cases: [stored: string, away: string, back: string][] = [
      ["Planner", "advisor", "lead"],
      ["oracle", "custom", "advisor"],
      ["Release notes", "builder", "custom"],
    ];
    for (const [stored, away, back] of cases) {
      // Hand-picked lists, so leaving the role does warn.
      const { dialog, onUpdate } = renderDialog({
        agent: { ...ANA, role: stored, capabilityIds: ["verify"], supportedTaskKinds: ["code"] },
      });
      const original = roleSelect(dialog).value;
      expect(original, stored).toBe(back);
      await user.selectOptions(roleSelect(dialog), away);
      if (away !== "custom") {
        expect(within(dialog).getByText(CUSTOM_WORK_TYPES_WARNING), stored).toBeTruthy();
      }
      await user.selectOptions(roleSelect(dialog), back);
      expect(within(dialog).queryByText(CUSTOM_WORK_TYPES_WARNING), stored).toBeNull();
      expect(workTypes(dialog), stored).toBe("Handles code tasks. Verifies.");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
      expect(onUpdate.mock.calls[0]?.[0], stored).toMatchObject({ role: stored });
      cleanup();
    }
  });

  it("create and group drafts send no work lists", async () => {
    const user = userEvent.setup();
    const { dialog, create } = renderDialog();
    await user.type(field(dialog, "Name"), "Writer");
    await user.type(field(dialog, "Custom role"), "Scribe");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    noLists(create.mock.calls[0]?.[0]);
    cleanup();

    const onAdd = vi.fn();
    render(
      <AgentDialog
        open
        models={MODELS}
        onOpenChange={() => undefined}
        onGenerate={async () => GENERATED}
        draft={{
          title: "Draft",
          seed: "seed",
          takenNames: [],
          roles: [],
          initial: { name: "Build", role: "Builder", templateId: "builder" },
          onAdd,
        }}
      />,
    );
    expect(screen.getByTestId("agent-work-types").textContent).toBe(
      "Handles code tasks. Implements and verifies.",
    );
    await user.click(screen.getByRole("button", { name: "Add to group" }));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: "builder", role: "Builder" }),
    );
    noLists(onAdd.mock.calls[0]?.[0]);
  });
});

describe("AgentDialog group drafts (New group panel)", () => {
  const roleSelect = (dialog: HTMLElement) =>
    within(dialog).getByRole("combobox", { name: "Role" }) as HTMLSelectElement;
  const workTypes = (dialog: HTMLElement) =>
    within(dialog).getByTestId("agent-work-types").textContent;
  const draftDialog = (draft: Partial<Parameters<typeof AgentDialog>[0]["draft"] & object>) => {
    const onAdd = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <AgentDialog
        open
        surface="plain"
        models={MODELS}
        onOpenChange={onOpenChange}
        onGenerate={async () => GENERATED}
        draft={{ title: "Draft", seed: "seed", takenNames: [], roles: [], onAdd, ...draft }}
      />,
    );
    return { dialog: screen.getByTestId("agent-dialog"), onAdd, onOpenChange };
  };

  it("a copy shows its source's lists, and a new role recalculates with the warning", async () => {
    const user = userEvent.setup();
    const source: AgentInfo = { ...ANA, capabilityIds: ["verify"], supportedTaskKinds: ["code"] };
    const { dialog } = draftDialog({
      sourceAgent: source,
      initial: { name: "Ana 2", role: "Reviewer", copiedFromAgentId: "a-1", modelId: "m-1" },
    });
    expect(workTypes(dialog)).toBe("Handles code tasks. Verifies.");
    expect(within(dialog).queryByText(CUSTOM_WORK_TYPES_WARNING)).toBeNull();
    await user.selectOptions(roleSelect(dialog), "builder");
    expect(workTypes(dialog)).toBe("Handles code tasks. Implements and verifies.");
    expect(within(dialog).getByText(CUSTOM_WORK_TYPES_WARNING)).toBeTruthy();
  });

  it("Use Builder's defaults resets name, role, instructions and look", async () => {
    const user = userEvent.setup();
    const builder = AGENT_TEMPLATES.find((t) => t.id === "builder");
    if (!builder) throw new Error("builder template");
    const { dialog } = draftDialog({
      defaultName: "Builder 2",
      initial: {
        templateId: "builder",
        name: "Bob",
        role: "Builder",
        instructions: "Something else.",
        avatarFace: "wink",
        avatarColor: "teal",
      },
    });
    await user.clear(field(dialog, "Name"));
    await user.type(field(dialog, "Name"), "Zed");
    await user.selectOptions(roleSelect(dialog), "reviewer");
    await user.click(within(dialog).getByRole("button", { name: "Use Builder's defaults" }));
    expect(field(dialog, "Name").value).toBe("Builder 2");
    expect(roleSelect(dialog).value).toBe("builder");
    expect((screen.getByTestId("agent-instructions") as HTMLTextAreaElement).value).toBe(
      builder.instructions,
    );
  });

  it("plain edit panel: Back, Save changes, Remove from group and the footer note", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const { dialog, onAdd } = draftDialog({
      mode: "edit",
      onRemove,
      footerNote: "4 of 10",
      initial: { name: "Ana", role: "Reviewer", modelId: "m-1", templateId: "reviewer" },
    });
    expect(within(dialog).getByText("Edit agent")).toBeTruthy();
    expect(screen.getByTestId("agent-dialog-footer-note").textContent).toBe("4 of 10");
    const backs = within(dialog).getAllByRole("button", { name: "Back" });
    expect(backs).toHaveLength(2);
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ name: "Ana" })),
    );
    cleanup();
    const back = draftDialog({ mode: "edit", initial: { name: "Ana", templateId: "reviewer" } });
    await user.click(
      within(back.dialog).getAllByRole("button", { name: "Back" })[0] as HTMLElement,
    );
    expect(back.onOpenChange).toHaveBeenCalledWith(false);
    cleanup();
    const again = draftDialog({
      mode: "edit",
      onRemove,
      initial: { name: "Ana", role: "Reviewer", templateId: "reviewer" },
    });
    await user.click(within(again.dialog).getByRole("button", { name: "Remove from group" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("defaults link only in the New group panel; the standalone Edit agent dialog has none", () => {
    const builderAgent: AgentInfo = { ...ANA, name: "Bob", role: "Builder", templateId: "builder" };
    renderDialog({ agent: builderAgent });
    expect(screen.queryByRole("button", { name: /defaults$/ })).toBeNull();
    cleanup();
    draftDialog({ initial: { templateId: "builder", name: "Builder", role: "Builder" } });
    expect(screen.getByRole("button", { name: "Use Builder's defaults" })).toBeTruthy();
  });

  it("the plain panel focuses Name on open", () => {
    const { dialog } = draftDialog({ initial: { templateId: "builder", name: "Builder" } });
    expect(document.activeElement).toBe(field(dialog, "Name"));
  });
});

describe("AgentDialog profile mode", () => {
  function renderProfileDialog({
    takenNames = [],
    agent,
    models = MODELS,
    defaultModelId = "m-1",
    create = vi.fn(async (_input: NewGroupAgentInput) => undefined),
    update = vi.fn(async (_input: unknown) => undefined),
    generate = vi.fn(async (_input: GenerateAgentProfileInput) => GENERATED),
  }: {
    takenNames?: readonly string[];
    agent?: AgentInfo;
    models?: readonly PickableModel[];
    defaultModelId?: string;
    create?: ReturnType<typeof vi.fn<(input: NewGroupAgentInput) => Promise<undefined>>>;
    update?: ReturnType<typeof vi.fn<(input: unknown) => Promise<undefined>>>;
    generate?: (input: GenerateAgentProfileInput) => Promise<GeneratedAgentProfile>;
  } = {}) {
    const onOpenChange = vi.fn();
    render(
      <AgentDialog
        agent={agent}
        defaultModelId={defaultModelId}
        models={models}
        onCreate={create}
        onGenerate={generate}
        onOpenChange={onOpenChange}
        onUpdate={update}
        open
        profile={{ takenNames }}
      />,
    );
    const dialog = screen.getByRole("dialog");
    return { dialog, create, update, onOpenChange, generate };
  }

  it("profile mode create calls onCreate with no groupId", async () => {
    const user = userEvent.setup();
    const { dialog, create } = renderProfileDialog();
    expect(within(dialog).getByText("New Agent")).toBeTruthy();
    await user.type(field(dialog, "Name"), "Solo");
    await user.type(field(dialog, "Custom role"), "Scribe");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(payload.name).toBe("Solo");
    expect("groupId" in payload).toBe(false);
    expect(payload.groupId).toBeUndefined();
  });

  it("a taken name from takenNames (different case) is refused and onCreate not called", async () => {
    const user = userEvent.setup();
    const { dialog, create } = renderProfileDialog({ takenNames: ["Solo"] });
    await user.type(field(dialog, "Name"), "solo");
    await user.type(field(dialog, "Custom role"), "Scribe");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(create).not.toHaveBeenCalled();
    expect(within(dialog).getByText(GROUP_ERROR_MESSAGES["agent-name-taken"])).toBeTruthy();
  });
});
