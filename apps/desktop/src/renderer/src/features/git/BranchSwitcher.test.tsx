// @vitest-environment happy-dom
import { Menu } from "@base-ui/react/menu";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitBranchSummary } from "../../../../shared/contracts";
import {
  type BranchMenuGroup,
  BranchMenuGroups,
  branchMenuGroups,
  branchNameFromValue,
} from "./BranchSwitcher";

afterEach(cleanup);

const LOCALS = [
  { name: "main", current: true },
  { name: "feat/x", current: false, worktreePath: "/wt/x" },
] as GitBranchSummary["local"];
const REMOTES = [{ name: "origin/main" }] as GitBranchSummary["remote"];

function renderMenu(groups: BranchMenuGroup[], onSelect = vi.fn()) {
  render(
    <Menu.Root open>
      <Menu.Trigger>branches</Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner>
          <Menu.Popup>
            <BranchMenuGroups groups={groups} onSelect={onSelect} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>,
  );
  return onSelect;
}

describe("branchMenuGroups", () => {
  it("builds Local / Remote / Worktrees with the local:|remote:|worktree: scheme", () => {
    const groups = branchMenuGroups(LOCALS, REMOTES, "main", undefined);
    expect(groups.map((group) => group.label)).toEqual(["Local", "Remote", "Worktrees"]);
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["local:main", "local:feat/x"]);
    expect(groups[0]?.items[0]?.current).toBe(true);
    expect(groups[1]?.items[0]).toMatchObject({ value: "remote:origin/main", meta: "remote" });
    expect(groups[2]?.items[0]).toMatchObject({ value: "worktree:feat/x", meta: "linked" });
  });

  it("uses a disabled placeholder when there are no local branches", () => {
    const groups = branchMenuGroups([], REMOTES, undefined, undefined);
    expect(groups[0]?.items).toEqual([
      { value: "local:none", label: "No local branches", disabled: true },
    ]);
    expect(branchNameFromValue("local:none")).toBeUndefined();
    expect(branchNameFromValue("remote:origin/dev")).toBe("origin/dev");
    expect(branchNameFromValue("worktree:feat/x")).toBe("feat/x");
  });
});

describe("BranchMenuGroups", () => {
  it("renders the 3 groups with labels and checks the current branch", () => {
    renderMenu(branchMenuGroups(LOCALS, REMOTES, "main", undefined));
    const groups = screen.getAllByRole("group");
    expect(groups).toHaveLength(3);
    for (const [index, name] of ["Local", "Remote", "Worktrees"].entries()) {
      expect(within(groups[index] as HTMLElement).getByText(name)).toBeTruthy();
    }
    const main = screen.getByRole("menuitemradio", { name: /^main/ });
    expect(main.getAttribute("aria-checked")).toBe("true");
    const other = within(groups[0] as HTMLElement).getByRole("menuitemradio", { name: /feat\/x/ });
    expect(other.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("linked")).toBeTruthy();
  });

  it("selecting an item calls onSelect with its scheme value", async () => {
    const user = userEvent.setup();
    const onSelect = renderMenu(branchMenuGroups(LOCALS, REMOTES, "main", undefined));
    await user.click(screen.getByRole("menuitemradio", { name: /origin\/main/ }));
    expect(onSelect).toHaveBeenCalledWith("remote:origin/main");
  });

  it("the placeholder is disabled and not selectable", async () => {
    const user = userEvent.setup();
    const onSelect = renderMenu(branchMenuGroups([], REMOTES, undefined, undefined));
    const placeholder = screen.getByRole("menuitem", { name: "No local branches" });
    expect(placeholder.getAttribute("aria-disabled")).toBe("true");
    await user.click(placeholder);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("is a flat grouped menu: no tree lines, no extra svg besides the item icons", () => {
    renderMenu(branchMenuGroups(LOCALS, REMOTES, "main", undefined));
    const items = screen.getAllByRole("menuitemradio");
    expect(document.querySelectorAll("[role=menu] svg")).toHaveLength(items.length);
    expect(document.querySelector("svg line")).toBeNull();
  });
});
