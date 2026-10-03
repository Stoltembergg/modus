import { Menu } from "@base-ui/react/menu";
import { IconCheck, IconGitBranch } from "@tabler/icons-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { GitBranchSummary } from "../../../../shared/contracts";
import { WorkingText } from "../../components/ui/WorkingText";
import { cn } from "../../lib/cn";

type BranchSwitcherProps = {
  /** Repo working dir whose branches are listed / checked out. Undefined → disabled. */
  cwd: string | undefined;
  /** Trigger inner content (icon + label + chevron). The host styles its own surface. */
  children: ReactNode;
  /** Tailwind classes for the trigger button so each surface keeps its own look. */
  triggerClassName: string;
  align?: "start" | "end";
  /** Force-disable independent of cwd (e.g. while a parent action is busy). */
  disabled?: boolean;
  /** Surface a failed checkout (uncommitted changes, etc.) to the host UI. */
  onError?: (message: string) => void;
  /** Fired after a successful checkout so the host can refresh derived views. */
  onAfterSwitch?: () => void;
  /** Fired when Git says this branch is already checked out in a linked worktree. */
  onWorktreeBranch?: (path: string, branch: string) => void;
};

/**
 * Local-branch viewer + switcher shared by the Changes panel and the workspace
 * top bar. A plain grouped Base UI menu: Local / Remote / Worktrees groups, one
 * item per branch (icon + name + optional meta), the current branch checked.
 */
export function BranchSwitcher({
  cwd,
  children,
  triggerClassName,
  align = "start",
  disabled = false,
  onError,
  onAfterSwitch,
  onWorktreeBranch,
}: BranchSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [branchState, setBranchState] = useState<
    { cwd: string; summary: GitBranchSummary } | undefined
  >();
  const [busy, setBusy] = useState<string | undefined>();
  const branches = branchState && branchState.cwd === cwd ? branchState.summary : undefined;

  const refreshBranches = useCallback(
    async (targetCwd: string, active: () => boolean = () => true) => {
      try {
        const summary = await window.modus.git.branches(targetCwd);
        if (active()) setBranchState({ cwd: targetCwd, summary });
      } catch {
        if (active()) setBranchState({ cwd: targetCwd, summary: { local: [], remote: [] } });
      }
    },
    [],
  );

  useEffect(() => {
    if (!open || !cwd) {
      return;
    }
    let active = true;
    void refreshBranches(cwd, () => active);
    return () => {
      active = false;
    };
  }, [open, cwd, refreshBranches]);

  const switchTo = useCallback(
    async (name: string): Promise<void> => {
      if (!cwd) {
        return;
      }
      setBusy(name);
      try {
        const result = await window.modus.git.checkout({ cwd, name });
        if (result.kind === "worktree" && result.worktreePath) {
          onWorktreeBranch?.(result.worktreePath, result.branch ?? name);
          return;
        }
        onAfterSwitch?.();
        setOpen(false);
      } catch (cause) {
        onError?.(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(undefined);
      }
    },
    [cwd, onAfterSwitch, onError, onWorktreeBranch],
  );

  const locals = branches?.local ?? [];
  const remotes = branches?.remote ?? [];
  const current = locals.find((branch) => branch.current)?.name ?? branches?.current;

  const groups = useMemo(
    () => branchMenuGroups(locals, remotes, current, busy),
    [locals, remotes, current, busy],
  );

  return (
    <Menu.Root onOpenChange={setOpen} open={open}>
      <Menu.Trigger className={triggerClassName} disabled={disabled || !cwd}>
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align={align} side="bottom" sideOffset={6}>
          <Menu.Popup className="origin-(--transform-origin) min-w-[260px] popup-chrome popup-motion p-2">
            {!branches ? (
              <div className="px-2.5 py-3 text-center text-2xs text-fg-faint">
                <WorkingText>Loading…</WorkingText>
              </div>
            ) : locals.length === 0 && remotes.length === 0 ? (
              <div className="px-2.5 py-3 text-center text-2xs text-fg-faint">No branches</div>
            ) : (
              <BranchMenuGroups
                groups={groups}
                onSelect={(value) => {
                  const name = branchNameFromValue(value);
                  if (!name || name === current) return;
                  void switchTo(name);
                }}
              />
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export type BranchMenuEntry = {
  /** `local:<name>` | `remote:<name>` | `worktree:<name>`. */
  value: string;
  label: string;
  meta?: string;
  current?: boolean;
  /** Placeholder rows ("No local branches") are shown but not selectable. */
  disabled?: boolean;
};

export type BranchMenuGroup = { label: "Local" | "Remote" | "Worktrees"; items: BranchMenuEntry[] };

type BranchList = GitBranchSummary["local"];
type RemoteBranchList = GitBranchSummary["remote"];

/** Builds the Local / Remote / Worktrees groups. Local always shows (with a placeholder). */
export function branchMenuGroups(
  locals: BranchList,
  remotes: RemoteBranchList,
  current: string | undefined,
  busy: string | undefined,
): BranchMenuGroup[] {
  const localItems: BranchMenuEntry[] = locals.map((branch) => {
    const meta = branch.worktreePath ? "worktree" : undefined;
    return {
      value: `local:${branch.name}`,
      label: busy === branch.name ? `${branch.name}…` : branch.name,
      ...(meta ? { meta } : {}),
      ...(branch.name === current ? { current: true } : {}),
    };
  });
  const groups: BranchMenuGroup[] = [
    {
      label: "Local",
      items:
        localItems.length > 0
          ? localItems
          : [{ value: "local:none", label: "No local branches", disabled: true }],
    },
  ];
  if (remotes.length > 0) {
    groups.push({
      label: "Remote",
      items: remotes.map((branch) => ({
        value: `remote:${branch.name}`,
        label: branch.name,
        meta: "remote",
      })),
    });
  }
  const worktrees = locals.filter((branch) => Boolean(branch.worktreePath));
  if (worktrees.length > 0) {
    groups.push({
      label: "Worktrees",
      items: worktrees.map((branch) => ({
        value: `worktree:${branch.name}`,
        label: branch.name,
        meta: "linked",
      })),
    });
  }
  return groups;
}

/** Strips the `local:|remote:|worktree:` scheme; undefined for placeholders. */
export function branchNameFromValue(value: string): string | undefined {
  if (value.endsWith(":none")) return undefined;
  const name = value.replace(/^(local|remote|worktree):/, "");
  return name || undefined;
}

/** Grouped menu body; must render inside a Base UI `Menu.Popup`. */
export function BranchMenuGroups({
  groups,
  onSelect,
}: {
  groups: BranchMenuGroup[];
  onSelect: (value: string) => void;
}) {
  return (
    <div className="flex w-[248px] flex-col gap-1">
      {groups.map((group) => (
        <Menu.Group className="flex flex-col" key={group.label}>
          <Menu.GroupLabel className="px-2 pt-1 pb-0.5 text-2xs font-medium text-fg-faint">
            {group.label}
          </Menu.GroupLabel>
          {group.items.map((item) => (
            <Menu.Item
              aria-checked={item.disabled ? undefined : Boolean(item.current)}
              className={cn(
                "flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-xs outline-none",
                "data-[highlighted]:bg-hover data-[disabled]:cursor-default data-[disabled]:text-fg-faint",
                item.current ? "text-fg" : "text-fg-muted",
              )}
              closeOnClick={false}
              data-value={item.value}
              disabled={Boolean(item.disabled)}
              key={item.value}
              label={item.label}
              onClick={() => {
                if (!item.disabled) onSelect(item.value);
              }}
              {...(item.disabled ? {} : { role: "menuitemradio" })}
            >
              <span
                aria-hidden="true"
                className="flex size-[13px] shrink-0 items-center justify-center"
              >
                {item.current ? (
                  <IconCheck size={13} stroke={2} />
                ) : (
                  <IconGitBranch size={13} stroke={1.7} />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.meta ? (
                <span className="shrink-0 text-2xs text-fg-faint">{item.meta}</span>
              ) : null}
            </Menu.Item>
          ))}
        </Menu.Group>
      ))}
    </div>
  );
}
