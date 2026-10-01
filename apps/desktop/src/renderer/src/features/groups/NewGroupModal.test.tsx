// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_TEMPLATES, getAgentTemplate } from "../../../../shared/agent-templates";
import type {
  AgentGroupWithMembers,
  AgentInfo,
  CreateAgentGroupInput,
  GenerateAgentProfileInput,
  GeneratedAgentProfile,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import { encodeGroupErrorMessage } from "../../../../shared/group-errors";
import { GROUP_ERROR_MESSAGES } from "./groupErrors";
import { NewGroupModal, type NewGroupServices } from "./NewGroupModal";
import { NEW_GROUP_HINTS } from "./newGroupModel";

const workspace = (id: string, displayName: string, extra: Partial<WorkspaceInfo> = {}) => ({
  id,
  rootPath: `/${id}`,
  displayName,
  isGitRepository: true,
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
  pinned: false,
  ...extra,
});

const WORKSPACES: WorkspaceInfo[] = [
  workspace("chats", "Chats", { inbox: true }),
  workspace("ws-1", "Repo"),
  workspace("ws-2", "Docs"),
];

const MODELS = [
  { id: "m-1", name: "Model 1" },
  { id: "m-2", name: "Model 2" },
];

const ALPHA: AgentGroupWithMembers = {
  id: "g-alpha",
  name: "Alpha",
  workspaceId: "ws-1",
  mode: "free",
  members: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const agent = (id: string, name: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  groupId: "g-alpha",
  name,
  role: "Fixer",
  instructions: "Fix what breaks.",
  modelId: "m-1",
  avatarFace: "cheeky",
  avatarColor: "red",
  avatarShape: "circle",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const template = (id: string) => {
  const found = getAgentTemplate(id);
  if (!found) throw new Error(id);
  return found;
};

function renderModal({
  create = vi.fn(async (_input: CreateAgentGroupInput) => undefined),
  agents = [agent("a-1", "Builder", { templateId: "builder" }), agent("a-2", "Zed")],
  generate = vi.fn(
    async (_input: GenerateAgentProfileInput): Promise<GeneratedAgentProfile> => ({
      role: "Release writer",
      instructions: "Write the notes.",
      generated: true,
    }),
  ),
  addFolder = vi.fn(async () => null as WorkspaceInfo | null),
  defaultWorkspaceId = null as string | null,
} = {}) {
  const onOpenChange = vi.fn();
  const services: NewGroupServices = {
    listAgents: vi.fn(async () => agents),
    addFolder,
    generateProfile: generate,
  };
  render(
    <NewGroupModal
      defaultModelId="m-2"
      defaultWorkspaceId={defaultWorkspaceId}
      groups={[ALPHA]}
      models={MODELS}
      onCreate={create}
      onOpenChange={onOpenChange}
      open
      services={services}
      workspaces={WORKSPACES}
    />,
  );
  const modal = screen.getByTestId("new-group-modal");
  return { modal, create, generate, addFolder, onOpenChange, services };
}

const createButton = (modal: HTMLElement) =>
  within(modal).getByRole("button", { name: "Create" }) as HTMLButtonElement;
const folder = (modal: HTMLElement) =>
  within(modal).getByRole("combobox", { name: "Folder" }) as HTMLSelectElement;
const memberNames = (modal: HTMLElement) =>
  within(modal)
    .getAllByRole("textbox", { name: /^Name of member / })
    .map((input) => (input as HTMLInputElement).value);
const counter = (modal: HTMLElement) => within(modal).getByTestId("new-group-counter").textContent;
const hint = (modal: HTMLElement) => within(modal).getByTestId("new-group-hint").textContent;

afterEach(() => cleanup());

describe("NewGroupModal (A4)", () => {
  it("the folder comes first and is required: Projects plus Add folder…, never Chats", async () => {
    const user = userEvent.setup();
    const added = workspace("ws-3", "New repo");
    const { modal, addFolder } = renderModal({ addFolder: vi.fn(async () => added) });
    const options = Array.from(folder(modal).options).map((option) => option.textContent);
    expect(options).toEqual(["Choose a folder", "Repo", "Docs", "Add folder…"]);
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByRole("button", { name: "Add Reviewer" }));
    expect(createButton(modal).disabled).toBe(true);
    expect(hint(modal)).toBe(NEW_GROUP_HINTS.folder);

    await user.selectOptions(folder(modal), "__add_folder__");
    expect(addFolder).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(folder(modal).value).toBe("ws-3"));
    expect(createButton(modal).disabled).toBe(false);
    await user.selectOptions(folder(modal), "ws-2");
    expect(folder(modal).value).toBe("ws-2");
  });

  it("template cards show avatar, name, role and description; multi-select repeats with a suffix", async () => {
    const user = userEvent.setup();
    const { modal } = renderModal();
    expect(within(modal).getAllByTestId(/^template-card-/)).toHaveLength(AGENT_TEMPLATES.length);
    const card = within(modal).getByTestId("template-card-builder");
    expect(card.textContent).toContain(template("builder").description);
    expect(card.querySelector("svg")).not.toBeNull();
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByRole("button", { name: "Add Explorer" }));
    expect(memberNames(modal)).toEqual(["Builder", "Builder 2", "Explorer"]);
    expect(card.dataset.selected).toBe("true");
    expect(card.textContent).toContain("×2");
    // The suffixed name is editable.
    const second = within(modal).getByRole("textbox", { name: "Name of member 2" });
    await user.clear(second);
    await user.type(second, "Bea");
    expect(memberNames(modal)).toEqual(["Builder", "Bea", "Explorer"]);
  });

  it("a suggestedLead template comes in as Lead; the lead can be changed", async () => {
    const user = userEvent.setup();
    const { modal, create } = renderModal({ defaultWorkspaceId: "ws-1" });
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByRole("button", { name: "Add Planner" }));
    expect(
      within(modal)
        .getByRole("button", { name: "Planner is the lead" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // A second suggested lead does not steal it.
    await user.click(within(modal).getByRole("button", { name: "Add Planner" }));
    expect(within(modal).getByRole("button", { name: "Make Planner 2 lead" })).toBeTruthy();
    await user.click(within(modal).getByRole("button", { name: "Make Builder lead" }));
    expect(within(modal).getByRole("button", { name: "Make Planner lead" })).toBeTruthy();
    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].leadName).toBe("Builder");
  });

  it("copy-only and custom members auto-assign Lead so Create always sends leadName", async () => {
    const user = userEvent.setup();
    const { modal, create } = renderModal({ defaultWorkspaceId: "ws-1" });
    await user.click(within(modal).getByRole("tab", { name: "Copy from another group" }));
    await user.click(await within(modal).findByRole("button", { name: "Copy Builder from Alpha" }));
    await user.click(await within(modal).findByRole("button", { name: "Copy Zed from Alpha" }));
    expect(
      within(modal)
        .getByRole("button", { name: "Builder is the lead" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(within(modal).getByRole("button", { name: "Make Zed lead" }));
    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].leadName).toBe("Zed");
  });

  it("template-only creates without suggestedLead still default Lead to the first member", async () => {
    const user = userEvent.setup();
    const { modal, create } = renderModal({ defaultWorkspaceId: "ws-1" });
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByRole("button", { name: "Add Explorer" }));
    expect(
      within(modal)
        .getByRole("button", { name: "Builder is the lead" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].leadName).toBe("Builder");
  });

  it("Customize opens the agent dialog prefilled; the edited copy keeps its templateId", async () => {
    const user = userEvent.setup();
    const { modal, create } = renderModal({ defaultWorkspaceId: "ws-1" });
    await user.click(within(modal).getByRole("button", { name: "Add Reviewer" }));
    await user.click(within(modal).getByRole("button", { name: "Customize Reviewer" }));
    const dialog = screen.getByTestId("agent-dialog");
    expect(within(dialog).getByText("Customize agent")).toBeTruthy();
    const name = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(name.value).toBe("Reviewer 2");
    const role = within(dialog).getByRole("textbox", { name: "Role" }) as HTMLInputElement;
    expect(role.value).toBe(template("reviewer").role);
    expect(
      (within(dialog).getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value,
    ).toBe(template("reviewer").instructions);
    await user.clear(role);
    await user.type(role, "Security reviewer");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByTestId("agent-dialog")).toBeNull());
    expect(memberNames(modal)).toEqual(["Reviewer", "Reviewer 2"]);
    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].members[1]).toMatchObject({
      templateId: "reviewer",
      name: "Reviewer 2",
      role: "Security reviewer",
    });
    // A template on the app default model sends no modelId.
    expect(create.mock.calls[0]?.[0].members[1]).not.toHaveProperty("modelId");
  });

  it("Copy from another group adds an independent normal member (no templateId), suffixing a taken name", async () => {
    const user = userEvent.setup();
    const { modal, create } = renderModal({ defaultWorkspaceId: "ws-1" });
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByRole("tab", { name: "Copy from another group" }));
    await user.click(await within(modal).findByRole("button", { name: "Copy Builder from Alpha" }));
    expect(memberNames(modal)).toEqual(["Builder", "Builder 2"]);
    expect(
      within(modal)
        .getAllByTestId("new-group-member-source")
        .map((node) => node.textContent),
    ).toEqual(["Template", "Copy"]);
    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const copy = create.mock.calls[0]?.[0].members[1];
    // The source is a template agent: the copy still carries no templateId.
    expect(copy).toEqual({
      name: "Builder 2",
      role: "Fixer",
      instructions: "Fix what breaks.",
      modelId: "m-1",
      avatarFace: "cheeky",
      avatarColor: "red",
    });
  });

  it("New agent: Generate sends the roles chosen in the modal (no group yet), then Add", async () => {
    const user = userEvent.setup();
    const { modal, generate, create } = renderModal({ defaultWorkspaceId: "ws-1" });
    await user.click(within(modal).getByRole("button", { name: "Add Planner" }));
    await user.click(within(modal).getByRole("button", { name: "Add Reviewer" }));
    await user.click(within(modal).getByRole("tab", { name: "New agent" }));
    await user.click(within(modal).getByRole("button", { name: "New agent…" }));
    const dialog = screen.getByTestId("agent-dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Cy");
    await user.click(within(dialog).getByRole("button", { name: "Generate" }));
    expect(generate).toHaveBeenCalledWith({
      roles: ["Lead", "Reviewer"],
      modelId: "m-2",
      name: "Cy",
    });
    await waitFor(() =>
      expect(
        (within(dialog).getByRole("textbox", { name: "Role" }) as HTMLInputElement).value,
      ).toBe("Release writer"),
    );
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByTestId("agent-dialog")).toBeNull());
    expect(memberNames(modal)).toEqual(["Planner", "Reviewer", "Cy"]);
    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const custom = create.mock.calls[0]?.[0].members[2];
    expect(custom).toMatchObject({
      name: "Cy",
      role: "Release writer",
      instructions: "Write the notes.",
      modelId: "m-2",
    });
    expect(custom).not.toHaveProperty("templateId");
  });

  it("counts N/10: Create is disabled at 1 and 11, enabled at 2 and 10", async () => {
    const user = userEvent.setup();
    const { modal } = renderModal({ defaultWorkspaceId: "ws-1" });
    const add = () => user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    expect(counter(modal)).toBe("0/10");
    await add();
    expect(counter(modal)).toBe("1/10");
    expect(createButton(modal).disabled).toBe(true);
    expect(hint(modal)).toBe(NEW_GROUP_HINTS.min);
    await add();
    expect(counter(modal)).toBe("2/10");
    expect(createButton(modal).disabled).toBe(false);
    for (let index = 0; index < 8; index += 1) await add();
    expect(counter(modal)).toBe("10/10");
    expect(createButton(modal).disabled).toBe(false);
    await add();
    expect(counter(modal)).toBe("11/10");
    expect(createButton(modal).disabled).toBe(true);
    expect(hint(modal)).toBe(NEW_GROUP_HINTS.max);
    await user.click(within(modal).getByRole("button", { name: "Remove Builder 11" }));
    expect(counter(modal)).toBe("10/10");
    expect(createButton(modal).disabled).toBe(false);
  });

  it("Create sends ONE group:create with every member, then closes", async () => {
    const user = userEvent.setup();
    const { modal, create, onOpenChange } = renderModal({ defaultWorkspaceId: "ws-2" });
    await user.type(within(modal).getByRole("textbox", { name: "Name" }), "Release squad");
    await user.click(within(modal).getByRole("button", { name: "Add Planner" }));
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByRole("tab", { name: "Copy from another group" }));
    await user.click(await within(modal).findByRole("button", { name: "Copy Zed from Alpha" }));
    await user.click(createButton(modal));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(create).toHaveBeenCalledTimes(1);
    const input = create.mock.calls[0]?.[0];
    expect(Object.keys(input ?? {}).sort()).toEqual(["leadName", "members", "name", "workspaceId"]);
    expect(input).toMatchObject({
      name: "Release squad",
      workspaceId: "ws-2",
      leadName: "Planner",
    });
    expect(input?.members.map((member) => member.templateId ?? null)).toEqual([
      "planner",
      "builder",
      null,
    ]);
  });

  it.each([
    "group-project-required",
    "group-min-members",
    "group-max-members",
    "agent-name-taken",
    "agent-model-required",
    "agent-model-unavailable",
  ] as const)("shows %s inline and stays open", async (code) => {
    const user = userEvent.setup();
    const create = vi.fn(async (_input: CreateAgentGroupInput) => {
      throw new Error(encodeGroupErrorMessage(code, "refused"));
    });
    const { modal, onOpenChange } = renderModal({ create, defaultWorkspaceId: "ws-1" });
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByRole("button", { name: "Add Reviewer" }));
    await user.click(createButton(modal));
    await waitFor(() =>
      expect(within(modal).getByRole("alert").textContent).toBe(GROUP_ERROR_MESSAGES[code]),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByTestId("new-group-modal")).toBeTruthy();
    expect(createButton(modal).disabled).toBe(false);
  });
});
