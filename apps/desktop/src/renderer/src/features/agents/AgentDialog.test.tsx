// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_FALLBACK_INSTRUCTIONS,
  AGENT_FALLBACK_ROLE,
  AGENT_GENERATION_WARNING,
} from "../../../../shared/agent-templates";
import type {
  AgentGroupWithMembers,
  AgentInfo,
  GenerateAgentProfileInput,
  GeneratedAgentProfile,
} from "../../../../shared/contracts";
import { encodeGroupErrorMessage } from "../../../../shared/group-errors";
import { GROUP_ERROR_MESSAGES } from "../groups/groupErrors";
import { AGENT_GENERATED_HINT, AgentDialog } from "./AgentDialog";
import { AGENT_NAME_REQUIRED, agentDialogError, needsProfileGeneration } from "./agentDialogModel";

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
}: {
  agent?: AgentInfo;
  group?: AgentGroupWithMembers;
  models?: typeof MODELS;
  generate?: (input: GenerateAgentProfileInput) => Promise<GeneratedAgentProfile>;
  create?: ReturnType<typeof vi.fn<(input: unknown) => Promise<undefined>>>;
} = {}) {
  const onUpdate = vi.fn(async (_input: unknown) => undefined);
  const onOpenChange = vi.fn();
  render(
    <AgentDialog
      agent={agent}
      defaultModelId="m-2"
      group={group}
      models={models}
      onCreate={create}
      onGenerate={generate}
      onOpenChange={onOpenChange}
      onUpdate={onUpdate}
      open
    />,
  );
  const dialog = screen.getByRole("dialog");
  return { dialog, generate, create, onUpdate, onOpenChange };
}

const field = (dialog: HTMLElement, name: string | RegExp) =>
  within(dialog).getByRole("textbox", { name }) as HTMLInputElement;

afterEach(() => cleanup());

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
  it("shows every field with a 48 px animated preview that follows face and color", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog();
    for (const name of ["Name", "Role", "Instructions", /What should it help with/]) {
      expect(field(dialog, name)).toBeTruthy();
    }
    expect(
      (within(dialog).getByRole("combobox", { name: "Model" }) as HTMLSelectElement).value,
    ).toBe("m-2");
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
    await waitFor(() => expect(field(dialog, "Role").value).toBe(GENERATED.role));
    expect(field(dialog, "Instructions").value).toBe(GENERATED.instructions);
    expect(within(dialog).getByTestId("agent-dialog-notice").textContent).toBe(
      AGENT_GENERATED_HINT,
    );
    expect(create).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole("button", { name: "Generate" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeTruthy();

    await user.clear(field(dialog, "Role"));
    await user.type(field(dialog, "Role"), "Scribe");
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
    await user.type(field(dialog, "Role"), "Scribe");
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
    await waitFor(() => expect(field(dialog, "Role").value).toBe(AGENT_FALLBACK_ROLE));
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
    expect(field(dialog, "Role").value).toBe("");
    // Nothing was generated: the button still offers Generate.
    expect(within(dialog).getByRole("button", { name: "Generate" })).toBeTruthy();
  });

  it("edit: Regenerate replaces role + instructions (excluding itself); Save sends the changes", async () => {
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
    await waitFor(() => expect(field(dialog, "Role").value).toBe(GENERATED.role));
    await user.click(within(dialog).getByRole("button", { name: "Color pink" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    // The model did not change: it is not sent (the IPC revalidates only a changed model).
    expect(onUpdate).toHaveBeenCalledWith({
      id: "a-1",
      name: "Ana",
      role: GENERATED.role,
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
    await user.type(field(dialog, "Role"), "Scribe");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe(
        GROUP_ERROR_MESSAGES["group-max-members"],
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("a template agent may use the app default model and has no Regenerate", () => {
    const { dialog } = renderDialog({
      agent: (({ modelId: _modelId, ...rest }) => ({ ...rest, templateId: "reviewer" }))(ANA),
    });
    const model = within(dialog).getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
    expect(model.value).toBe("");
    expect(model.options[0]?.textContent).toBe("App default");
    expect(within(dialog).queryByRole("button", { name: "Regenerate" })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: /What should it help with/ })).toBeNull();
  });
});
