// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGroupWithMembers, WorkspaceInfo } from "../../../../shared/contracts";
import { encodeGroupErrorMessage } from "../../../../shared/group-errors";
import { CreateGroupDialog } from "./CreateGroupDialog";

const WORKSPACES: WorkspaceInfo[] = [
  {
    id: "ws-1",
    rootPath: "/repo",
    displayName: "Repo",
    isGitRepository: true,
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    pinned: false,
  },
];

const MODELS = [
  { id: "m-1", name: "Model 1" },
  { id: "m-2", name: "Model 2" },
];

function renderDialog(
  onCreate = vi.fn(async (_input: unknown) => undefined),
  onOpenChange = vi.fn(),
) {
  render(
    <CreateGroupDialog
      defaultModelId="m-2"
      models={MODELS}
      onCreate={onCreate}
      onOpenChange={onOpenChange}
      open
      workspaces={WORKSPACES}
    />,
  );
  return { onCreate, onOpenChange, dialog: screen.getByRole("dialog") };
}

afterEach(() => cleanup());

describe("CreateGroupDialog", () => {
  it("shows name, Project, agents and lead; a Project is required (no 'No project')", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog();
    const text = dialog.textContent ?? "";
    const order = ["Name", "Project", "Agents", "Lead"].map((label) => text.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    const project = within(dialog).getByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    expect(project.value).toBe("");
    expect([...project.options].map((option) => option.textContent)).toEqual([
      "Choose a project",
      "Repo",
    ]);
    // Two agent rows to start; the model defaults to the app default.
    expect(within(dialog).getAllByRole("textbox", { name: /Agent \d name/ })).toHaveLength(2);
    expect(
      (within(dialog).getByRole("combobox", { name: "Model for new agents" }) as HTMLSelectElement)
        .value,
    ).toBe("m-2");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Crew");
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 1 name" }), "Ana");
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 2 name" }), "Bo");
    const create = within(dialog).getByRole("button", {
      name: "Create group",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(within(dialog).getByText("Choose a project for the group.")).toBeTruthy();
    await user.selectOptions(project, "ws-1");
    expect(create.disabled).toBe(false);
  });

  it("creates the group with its new agents and the lead by name", async () => {
    const user = userEvent.setup();
    const { dialog, onCreate, onOpenChange } = renderDialog();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), " Crew ");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Project" }), "ws-1");
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 1 name" }), "Ana");
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 1 role" }), "Planner");
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 2 name" }), "Bo");
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "Model for new agents" }),
      "m-1",
    );
    const lead = within(dialog).getByRole("combobox", { name: /Lead/ }) as HTMLSelectElement;
    await user.selectOptions(
      lead,
      [...lead.options].find((option) => option.textContent === "Ana")?.value ?? "",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create group" }));
    expect(onCreate).toHaveBeenCalledWith({
      name: "Crew",
      workspaceId: "ws-1",
      members: [
        { name: "Ana", role: "Planner", modelId: "m-1" },
        { name: "Bo", modelId: "m-1" },
      ],
      leadName: "Ana",
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("needs 2..10 agents with different names", async () => {
    const user = userEvent.setup();
    const { dialog } = renderDialog();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Crew");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Project" }), "ws-1");
    const create = within(dialog).getByRole("button", {
      name: "Create group",
    }) as HTMLButtonElement;
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 1 name" }), "Ana");
    expect(create.disabled).toBe(true);
    expect(within(dialog).getByText("A group needs at least 2 agents.")).toBeTruthy();
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 2 name" }), "ana");
    expect(create.disabled).toBe(true);
    expect(within(dialog).getByText("Each agent needs a different name.")).toBeTruthy();
    await user.clear(within(dialog).getByRole("textbox", { name: "Agent 2 name" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 2 name" }), "Bo");
    expect(create.disabled).toBe(false);
    const add = within(dialog).getByRole("button", { name: "Add agent" }) as HTMLButtonElement;
    for (let index = 3; index <= 10; index += 1) {
      await user.click(add);
      await user.type(
        within(dialog).getByRole("textbox", { name: `Agent ${index} name` }),
        `A${index}`,
      );
    }
    // Ten agents: no 11th row.
    expect(add.disabled).toBe(true);
    expect(create.disabled).toBe(false);
  });

  it("keeps the dialog open and shows the store error when creation fails", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async (_input: unknown) => {
      throw new Error(
        `Error invoking remote method 'group:create': Error: ${encodeGroupErrorMessage("agent-model-unavailable", "Model not available: m-1")}`,
      );
    });
    const { dialog, onOpenChange } = renderDialog(onCreate);
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Crew");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Project" }), "ws-1");
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 1 name" }), "Ana");
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 2 name" }), "Bo");
    await user.click(within(dialog).getByRole("button", { name: "Create group" }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty(
      "textContent",
      "That model is not available. Connect its provider or choose another.",
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("CreateGroupDialog in edit mode (Manage members)", () => {
  const member = (sessionId: string, name: string) => ({
    groupId: "g-1",
    sessionId,
    agentId: `agent-${sessionId}`,
    name,
    agentRole: "",
    joinedAt: "2026-01-01T00:00:00.000Z",
  });
  const GROUP: AgentGroupWithMembers = {
    id: "g-1",
    name: "Squad",
    workspaceId: "ws-1",
    mode: "free",
    leadSessionId: "s-ana",
    members: [member("s-ana", "Ana"), member("s-bo", "Bo"), member("s-cy", "Cy")],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  function renderEdit(onSave = vi.fn(async (_change: unknown) => undefined)) {
    render(
      <CreateGroupDialog
        group={GROUP}
        mode="edit"
        models={MODELS}
        onOpenChange={vi.fn()}
        onSave={onSave}
        open
        workspaces={WORKSPACES}
      />,
    );
    return { onSave, dialog: screen.getByRole("dialog") };
  }

  it("removes members (deleting their agents) down to 2 and keeps the Project fixed", async () => {
    const user = userEvent.setup();
    const { dialog, onSave } = renderEdit();
    expect(within(dialog).getByText("Squad · Repo")).toBeTruthy();
    expect(within(dialog).queryByRole("combobox", { name: "Project" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Remove Ana" }));
    // Two left: the others can no longer be removed.
    expect(
      (within(dialog).getByRole("button", { name: "Remove Bo" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Save members" }));
    // The removed lead is dropped.
    expect(onSave).toHaveBeenCalledWith({
      add: [],
      removeSessionIds: ["s-ana"],
      leadSessionId: null,
    });
  });

  it("shows the mapped message when the save is refused and stays open", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_change: unknown) => {
      throw new Error(
        `Error invoking remote method 'group:remove-member': Error: ${encodeGroupErrorMessage("group-min-members", "A group needs at least 2 agents.")}`,
      );
    });
    const { dialog } = renderEdit(onSave);
    await user.click(within(dialog).getByRole("button", { name: "Remove Cy" }));
    await user.click(within(dialog).getByRole("button", { name: "Save members" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe(
        "A group needs at least 2 agents.",
      ),
    );
  });
});
