// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cloneElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_FACE_SEEDS, faceForAvatarSeed } from "../../../../shared/agent-avatar-seeds";
import { CUSTOM_ROLE_CAPABILITIES, effectiveCapabilities } from "../../../../shared/agent-roles";
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
import { AGENT_AVATAR_FACES } from "../../../../shared/contracts";
import { encodeGroupErrorMessage } from "../../../../shared/group-errors";
import type { PickableModel } from "../../lib/modusModels";
import { GROUP_ERROR_MESSAGES } from "../groups/groupErrors";
import { AGENT_GENERATED_HINT, AgentDialog } from "./AgentDialog";
import { humanizeOption } from "./AvatarOptionGroup";
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
  avatarSeed: null,
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

/** One picker row (a radiogroup labelled Face / Shape / Color) and its options. */
const picker = (dialog: HTMLElement, name: "Face" | "Shape" | "Color") =>
  within(dialog).getByRole("radiogroup", { name });
const option = (dialog: HTMLElement, group: "Face" | "Shape" | "Color", name: string) =>
  within(picker(dialog, group)).getByRole("radio", { name }) as HTMLButtonElement;
const preview = (dialog: HTMLElement) =>
  within(within(dialog).getByTestId("agent-dialog-preview")).getByTestId("agent-avatar");

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

  it("generates only for a custom agent with no instructions (there is no Role field)", () => {
    expect(needsProfileGeneration({ instructions: "" }, true)).toBe(true);
    expect(needsProfileGeneration({ instructions: "  " }, true)).toBe(true);
    expect(needsProfileGeneration({ instructions: "Do X" }, true)).toBe(false);
    expect(needsProfileGeneration({ instructions: "" }, false)).toBe(false);
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

  it("has no visible title, Role field or Regenerate; the pickers have no descriptions", () => {
    const { dialog } = renderDialog();
    for (const name of ["Name", "Instructions", /What should it help with/]) {
      expect(field(dialog, name)).toBeTruthy();
    }
    expect(within(dialog).queryByRole("combobox", { name: "Role" })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: "Custom role" })).toBeNull();
    expect(within(dialog).queryByText("Role")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Regenerate/ })).toBeNull();
    expect(within(dialog).queryByTestId("agent-work-types")).toBeNull();
    // The title is kept for assistive tech only.
    expect(within(dialog).getByText("New agent").className).toContain("sr-only");
    expect(modelTrigger(dialog).dataset.value).toBe("m-2");
    expect(within(picker(dialog, "Face")).getAllByRole("radio")).toHaveLength(8);
    expect(within(picker(dialog, "Shape")).getAllByRole("radio")).toHaveLength(10);
    expect(within(picker(dialog, "Color")).getAllByRole("radio")).toHaveLength(22);
    // Tiles carry no tooltips or descriptions (only an occupied shape explains itself).
    for (const radio of within(dialog).getAllByRole("radio")) {
      expect(radio.getAttribute("title")).toBeNull();
      expect(radio.getAttribute("aria-describedby")).toBeNull();
    }
    // Footer: no divider, Create / Generate in the accent purple.
    const submit = within(dialog).getByRole("button", { name: "Generate" });
    expect(submit.className).toContain("bg-accent");
    expect(submit.parentElement?.className).not.toContain("border-t");
  });

  it("the centered 64 px preview follows face, shape and color live", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog();
    expect(preview(dialog).dataset.size).toBe("64");
    expect(preview(dialog).dataset.state).toBe("idle");
    await user.click(option(dialog, "Face", "Sleepy"));
    expect(preview(dialog).dataset.face).toBe("sleepy");
    await user.click(option(dialog, "Shape", "Hexagon"));
    expect(preview(dialog).dataset.shape).toBe("hexagon");
    await user.click(option(dialog, "Color", "Violet"));
    expect(preview(dialog).dataset.color).toBe("violet");
    expect(option(dialog, "Face", "Sleepy").getAttribute("aria-checked")).toBe("true");
    expect(option(dialog, "Color", "Violet").getAttribute("aria-checked")).toBe("true");
    // The tiles render in the chosen color and shape.
    const sleepyTile = within(option(dialog, "Face", "Sleepy")).getByTestId("agent-avatar");
    expect(sleepyTile.dataset.color).toBe("violet");
    expect(sleepyTile.dataset.shape).toBe("hexagon");
    // Exactly one purple selection ring per row.
    for (const group of ["Face", "Shape", "Color"] as const) {
      const rings = within(picker(dialog, group)).getAllByTestId("avatar-option-ring");
      expect(rings).toHaveLength(1);
      expect(rings[0]?.className).toContain("border-accent");
    }
  });

  it("the pickers are radio groups: Tab stops once, arrows / Home / End move and select", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog({ agent: { ...ANA, avatarFace: "happy" } });
    const faces = within(picker(dialog, "Face")).getAllByRole("radio");
    // Roving tabindex: only the selected option is in the Tab order.
    expect(faces.map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1]);
    // The dialog moves focus to Name first; then focus the selected face.
    await waitFor(() => expect(document.activeElement).toBe(field(dialog, "Name")));
    option(dialog, "Face", "Happy").focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(option(dialog, "Face", "Curious"));
    expect(option(dialog, "Face", "Curious").getAttribute("aria-checked")).toBe("true");
    expect(preview(dialog).dataset.face).toBe("curious");
    await user.keyboard("{ArrowDown}");
    expect(preview(dialog).dataset.face).toBe("sleepy");
    await user.keyboard("{ArrowLeft}{ArrowUp}");
    expect(preview(dialog).dataset.face).toBe("happy");
    // Wraps around, Home and End jump.
    await user.keyboard("{ArrowLeft}");
    expect(preview(dialog).dataset.face).toBe("bright");
    await user.keyboard("{Home}");
    expect(preview(dialog).dataset.face).toBe("happy");
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(option(dialog, "Face", "Bright"));
    expect(option(dialog, "Face", "Bright").tabIndex).toBe(0);
    expect(option(dialog, "Face", "Happy").tabIndex).toBe(-1);
    // Visible focus ring in the accent purple.
    expect(option(dialog, "Face", "Bright").className).toContain("focus-visible:ring-accent");
    // Colors too.
    option(dialog, "Color", "Teal").focus();
    await user.keyboard("{ArrowRight}");
    expect(preview(dialog).dataset.color).toBe("sky");
  });

  it("arrow keys skip shapes taken by another group member", async () => {
    const user = userEvent.setup();
    const [firstMember, secondMember] = GROUP.members;
    if (!firstMember || !secondMember) throw new Error("expected two group members");
    const group: AgentGroupWithMembers = {
      ...GROUP,
      members: [
        { ...firstMember, avatarShape: "triangle" },
        { ...secondMember, avatarShape: "squircle" },
      ],
    };
    const { dialog } = renderDialog({ agent: { ...ANA, avatarShape: "circle" }, group });
    await waitFor(() => expect(document.activeElement).toBe(field(dialog, "Name")));
    option(dialog, "Shape", "Circle").focus();
    await user.keyboard("{ArrowRight}");
    // Squircle is Bo's: skipped.
    expect(preview(dialog).dataset.shape).toBe("roundedSquare");
    await user.keyboard("{End}");
    expect(preview(dialog).dataset.shape).toBe("pentagon");
    await user.keyboard("{ArrowLeft}");
    // Triangle is Ana's own slot (the agent being edited): selectable.
    expect(preview(dialog).dataset.shape).toBe("triangle");
    expect(option(dialog, "Shape", "Squircle").disabled).toBe(true);
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
    expect(generate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("with empty instructions the button reads Generate; Create then saves only the generated instructions", async () => {
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
    await waitFor(() => expect(field(dialog, "Instructions").value).toBe(GENERATED.instructions));
    expect(within(dialog).getByTestId("agent-dialog-notice").textContent).toBe(
      AGENT_GENERATED_HINT,
    );
    // The generated role is shown nowhere.
    expect(within(dialog).queryByText(GENERATED.role)).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole("button", { name: "Generate" })).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(generate).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0]?.[0] as Record<string, unknown>;
    // The generated role is discarded: saved empty, so the agent is Custom.
    expect(payload).toMatchObject({
      groupId: "g-1",
      name: "Cy",
      role: "",
      instructions: GENERATED.instructions,
      modelId: "m-2",
    });
    expect(effectiveCapabilities({ role: payload.role as string })).toEqual(
      CUSTOM_ROLE_CAPABILITIES,
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("with instructions typed, Create saves without generating (role empty)", async () => {
    const user = userEvent.setup();
    const { dialog, generate, create } = renderDialog();
    await user.type(field(dialog, "Name"), "Cy");
    expect(within(dialog).getByRole("button", { name: "Generate" })).toBeTruthy();
    await user.type(field(dialog, "Instructions"), "Keep notes.");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(generate).not.toHaveBeenCalled();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ role: "", instructions: "Keep notes." });
  });

  it("the fallback fills the default instructions with the warning and never saves Generalist", async () => {
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
    await waitFor(() =>
      expect(field(dialog, "Instructions").value).toBe(AGENT_FALLBACK_INSTRUCTIONS),
    );
    const notice = within(dialog).getByTestId("agent-dialog-notice");
    expect(notice.textContent).toBe(AGENT_GENERATION_WARNING);
    expect(notice.dataset.warning).toBe("true");
    expect(create).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      role: "",
      instructions: AGENT_FALLBACK_INSTRUCTIONS,
    });
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain(AGENT_FALLBACK_ROLE);
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
    expect(field(dialog, "Instructions").value).toBe("");
    // Nothing was generated: the button still offers Generate.
    expect(within(dialog).getByRole("button", { name: "Generate" })).toBeTruthy();
  });

  it("edit: no Regenerate; Save keeps the stored role and sends the changes", async () => {
    const user = userEvent.setup();
    const { dialog, generate, onUpdate } = renderDialog({ agent: ANA });
    expect(field(dialog, "Name").value).toBe("Ana");
    expect(field(dialog, "Instructions").value).toBe("Review every diff.");
    expect(option(dialog, "Face", "Wink").getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).queryByRole("button", { name: /Regenerate/ })).toBeNull();
    await user.clear(field(dialog, "Instructions"));
    await user.type(field(dialog, "Instructions"), "Review twice.");
    await user.click(option(dialog, "Color", "Pink"));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(generate).not.toHaveBeenCalled();
    // The model did not change: it is not sent (the IPC revalidates only a changed model).
    // The face was not touched: neither the face nor the seed is sent (stored ones stay).
    expect(onUpdate).toHaveBeenCalledWith({
      id: "a-1",
      name: "Ana",
      role: "Reviewer",
      instructions: "Review twice.",
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
    const currentShape = option(dialog, "Shape", "Triangle");
    const occupiedShape = option(dialog, "Shape", "Pentagon");
    expect(currentShape.getAttribute("aria-checked")).toBe("true");
    expect(currentShape.disabled).toBe(false);
    expect(occupiedShape.disabled).toBe(true);
    expect(occupiedShape.title).toBe("Used by another agent in this group");
  });

  it("an IPC error keeps the dialog open with its message", async () => {
    const user = userEvent.setup();
    const create = vi.fn(async (_input: unknown): Promise<undefined> => {
      throw new Error(encodeGroupErrorMessage("group-max-members", "full"));
    });
    const { dialog, onOpenChange } = renderDialog({ create });
    await user.type(field(dialog, "Name"), "Cy");
    await user.type(field(dialog, "Instructions"), "Take notes.");
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
    await user.type(field(dialog, "Instructions"), "Take notes.");
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

  it("while exiting, Save, Create and Generate do nothing", async () => {
    presence.current = false;
    const generate = vi.fn(async (_input: GenerateAgentProfileInput) => GENERATED);
    const { dialog, onUpdate, onOpenChange } = renderDialog({ agent: ANA, generate });
    expect(form(dialog).hasAttribute("inert")).toBe(true);
    fireEvent.submit(form(dialog));
    cleanup();
    // A new custom agent with empty instructions (submit would Generate).
    const fresh = renderDialog({ generate });
    // The inert form is out of the accessibility tree: reach the Name input directly.
    const name = fresh.dialog.querySelector("input") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Cy" } });
    fireEvent.submit(form(fresh.dialog));
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

describe("AgentDialog keeps the stored role (no Role field)", () => {
  const noLists = (payload: unknown) => {
    expect(payload).not.toHaveProperty("capabilityIds");
    expect(payload).not.toHaveProperty("supportedTaskKinds");
  };

  it("saving an edit sends the stored role text unchanged (trimmed)", async () => {
    const user = userEvent.setup();
    for (const stored of ["Planner", "oracle", " builder ", "Release notes", ""]) {
      const { dialog, onUpdate } = renderDialog({ agent: { ...ANA, role: stored } });
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
      expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({ role: stored.trim() });
      noLists(onUpdate.mock.calls[0]?.[0]);
      cleanup();
    }
  });

  it("a new custom agent is saved with role '' and keeps Custom's capabilities", async () => {
    const user = userEvent.setup();
    const { dialog, create } = renderDialog();
    await user.type(field(dialog, "Name"), "Writer");
    await user.type(field(dialog, "Instructions"), "Write.");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0]?.[0] as { role: string };
    expect(payload.role).toBe("");
    noLists(payload);
    // What main derives for it (agents-store newAgentFields / effectiveCapabilities).
    expect(effectiveCapabilities(payload)).toEqual(CUSTOM_ROLE_CAPABILITIES);
  });

  it("a template agent keeps sending its template's role", async () => {
    const user = userEvent.setup();
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
    await user.click(screen.getByRole("button", { name: "Add to group" }));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: "builder", role: "Builder" }),
    );
    noLists(onAdd.mock.calls[0]?.[0]);
    // So main keeps the template's lists (same role as the template).
    expect(
      effectiveCapabilities({ role: "Builder", templateId: "builder" }).capabilityIds,
    ).toContain("implement");
  });

  it("editing a template agent keeps its role", async () => {
    const user = userEvent.setup();
    const { dialog, onUpdate } = renderDialog({
      agent: { ...ANA, role: "Builder", templateId: "builder" },
    });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({ role: "Builder" });
  });
});

describe("AgentDialog group drafts (New group panel)", () => {
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

  it("a copy keeps its source's role", async () => {
    const user = userEvent.setup();
    const source: AgentInfo = { ...ANA, capabilityIds: ["verify"], supportedTaskKinds: ["code"] };
    const { dialog, onAdd } = draftDialog({
      sourceAgent: source,
      initial: {
        name: "Ana 2",
        role: "Reviewer",
        instructions: "Review.",
        copiedFromAgentId: "a-1",
        modelId: "m-1",
      },
    });
    await user.click(within(dialog).getByRole("button", { name: "Add to group" }));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Ana 2", role: "Reviewer" }),
    );
  });

  it("Use Builder's defaults resets name, role, instructions and look", async () => {
    const user = userEvent.setup();
    const builder = AGENT_TEMPLATES.find((t) => t.id === "builder");
    if (!builder) throw new Error("builder template");
    const { dialog, onAdd } = draftDialog({
      defaultName: "Builder 2",
      initial: {
        templateId: "builder",
        name: "Bob",
        role: "Reviewer",
        instructions: "Something else.",
        avatarFace: "wink",
        avatarColor: "teal",
      },
    });
    await user.clear(field(dialog, "Name"));
    await user.type(field(dialog, "Name"), "Zed");
    await user.click(within(dialog).getByRole("button", { name: "Use Builder's defaults" }));
    expect(field(dialog, "Name").value).toBe("Builder 2");
    expect((screen.getByTestId("agent-instructions") as HTMLTextAreaElement).value).toBe(
      builder.instructions,
    );
    expect(preview(dialog).dataset.face).toBe(builder.avatarFace);
    expect(preview(dialog).dataset.color).toBe(builder.avatarColor);
    await user.click(within(dialog).getByRole("button", { name: "Add to group" }));
    // The role goes back to the template's too.
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: "builder", role: "Builder" }),
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
    // Kept for assistive tech, not shown.
    expect(within(dialog).getByText("New Agent").className).toContain("sr-only");
    await user.type(field(dialog, "Name"), "Solo");
    await user.type(field(dialog, "Instructions"), "Write.");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(payload.name).toBe("Solo");
    expect(payload.role).toBe("");
    expect("groupId" in payload).toBe(false);
    expect(payload.groupId).toBeUndefined();
  });

  it("a taken name from takenNames (different case) is refused and onCreate not called", async () => {
    const user = userEvent.setup();
    const { dialog, create } = renderProfileDialog({ takenNames: ["Solo"] });
    await user.type(field(dialog, "Name"), "solo");
    await user.type(field(dialog, "Instructions"), "Write.");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(create).not.toHaveBeenCalled();
    expect(within(dialog).getByText(GROUP_ERROR_MESSAGES["agent-name-taken"])).toBeTruthy();
  });
});

describe("AgentDialog avatar seed (avatar_seed)", () => {
  const seedOf = (element: HTMLElement) => element.dataset.seed;
  const faceTile = (dialog: HTMLElement, name: string) =>
    within(option(dialog, "Face", name)).getByTestId("agent-avatar");

  it("the Face picker shows the 8 full avatars (one seed each) in the current color and shape", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog();
    await user.click(option(dialog, "Shape", "Hexagon"));
    await user.click(option(dialog, "Color", "Violet"));
    const tiles = AGENT_AVATAR_FACES.map((face) => faceTile(dialog, humanizeOption(face)));
    expect(tiles.map(seedOf)).toEqual(AGENT_AVATAR_FACES.map((face) => AGENT_FACE_SEEDS[face]));
    expect(new Set(tiles.map(seedOf)).size).toBe(8);
    for (const tile of tiles) {
      expect(tile.dataset.shape).toBe("hexagon");
      expect(tile.dataset.color).toBe("violet");
    }
  });

  it("create: the preview seed is the saved avatarSeed, also after changing face before Create", async () => {
    const user = userEvent.setup();
    const { dialog, create } = renderDialog();
    // No choice yet: a default face seed, so the preview is what gets saved.
    const initial = seedOf(preview(dialog));
    expect(Object.values(AGENT_FACE_SEEDS)).toContain(initial);
    await user.click(option(dialog, "Face", "Sleepy"));
    expect(seedOf(preview(dialog))).toBe(AGENT_FACE_SEEDS.sleepy);
    await user.click(option(dialog, "Face", "Calm"));
    const shown = seedOf(preview(dialog));
    expect(shown).toBe(AGENT_FACE_SEEDS.calm);
    // The shape tiles draw the same face.
    expect(seedOf(within(option(dialog, "Shape", "Hexagon")).getByTestId("agent-avatar"))).toBe(
      shown,
    );
    await user.type(field(dialog, "Name"), "Cy");
    await user.type(field(dialog, "Instructions"), "Keep notes.");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({ avatarSeed: shown, avatarFace: "calm" });
  });

  it("create without touching the face saves the default seed shown", async () => {
    const user = userEvent.setup();
    const { dialog, create } = renderDialog();
    const shown = seedOf(preview(dialog));
    await user.type(field(dialog, "Name"), "Dee");
    await user.type(field(dialog, "Instructions"), "Write.");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0]?.[0] as { avatarSeed?: string; avatarFace?: string };
    expect(payload.avatarSeed).toBe(shown);
    expect(faceForAvatarSeed(payload.avatarSeed)).toBe(payload.avatarFace);
  });

  it("edit: the preview is avatarSeed ?? id; untouched face sends no seed or face", async () => {
    const user = userEvent.setup();
    const legacy = renderDialog({ agent: ANA });
    expect(seedOf(preview(legacy.dialog))).toBe("a-1");
    cleanup();
    const seeded: AgentInfo = { ...ANA, avatarSeed: AGENT_FACE_SEEDS.cheeky, avatarFace: "cheeky" };
    const { dialog, onUpdate } = renderDialog({ agent: seeded });
    expect(seedOf(preview(dialog))).toBe(AGENT_FACE_SEEDS.cheeky);
    await user.click(option(dialog, "Color", "Pink"));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    const payload = onUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("avatarSeed" in payload).toBe(false);
    expect("avatarFace" in payload).toBe(false);
    expect(payload.avatarColor).toBe("pink");
  });

  it("edit: changing the face sends its seed (what the preview shows)", async () => {
    const user = userEvent.setup();
    const { dialog, onUpdate } = renderDialog({ agent: ANA });
    await user.click(option(dialog, "Face", "Focused"));
    expect(seedOf(preview(dialog))).toBe(AGENT_FACE_SEEDS.focused);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      avatarSeed: AGENT_FACE_SEEDS.focused,
      avatarFace: "focused",
    });
  });

  it("a copy of an existing agent gets no seed (its face can't be picked)", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const source: AgentInfo = { ...ANA, avatarSeed: AGENT_FACE_SEEDS.bright, avatarFace: "bright" };
    render(
      <AgentDialog
        draft={{
          title: "Draft",
          seed: "copy-key",
          takenNames: [],
          roles: [],
          onAdd,
          mode: "edit",
          sourceAgent: source,
          initial: {
            name: "Ana 2",
            instructions: "Review.",
            copiedFromAgentId: "a-1",
            avatarFace: "bright",
            modelId: "m-1",
          },
        }}
        models={MODELS}
        onGenerate={async () => GENERATED}
        onOpenChange={vi.fn()}
        open
        surface="plain"
      />,
    );
    const dialog = screen.getByTestId("agent-dialog");
    // Drawn like its modal card (the draft key), never with the source's seed.
    expect(seedOf(preview(dialog))).toBe("copy-key");
    expect(option(dialog, "Face", "Calm").disabled).toBe(true);
    await user.click(option(dialog, "Face", "Bright"));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect("avatarSeed" in (onAdd.mock.calls[0]?.[0] as object)).toBe(false);
  });

  it("group draft: Add sends the previewed seed", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <AgentDialog
        defaultModelId="m-1"
        draft={{ title: "Draft", seed: "new-group:1", takenNames: [], roles: [], onAdd }}
        models={MODELS}
        onGenerate={async () => GENERATED}
        onOpenChange={vi.fn()}
        open
        surface="plain"
      />,
    );
    const dialog = screen.getByTestId("agent-dialog");
    await user.click(option(dialog, "Face", "Wink"));
    const shown = seedOf(preview(dialog));
    await user.type(field(dialog, "Name"), "Eve");
    await user.type(field(dialog, "Instructions"), "Do.");
    await user.click(within(dialog).getByRole("button", { name: /Add to group/ }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ avatarSeed: shown }));
  });
});
