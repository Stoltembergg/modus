import { IconAlertCircle, IconCheck, IconHandStop, IconShieldCheck } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE } from "../../../../shared/approval";
import type { ApprovalMode, ApprovalModeState, WorkspaceInfo } from "../../../../shared/contracts";
import { cn } from "../../lib/cn";
import { type SettingsTextFn, settingsTextFor, useSettingsText } from "../../lib/settingsText";

const MODE_ICONS: Record<ApprovalMode, typeof IconHandStop> = {
  "request-approval": IconHandStop,
  auto: IconShieldCheck,
  "full-access": IconAlertCircle,
};

type Scope = "user" | "project";

type ApprovalModeSettingsProps = {
  cwd?: string | undefined;
  workspaces?: WorkspaceInfo[] | undefined;
};

function projectLabel(rootPath: string, t: SettingsTextFn = settingsTextFor()): string {
  return rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? t("settings.general.projectFallback");
}

function settingsProjectTabs(
  cwd: string | undefined,
  workspaces: WorkspaceInfo[],
  t: SettingsTextFn = settingsTextFor(),
): Array<{ rootPath: string; displayName: string }> {
  const seen = new Set<string>();
  const tabs: Array<{ rootPath: string; displayName: string }> = [];
  const push = (rootPath: string, displayName: string): void => {
    if (!rootPath || seen.has(rootPath)) return;
    seen.add(rootPath);
    tabs.push({ rootPath, displayName: displayName || projectLabel(rootPath, t) });
  };
  if (cwd) push(cwd, workspaces.find((workspace) => workspace.rootPath === cwd)?.displayName ?? "");
  for (const workspace of workspaces) push(workspace.rootPath, workspace.displayName);
  return tabs;
}

function modeLabel(mode: ApprovalMode, t: SettingsTextFn = settingsTextFor()): string {
  switch (mode) {
    case "request-approval":
      return t("settings.general.modeRequestApproval");
    case "auto":
      return t("settings.general.modeAuto");
    case "full-access":
      return t("settings.general.modeFullAccess");
  }
}

function modeDescription(mode: ApprovalMode, t: SettingsTextFn = settingsTextFor()): string {
  switch (mode) {
    case "request-approval":
      return t("settings.general.modeRequestApprovalDesc");
    case "auto":
      return t("settings.general.modeAutoDesc");
    case "full-access":
      return t("settings.general.modeFullAccessDesc");
  }
}

/**
 * Approval mode settings — same scope UX as MCP/Subagents:
 * Home = global default; project tabs = optional override. One mode list at a time.
 */
export function ApprovalModeSettings({ cwd, workspaces = [] }: ApprovalModeSettingsProps) {
  const t = useSettingsText();
  const projectTabs = useMemo(() => settingsProjectTabs(cwd, workspaces, t), [cwd, workspaces, t]);
  const [activeScope, setActiveScope] = useState<Scope>("user");
  const [selectedProjectCwd, setSelectedProjectCwd] = useState(cwd ?? "");
  const [state, setState] = useState<ApprovalModeState>({
    effective: DEFAULT_APPROVAL_MODE,
    global: DEFAULT_APPROVAL_MODE,
    project: null,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const selectedProject =
    projectTabs.find((project) => project.rootPath === selectedProjectCwd) ?? projectTabs[0];
  const effectiveProjectCwd = selectedProject?.rootPath ?? selectedProjectCwd;
  const isHome = activeScope === "user";
  const followsGlobal = !isHome && state.project === null;
  const selectedMode = isHome ? state.global : (state.project ?? state.global);

  useEffect(() => {
    if (cwd) setSelectedProjectCwd(cwd);
  }, [cwd]);

  async function refresh(scope: Scope, projectCwd: string): Promise<void> {
    setError(undefined);
    try {
      const next =
        scope === "project" && projectCwd
          ? await window.modus.permission.getMode({ cwd: projectCwd })
          : await window.modus.permission.getMode();
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when scope/project tab changes
  useEffect(() => {
    void refresh(activeScope, effectiveProjectCwd);
  }, [activeScope, effectiveProjectCwd]);

  async function selectMode(mode: ApprovalMode): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      if (isHome) {
        setState(await window.modus.permission.setMode({ mode }));
        return;
      }
      if (!effectiveProjectCwd) {
        setError(t("settings.general.openWorkspaceError"));
        return;
      }
      setState(await window.modus.permission.setMode({ mode, cwd: effectiveProjectCwd }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function followGlobal(): Promise<void> {
    if (!effectiveProjectCwd) return;
    setSaving(true);
    setError(undefined);
    try {
      setState(await window.modus.permission.clearProjectMode({ cwd: effectiveProjectCwd }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Same tab chrome as MCP / Subagents */}
      <div className="flex flex-wrap items-center gap-1">
        <button
          className={cn(
            "h-8 rounded-md px-3 text-sm transition-colors",
            isHome ? "bg-active text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
          )}
          onClick={() => setActiveScope("user")}
          type="button"
        >
          {t("settings.general.tabHome")}
        </button>
        {projectTabs.map((project) => {
          const active = !isHome && project.rootPath === effectiveProjectCwd;
          return (
            <button
              className={cn(
                "h-8 max-w-40 truncate rounded-md px-3 text-sm transition-colors",
                active ? "bg-active text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
              )}
              key={project.rootPath}
              onClick={() => {
                setActiveScope("project");
                setSelectedProjectCwd(project.rootPath);
              }}
              title={project.rootPath}
              type="button"
            >
              {project.displayName}
            </button>
          );
        })}
      </div>

      {error ? <p className="-mt-2 text-danger text-xs">{error}</p> : null}

      <section className="flex flex-col gap-4">
        <div>
          <h3 className="text-md font-normal text-fg">
            {isHome
              ? t("settings.general.approvalModeGlobalTitle")
              : t("settings.general.approvalModeProjectTitle", {
                  project: selectedProject?.displayName ?? t("settings.general.projectFallback"),
                })}
          </h3>
          <p className="mt-1 text-xs text-fg-muted">
            {isHome
              ? t("settings.general.approvalModeGlobalDesc")
              : followsGlobal
                ? t("settings.general.approvalModeFollowingGlobal", {
                    mode: modeLabel(state.global, t),
                  })
                : t("settings.general.approvalModeOverrideActiveWorkspace")}
          </p>
        </div>

        {!isHome ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-hairline-soft bg-panel px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm text-fg">{t("settings.general.followGlobalDefault")}</div>
              <div className="mt-0.5 truncate text-xs text-fg-muted">
                {followsGlobal
                  ? t("settings.general.usingGlobalMode", {
                      mode: modeLabel(state.global, t),
                    })
                  : t("settings.general.overrideActiveProject")}
              </div>
            </div>
            <button
              className={cn(
                "h-8 shrink-0 rounded-md px-3 text-xs transition-colors",
                followsGlobal
                  ? "bg-active text-fg"
                  : "border border-hairline bg-elevated text-fg-muted hover:bg-hover hover:text-fg",
              )}
              disabled={saving || followsGlobal || !effectiveProjectCwd}
              onClick={() => void followGlobal()}
              type="button"
            >
              {followsGlobal ? t("settings.general.following") : t("settings.general.useGlobal")}
            </button>
          </div>
        ) : null}

        <ModeOptionList
          disabled={saving || (!isHome && !effectiveProjectCwd)}
          onSelect={(mode) => void selectMode(mode)}
          selected={selectedMode}
        />
      </section>

      <p className="text-xs text-fg-muted">{t("settings.general.scopeHint")}</p>
    </div>
  );
}

function ModeOptionList({
  selected,
  onSelect,
  disabled = false,
}: {
  selected: ApprovalMode;
  onSelect(mode: ApprovalMode): void;
  disabled?: boolean;
}) {
  const t = useSettingsText();
  return (
    <div className="overflow-hidden rounded-lg border border-hairline-soft bg-panel">
      {APPROVAL_MODES.map((item) => {
        const Icon = MODE_ICONS[item.id];
        const danger = item.id === "full-access";
        const active = item.id === selected;
        return (
          <button
            className={cn(
              "flex w-full items-start gap-3 border-hairline-soft border-b px-4 py-3 text-left transition-colors last:border-b-0",
              active ? "bg-active" : "hover:bg-hover",
              disabled && "pointer-events-none opacity-50",
            )}
            disabled={disabled}
            key={item.id}
            onClick={() => onSelect(item.id)}
            type="button"
          >
            <Icon
              className={cn("mt-0.5 shrink-0", danger ? "text-accent" : "text-fg-subtle")}
              size={16}
              stroke={1.8}
            />
            <span className="min-w-0 flex-1">
              <span className={cn("block text-sm", danger ? "text-accent" : "text-fg")}>
                {modeLabel(item.id, t)}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-fg-muted">
                {modeDescription(item.id, t)}
              </span>
            </span>
            <span className="mt-0.5 flex w-4 shrink-0 justify-center text-fg">
              {active ? <IconCheck size={14} stroke={2} /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
