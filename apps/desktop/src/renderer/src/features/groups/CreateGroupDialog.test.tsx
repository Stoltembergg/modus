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

afterEach(() => cleanup());

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
    expect(onSave).toHaveBeenCalledWith({ add: [], removeAgentIds: ["agent-s-ana"], lead: null });
  });

  it("replaces both members of a 2-member group in ONE save, with a new agent as lead", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_change: unknown) => undefined);
    render(
      <CreateGroupDialog
        group={{ ...GROUP, members: GROUP.members.slice(0, 2) }}
        mode="edit"
        models={MODELS}
        onOpenChange={vi.fn()}
        onSave={onSave}
        open
        workspaces={WORKSPACES}
      />,
    );
    const dialog = screen.getByRole("dialog");
    // At 2, nothing can be removed until new agents are added.
    const removeAna = within(dialog).getByRole("button", {
      name: "Remove Ana",
    }) as HTMLButtonElement;
    expect(removeAna.disabled).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Add agent" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 1 name" }), "Cy");
    await user.click(within(dialog).getByRole("button", { name: "Add agent" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Agent 2 name" }), "Di");
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "Model for new agents" }),
      "m-1",
    );
    await user.click(within(dialog).getByRole("button", { name: "Remove Ana" }));
    await user.click(within(dialog).getByRole("button", { name: "Remove Bo" }));
    const lead = within(dialog).getByRole("combobox", { name: /Lead/ }) as HTMLSelectElement;
    expect([...lead.options].map((option) => option.textContent)).toEqual(["No lead", "Cy", "Di"]);
    const di = [...lead.options].find((option) => option.textContent === "Di");
    await user.selectOptions(lead, di?.value ?? "");
    await user.click(within(dialog).getByRole("button", { name: "Save members" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      add: [
        { name: "Cy", modelId: "m-1" },
        { name: "Di", modelId: "m-1" },
      ],
      removeAgentIds: ["agent-s-ana", "agent-s-bo"],
      lead: { name: "Di" },
    });
  });

  it("shows the mapped message when the save is refused and stays open", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_change: unknown) => {
      throw new Error(
        `Error invoking remote method 'group:update-members': Error: ${encodeGroupErrorMessage("group-min-members", "A group needs at least 2 agents.")}`,
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
