// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
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
import { GroupRoomLocaleProvider } from "./groupRoomI18n";
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
  avatarSeed: null,
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
  strict = false,
} = {}) {
  const onOpenChange = vi.fn();
  const services: NewGroupServices = {
    listAgents: vi.fn(async () => agents),
    addFolder,
    generateProfile: generate,
  };
  const element = (
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
    />
  );
  // StrictMode runs state updaters twice, as the dev app does (main.tsx).
  render(strict ? <StrictMode>{element}</StrictMode> : element);
  const modal = screen.getByTestId("new-group-modal");
  return { modal, create, generate, addFolder, onOpenChange, services };
}

const createButton = (modal: HTMLElement) =>
  within(modal).getByRole("button", { name: "Create group" }) as HTMLButtonElement;
const folder = (modal: HTMLElement) =>
  within(modal).getByRole("combobox", { name: "Folder" }) as HTMLSelectElement;
const counter = (modal: HTMLElement) => within(modal).getByTestId("new-group-counter").textContent;
const hint = (modal: HTMLElement) => within(modal).getByTestId("new-group-hint").textContent;

afterEach(() => cleanup());

describe("NewGroupModal (A4 redesigned)", () => {
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

  it("has no right-hand Members column", () => {
    const { modal } = renderModal();
    expect(modal.querySelector('section[aria-label="Members"]')).toBeNull();
    expect(within(modal).queryByRole("region", { name: "Members" })).toBeNull();
    expect(within(modal).queryByRole("heading", { name: "Members" })).toBeNull();
  });

  it("collab pipeline suggestion row has no middle dot and shows Added when pipeline templates exist", async () => {
    const user = userEvent.setup();
    const { modal } = renderModal({ defaultWorkspaceId: "ws-1" });
    const pipeline = within(modal).getByTestId("collab-pipeline");
    expect(pipeline.textContent).toContain("Planner → Builder → Reviewer");
    expect(pipeline.textContent).not.toContain("·");
    expect(within(pipeline).queryByText("Added")).toBeNull();

    await user.click(pipeline);
    expect(within(pipeline).getByText("Added")).toBeTruthy();
    expect(
      within(modal)
        .getByRole("button", { name: "Planner is the lead" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("panel focus: Name on open, back to the originating card on Back / Add", async () => {
    const user = userEvent.setup();
    const { modal } = renderModal({ defaultWorkspaceId: "ws-1" });
    await user.click(within(modal).getByRole("button", { name: "Add Planner" }));
    // Edit -> Back: the same Edit button gets focus again.
    await user.click(within(modal).getByRole("button", { name: "Edit Planner" }));
    expect(document.activeElement).toBe(
      within(screen.getByTestId("agent-dialog")).getByRole("textbox", { name: "Name" }),
    );
    const backs = within(screen.getByTestId("agent-dialog")).getAllByRole("button", {
      name: "Back",
    });
    await user.click(backs[backs.length - 1] as HTMLElement);
    await waitFor(() => expect(screen.queryByTestId("agent-dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(modal).getByRole("button", { name: "Edit Planner" }),
      ),
    );
    // Customize -> Add to group: Customize is gone, focus lands in the same card.
    await user.click(within(modal).getByRole("button", { name: "Customize Reviewer" }));
    await user.click(
      within(screen.getByTestId("agent-dialog")).getByRole("button", { name: "Add to group" }),
    );
    await waitFor(() => expect(screen.queryByTestId("agent-dialog")).toBeNull());
    await waitFor(() =>
      expect(
        within(modal).getByTestId("template-card-reviewer").contains(document.activeElement),
      ).toBe(true),
    );
  });

  it("StrictMode: the pipeline's Planner really is the lead (keys are not minted inside an updater)", async () => {
    const user = userEvent.setup();
    const { modal, create } = renderModal({ defaultWorkspaceId: "ws-1", strict: true });
    // A member first, so a dangling lead key would fall back to Builder, not Planner.
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByTestId("collab-pipeline"));
    expect(
      within(modal)
        .getByRole("button", { name: "Planner is the lead" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].leadName).toBe("Planner");
  });

  it("template cards show avatar, name, role and description; template card added once shows Edit/remove/crown and hides Customize", async () => {
    const user = userEvent.setup();
    const { modal } = renderModal();
    expect(within(modal).getAllByTestId(/^template-card-/)).toHaveLength(AGENT_TEMPLATES.length);
    const card = within(modal).getByTestId("template-card-builder");
    expect(card.textContent).toContain(template("builder").description);
    expect(card.querySelector("svg")).not.toBeNull();

    // Not added yet: Customize and + Add buttons exist
    expect(within(card).getByRole("button", { name: "Customize Builder" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Add Builder" })).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: "Add Builder" }));

    // Added once: card shows member's name, crown, "Added" tag, Edit, remove, + Add another; Customize is hidden
    expect(card.dataset.selected).toBe("true");
    expect(within(card).getByText("Added")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Customize Builder" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Edit Builder" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Remove Builder" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Make Builder lead" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Add Builder" })).toBeTruthy(); // "+ Add another"
  });

  it("template card added twice shows '2 added' and two member lines", async () => {
    const user = userEvent.setup();
    const { modal, create } = renderModal({ defaultWorkspaceId: "ws-1" });
    const card = within(modal).getByTestId("template-card-builder");
    await user.click(within(card).getByRole("button", { name: "Add Builder" }));
    await user.click(within(card).getByRole("button", { name: "Add Builder" })); // Add another

    expect(within(card).getByText("2 added")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Edit Builder" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Edit Builder 2" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Remove Builder" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Remove Builder 2" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Make Builder lead" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Make Builder 2 lead" })).toBeTruthy();

    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].members.map((m) => m.name)).toEqual(["Builder", "Builder 2"]);
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

    // Adding Planner again gives Planner 2 a "Make lead" button
    await user.click(within(modal).getByRole("button", { name: "Add Planner" }));
    expect(within(modal).getByRole("button", { name: "Make Planner 2 lead" })).toBeTruthy();

    // Move lead to Builder
    await user.click(within(modal).getByRole("button", { name: "Make Builder lead" }));
    expect(within(modal).getByRole("button", { name: "Make Planner lead" })).toBeTruthy();

    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].leadName).toBe("Builder");
  });

  it("removing the lead member moves lead to the next suggested lead (Planner)", async () => {
    const user = userEvent.setup();
    const { modal, create } = renderModal({ defaultWorkspaceId: "ws-1" });
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByRole("button", { name: "Add Planner" }));
    await user.click(within(modal).getByRole("button", { name: "Add Reviewer" }));

    // Move lead to Builder
    await user.click(within(modal).getByRole("button", { name: "Make Builder lead" }));
    expect(
      within(modal)
        .getByRole("button", { name: "Builder is the lead" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    // Remove Builder -> lead moves to Planner
    await user.click(within(modal).getByRole("button", { name: "Remove Builder" }));
    expect(
      within(modal)
        .getByRole("button", { name: "Planner is the lead" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].leadName).toBe("Planner");
  });

  it("Customize opens the agent dialog prefilled in plain mode; mode is add with 'Add to group'", async () => {
    const user = userEvent.setup();
    const { modal, create } = renderModal({ defaultWorkspaceId: "ws-1" });
    await user.click(within(modal).getByRole("button", { name: "Add Reviewer" }));
    // Reviewer card is added, so its Customize is hidden; Explorer is not added, Customize Explorer is available
    await user.click(within(modal).getByRole("button", { name: "Customize Explorer" }));

    const dialog = screen.getByTestId("agent-dialog");
    expect(within(dialog).getByText("Customize agent")).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1); // No nested modal over modal!

    const name = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(name.value).toBe("Explorer");
    // No Role field: a template member keeps its template's role.
    expect(within(dialog).queryByRole("combobox", { name: "Role" })).toBeNull();

    // Submit button in add mode is "Add to group"
    await user.click(within(dialog).getByRole("button", { name: "Add to group" }));
    await waitFor(() => expect(screen.queryByTestId("agent-dialog")).toBeNull());

    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].members[1]).toMatchObject({
      templateId: "explorer",
      name: "Explorer",
      role: "Explorer",
    });
  });

  it("Edit opens the in-dialog panel (no second role=dialog) and saving replaces the member in place", async () => {
    const user = userEvent.setup();
    const { modal, create } = renderModal({ defaultWorkspaceId: "ws-1" });
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByRole("button", { name: "Add Reviewer" }));

    // Click Edit on Builder card
    await user.click(within(modal).getByRole("button", { name: "Edit Builder" }));

    const dialog = screen.getByTestId("agent-dialog");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getByText("Edit agent")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeTruthy();
    // Header back button and the footer Back.
    expect(within(dialog).getAllByRole("button", { name: "Back" })).toHaveLength(2);

    const nameInput = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(nameInput.value).toBe("Builder");
    await user.clear(nameInput);
    await user.type(nameInput, "Master Builder");

    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByTestId("agent-dialog")).toBeNull());

    // Card now displays "Master Builder"
    expect(within(modal).getByRole("button", { name: "Edit Master Builder" })).toBeTruthy();

    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].members[0]).toMatchObject({
      templateId: "builder",
      name: "Master Builder",
    });
  });

  it("Remove from group in the edit panel removes the member and returns to the list", async () => {
    const user = userEvent.setup();
    const { modal } = renderModal({ defaultWorkspaceId: "ws-1" });
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByRole("button", { name: "Add Reviewer" }));

    await user.click(within(modal).getByRole("button", { name: "Edit Builder" }));
    const dialog = screen.getByTestId("agent-dialog");
    const removeBtn = within(dialog).getByRole("button", { name: "Remove from group" });
    expect(removeBtn).toBeTruthy();

    await user.click(removeBtn);
    await waitFor(() => expect(screen.queryByTestId("agent-dialog")).toBeNull());

    expect(counter(modal)).toBe("1 of 10");
    // Builder is no longer added
    const builderCard = within(modal).getByTestId("template-card-builder");
    expect(within(builderCard).queryByText("Added")).toBeNull();
    expect(within(builderCard).getByRole("button", { name: "Customize Builder" })).toBeTruthy();
  });

  it("copied and custom members appear as cards in the Templates tab and show Added state on their tabs", async () => {
    const user = userEvent.setup();
    const { modal, create } = renderModal({ defaultWorkspaceId: "ws-1" });

    // 1. From another group tab: copy an agent
    await user.click(within(modal).getByRole("tab", { name: "From another group" }));
    await user.click(await within(modal).findByRole("button", { name: "Copy Builder from Alpha" }));

    // On "From another group" tab, copied agent row shows Added, Edit and remove, and Copy button stays
    expect(within(modal).getByText("Added")).toBeTruthy();
    expect(within(modal).getByRole("button", { name: "Edit Builder" })).toBeTruthy();
    expect(within(modal).getByRole("button", { name: "Remove Builder" })).toBeTruthy();
    expect(within(modal).getByRole("button", { name: "Copy Builder from Alpha" })).toBeTruthy();

    // 2. New agent tab: add a custom agent
    await user.click(within(modal).getByRole("tab", { name: "New agent" }));
    await user.click(within(modal).getByRole("button", { name: "New agent…" }));
    const dialog = screen.getByTestId("agent-dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Cy");
    await user.type(within(dialog).getByRole("textbox", { name: "Instructions" }), "Take notes.");
    await user.click(within(dialog).getByRole("button", { name: "Add to group" }));
    await waitFor(() => expect(screen.queryByTestId("agent-dialog")).toBeNull());

    // On "New agent" tab, custom member card shows Added, Edit, remove
    expect(within(modal).getByRole("button", { name: "Edit Cy" })).toBeTruthy();
    expect(within(modal).getByRole("button", { name: "Remove Cy" })).toBeTruthy();

    // 3. Switch to Templates tab: both copied and custom members appear as member cards FIRST in the list
    await user.click(within(modal).getByRole("tab", { name: "Templates" }));
    expect(within(modal).getByRole("button", { name: "Edit Builder" })).toBeTruthy();
    expect(within(modal).getByRole("button", { name: "Edit Cy" })).toBeTruthy();
    expect(within(modal).getByText("Copied from Alpha")).toBeTruthy();
    // The custom card's description (the tab of the same name is a role=tab).
    expect(
      within(modal)
        .getAllByText("New agent")
        .filter((node) => !node.closest('[role="tab"]')),
    ).toHaveLength(1);

    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const members = create.mock.calls[0]?.[0].members;
    expect(members).toHaveLength(2);
    expect(members?.[0]).toMatchObject({ copiedFromAgentId: "a-1", name: "Builder" });
    expect(members?.[1]).toMatchObject({ name: "Cy" });
  });

  it("New agent: Generate sends the roles chosen in the modal (no group yet), then Add to group", async () => {
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
        (within(dialog).getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement)
          .value,
      ).toBe("Write the notes."),
    );
    await user.click(within(dialog).getByRole("button", { name: "Add to group" }));
    await waitFor(() => expect(screen.queryByTestId("agent-dialog")).toBeNull());

    await user.click(createButton(modal));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const custom = create.mock.calls[0]?.[0].members[2];
    expect(custom).toMatchObject({
      name: "Cy",
      // Only the generated instructions are kept; the generated role is discarded (Custom).
      role: "",
      instructions: "Write the notes.",
      modelId: "m-2",
    });
    expect(custom).not.toHaveProperty("templateId");
  });

  it("counts N of 10: Create group is disabled at 1 and 11, enabled at 2 and 10", async () => {
    const user = userEvent.setup();
    const { modal } = renderModal({ defaultWorkspaceId: "ws-1" });
    const add = () => user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    expect(counter(modal)).toBe("0 of 10");
    await add();
    expect(counter(modal)).toBe("1 of 10");
    expect(createButton(modal).disabled).toBe(true);
    expect(hint(modal)).toBe(NEW_GROUP_HINTS.min);
    await add();
    expect(counter(modal)).toBe("2 of 10");
    expect(createButton(modal).disabled).toBe(false);
    for (let index = 0; index < 8; index += 1) await add();
    expect(counter(modal)).toBe("10 of 10");
    expect(createButton(modal).disabled).toBe(false);
    await add();
    expect(counter(modal)).toBe("11 of 10");
    expect(createButton(modal).disabled).toBe(true);
    expect(hint(modal)).toBe(NEW_GROUP_HINTS.max);
    await user.click(within(modal).getByRole("button", { name: "Remove Builder 11" }));
    expect(counter(modal)).toBe("10 of 10");
    expect(createButton(modal).disabled).toBe(false);
  });

  it("keeps ten repeated template members on ten distinct shapes", async () => {
    const user = userEvent.setup();
    const { modal } = renderModal({ defaultWorkspaceId: "ws-1" });
    for (let index = 0; index < 10; index += 1) {
      await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    }
    const card = within(modal).getByTestId("template-card-builder");
    const avatars = Array.from(card.querySelectorAll<HTMLElement>('[data-testid="agent-avatar"]'));
    // 1 header avatar + 10 member line avatars
    const lineShapes = avatars
      .slice(1)
      .map((avatar) => avatar.dataset.shape)
      .filter(Boolean);
    expect(new Set(lineShapes).size).toBe(10);
  });

  it("Create group sends ONE group:create with every member, then closes", async () => {
    const user = userEvent.setup();
    const { modal, create, onOpenChange } = renderModal({ defaultWorkspaceId: "ws-2" });
    await user.type(within(modal).getByRole("textbox", { name: "Name" }), "Release squad");
    await user.click(within(modal).getByRole("button", { name: "Add Planner" }));
    await user.click(within(modal).getByRole("button", { name: "Add Builder" }));
    await user.click(within(modal).getByRole("tab", { name: "From another group" }));
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

describe("NewGroupModal blank name in the room locale (C6)", () => {
  async function createBlank(
    locale: string | undefined,
    labels: { folder: string; add: string; create: string },
  ) {
    const user = userEvent.setup();
    const create = vi.fn(async (_input: CreateAgentGroupInput) => undefined);
    render(
      <GroupRoomLocaleProvider locale={locale}>
        <NewGroupModal
          defaultModelId="m-2"
          defaultWorkspaceId="ws-1"
          groups={[ALPHA]}
          models={MODELS}
          onCreate={create}
          onOpenChange={vi.fn()}
          open
          services={{
            listAgents: vi.fn(async () => []),
            addFolder: vi.fn(async () => null),
            generateProfile: vi.fn(async () => ({ role: "", instructions: "", generated: false })),
          }}
          workspaces={WORKSPACES}
        />
      </GroupRoomLocaleProvider>,
    );
    const modal = screen.getByTestId("new-group-modal");
    expect(within(modal).getByRole("combobox", { name: labels.folder })).toBeTruthy();
    await user.click(within(modal).getByRole("button", { name: `${labels.add} Builder` }));
    await user.click(within(modal).getByRole("button", { name: `${labels.add} Reviewer` }));
    await user.click(within(modal).getByRole("button", { name: labels.create }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    return { modal, input: create.mock.calls[0]?.[0] as CreateAgentGroupInput };
  }

  it("pt: the placeholder and the stored name are both Novo grupo", async () => {
    const { modal, input } = await createBlank("pt-BR", {
      folder: "Pasta",
      add: "Adicionar",
      create: "Criar grupo",
    });
    expect((within(modal).getByPlaceholderText("Novo grupo") as HTMLInputElement).value).toBe("");
    expect(input.name).toBe("Novo grupo");
  });

  it("zh: stores 新群组", async () => {
    const { input } = await createBlank("zh-CN", {
      folder: "文件夹",
      add: "添加",
      create: "创建群组",
    });
    expect(input.name).toBe("新群组");
  });

  it("en: stores New group (unchanged)", async () => {
    const { input } = await createBlank("en-US", {
      folder: "Folder",
      add: "Add",
      create: "Create group",
    });
    expect(input.name).toBe("New group");
  });

  it("no locale on a pt system: placeholder and stored name are New group (C6.2)", async () => {
    const spy = vi.spyOn(navigator, "language", "get").mockReturnValue("pt-BR");
    try {
      const { modal, input } = await createBlank(undefined, {
        folder: "Folder",
        add: "Add",
        create: "Create group",
      });
      expect(within(modal).getByPlaceholderText("New group")).toBeTruthy();
      expect(input.name).toBe("New group");
    } finally {
      spy.mockRestore();
    }
  });
});
