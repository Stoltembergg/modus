// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionInfo, WorkspaceInfo } from "../../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../../shared/contracts";
import { CreateGroupDialog } from "./CreateGroupDialog";

function session(id: string, overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
  return {
    id,
    workspaceId: "ws-1",
    title: `Chat ${id}`,
    cwd: "/repo",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

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

const SESSIONS = [
  session("a"),
  session("b"),
  session("taken"),
  session("child", { parentSessionId: "a" }),
  session("old", { archivedAt: "2026-01-02T00:00:00.000Z" }),
  session("inbox", { workspaceId: CHATS_WORKSPACE_ID }),
];

function renderDialog(onCreate = vi.fn(async () => undefined), onOpenChange = vi.fn()) {
  render(
    <CreateGroupDialog
      memberSessionIds={new Set(["taken"])}
      onCreate={onCreate}
      onOpenChange={onOpenChange}
      open
      sessions={SESSIONS}
      workspaces={WORKSPACES}
    />,
  );
  return { onCreate, onOpenChange, dialog: screen.getByRole("dialog") };
}

afterEach(() => cleanup());

describe("CreateGroupDialog", () => {
  it("shows name, Project, members and lead in that order, defaulting to no Project", () => {
    const { dialog } = renderDialog();
    const text = dialog.textContent ?? "";
    const order = ["Name", "Project", "Members", "Lead"].map((label) => text.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(within(dialog).getByRole("combobox", { name: "Project" })).toHaveProperty("value", "");
    // No Project: only chats without a folder are offered.
    expect(
      within(dialog)
        .getAllByRole("checkbox")
        .map((box) => box.closest("label")?.textContent),
    ).toEqual(["Chat inbox"]);
  });

  it("lists only eligible chats of the chosen Project and picks the lead among checked members", async () => {
    const user = userEvent.setup();
    const { dialog, onCreate, onOpenChange } = renderDialog();
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Project" }), "ws-1");

    const labels = within(dialog)
      .getAllByRole("checkbox")
      .map((box) => box.closest("label")?.textContent);
    expect(labels).toEqual(["Chat a", "Chat b"]);

    const lead = within(dialog).getByRole("combobox", { name: "Lead" }) as HTMLSelectElement;
    expect(lead.disabled).toBe(true);
    await user.click(within(dialog).getByRole("checkbox", { name: "Chat a" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Chat b" }));
    expect([...lead.options].map((option) => option.textContent)).toEqual([
      "No lead",
      "Chat a",
      "Chat b",
    ]);
    await user.selectOptions(lead, "b");
    // Unchecking the lead clears it.
    await user.click(within(dialog).getByRole("checkbox", { name: "Chat b" }));
    expect(lead.value).toBe("");
    await user.click(within(dialog).getByRole("checkbox", { name: "Chat b" }));
    await user.selectOptions(lead, "a");

    const create = within(dialog).getByRole("button", { name: "Create group" });
    expect(create).toHaveProperty("disabled", true);
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "  Crew ");
    await user.click(create);

    expect(onCreate).toHaveBeenCalledWith({
      name: "Crew",
      workspaceId: "ws-1",
      members: [{ sessionId: "a" }, { sessionId: "b" }],
      leadSessionId: "a",
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("keeps the dialog open and shows the store error when creation fails", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'group:create': GroupStoreError: Session b is already a member of a group.",
      );
    });
    const { dialog, onOpenChange } = renderDialog(onCreate);
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Crew");
    await user.click(within(dialog).getByRole("checkbox", { name: "Chat inbox" }));
    await user.click(within(dialog).getByRole("button", { name: "Create group" }));

    expect(await within(dialog).findByRole("alert")).toHaveProperty(
      "textContent",
      "Session b is already a member of a group.",
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
