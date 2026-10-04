import { Menu } from "@base-ui/react/menu";
import { IconAlertTriangle, IconChevronDown, IconGitBranch } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitBranchSummary, SessionBranchState } from "../../../../shared/contracts";
import { WorkingText } from "../../components/ui/WorkingText";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { useComposerToolbarTier } from "../composer/composerToolbarTier";
import {
  MODEL_CHIP_BASE,
  MODEL_CHIP_INTERACTIVE,
  MODEL_CHIP_TONE,
} from "../composer/modelChipStyle";
import { BranchMenuGroups, branchMenuGroups, branchNameFromValue } from "./BranchSwitcher";

export const BRANCH_BUSY_TOOLTIP = "Disponível quando o agente terminar";

type SessionBranchPickerProps = {
  sessionId: string;
  /** Only used to LIST branches (read-only). Switching sends the name; main resolves cwd. */
  cwd: string | undefined;
  isRunning: boolean;
  /** True while the saved branch no longer exists: the host blocks sending. */
  onBlockedChange?(blocked: boolean): void;
  onError?(message: string): void;
};

/**
 * L2 composer branch picker: the branch is SESSION state. The renderer sends only the
 * branch name (`agent.setBranch`); the main process validates it against the repo's local
 * branches / worktrees, uses the session's own cwd, refuses while a run is active or the
 * worktree has uncommitted changes, and logs "Branch alterada para X" in the timeline.
 */
export function SessionBranchPicker({
  sessionId,
  cwd,
  isRunning,
  onBlockedChange,
  onError,
}: SessionBranchPickerProps) {
  const [state, setState] = useState<SessionBranchState | undefined>();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<GitBranchSummary | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  // L3c: the composer toolbar's width tier; `sm` = compact chip (icon + short name).
  const tier = useComposerToolbarTier();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState(await window.modus.agent.branchState(sessionId));
    } catch {
      setState(undefined);
    }
  }, [sessionId]);

  // Re-read when the session changes and when a run starts / ends (the run may adopt HEAD).
  // biome-ignore lint/correctness/useExhaustiveDependencies: isRunning is a refresh trigger.
  useEffect(() => {
    void refresh();
  }, [refresh, isRunning]);

  useEffect(() => {
    onBlockedChange?.(state?.exists === false);
  }, [state?.exists, onBlockedChange]);

  useEffect(() => {
    if (!open || !cwd) return;
    let active = true;
    void window.modus.git
      .branches(cwd)
      .then((next: GitBranchSummary) => {
        if (active) setSummary(next);
      })
      .catch(() => {
        if (active) setSummary({ local: [], remote: [] });
      });
    return () => {
      active = false;
    };
  }, [open, cwd]);

  const select = useCallback(
    async (name: string): Promise<void> => {
      setBusy(name);
      try {
        setState(await window.modus.agent.setBranch({ sessionId, branch: name }));
        setOpen(false);
      } catch (cause) {
        onError?.(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(undefined);
      }
    },
    [sessionId, onError],
  );

  const current = state?.branch;
  const groups = useMemo(
    // Local branches only: the session never switches to a remote ref from the composer.
    () => branchMenuGroups(summary?.local ?? [], [], current, busy),
    [summary, current, busy],
  );
  const missing = state?.exists === false;
  const disabled = isRunning || !cwd || !state;
  const title = isRunning
    ? BRANCH_BUSY_TOOLTIP
    : missing
      ? `A branch "${current}" não existe mais. Escolha outra antes de enviar.`
      : current
        ? `Branch da sessão: ${current}`
        : "Sem branch";

  return (
    <Menu.Root onOpenChange={setOpen} open={open && !disabled}>
      {/* The wrapper keeps the tooltip visible while the trigger is disabled. */}
      <span className="inline-flex min-w-0" title={title}>
        <Menu.Trigger
          aria-label={isRunning ? BRANCH_BUSY_TOOLTIP : "Choose branch"}
          aria-description={current ? `Branch da sessão: ${current}` : undefined}
          className={cn(
            MODEL_CHIP_BASE,
            MODEL_CHIP_INTERACTIVE,
            missing ? "border-danger/40 text-danger" : MODEL_CHIP_TONE,
            tier === "sm" && "px-1.5",
          )}
          data-branch-missing={missing ? "" : undefined}
          data-compact={tier === "sm" ? "" : undefined}
          data-testid="session-branch-picker"
          disabled={disabled}
        >
          {missing ? (
            <IconAlertTriangle size={ICON.sm} stroke={ICON_STROKE.sm} />
          ) : (
            <IconGitBranch size={ICON.sm} stroke={ICON_STROKE.sm} />
          )}
          <span
            className={cn(
              "truncate",
              tier === "sm" ? "max-w-[4.5rem]" : tier === "md" ? "max-w-[6rem]" : "max-w-[9rem]",
            )}
            data-testid="session-branch-label"
          >
            {current ?? "No branch"}
          </span>
          {tier === "sm" ? null : <IconChevronDown size={12} stroke={2} />}
        </Menu.Trigger>
      </span>
      <Menu.Portal>
        <Menu.Positioner align="start" side="top" sideOffset={6}>
          <Menu.Popup className="origin-(--transform-origin) min-w-[260px] popup-chrome popup-motion p-2">
            {!summary ? (
              <div className="px-2.5 py-3 text-center text-2xs text-fg-faint">
                <WorkingText>Loading…</WorkingText>
              </div>
            ) : (
              <BranchMenuGroups
                groups={groups}
                onSelect={(value) => {
                  const name = branchNameFromValue(value);
                  if (!name || (name === current && !missing)) return;
                  void select(name);
                }}
              />
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
