import { IconAlertCircle, IconCheck, IconHandStop, IconShieldCheck } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE } from "../../../../shared/approval";
import type { ApprovalMode, ApprovalModeState, WorkspaceInfo } from "../../../../shared/contracts";
import { cn } from "../../lib/cn";
import { type SettingsTextFn, settingsTextFor, useSettingsText } from "../../lib/settingsText";
import { SettingsSegmented } from "./form-controls";
import {
  SETTINGS_SELECTED,
  SettingsList,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from "./settings-layout";

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

  const scopeValue = isHome ? "user" : effectiveProjectCwd;
  return (
    <SettingsSection
      actions={
        projectTabs.length > 0 ? (
          <SettingsSegmented
            label={t("settings.general.approvalModeGlobalTitle")}
            onChange={(next) => {
              if (next === "user") {
                setActiveScope("user");
                return;
              }
              setActiveScope("project");
              setSelectedProjectCwd(next);
            }}
            options={[
              { value: "user", label: t("settings.general.tabHome") },
              ...projectTabs.map((project) => ({
                value: project.rootPath,
                label: project.displayName,
                title: project.rootPath,
              })),
            ]}
            value={scopeValue}
          />
        ) : null
      }
      notice={error}
      noticeTone="danger"
      title={
        isHome
          ? t("settings.general.approvalModeGlobalTitle")
          : t("settings.general.approvalModeProjectTitle", {
              project: selectedProject?.displayName ?? t("settings.general.projectFallback"),
            })
      }
    >
      <SettingsList>
        {!isHome ? (
          <SettingsRow
            control={
              <button
                className={cn(
                  "h-8 shrink-0 rounded-md px-3 text-xs transition-colors",
                  followsGlobal
                    ? SETTINGS_SELECTED
                    : "bg-chip text-fg-muted hover:bg-hover hover:text-fg",
                )}
                disabled={saving || followsGlobal || !effectiveProjectCwd}
                onClick={() => void followGlobal()}
                type="button"
              >
                {followsGlobal ? t("settings.general.following") : t("settings.general.useGlobal")}
              </button>
            }
            title={t("settings.general.followGlobalDefault")}
          />
        ) : null}
        <ModeOptionList
          disabled={saving || (!isHome && !effectiveProjectCwd)}
          onSelect={(mode) => void selectMode(mode)}
          selected={selectedMode}
        />
      </SettingsList>
    </SettingsSection>
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
    <>
      {APPROVAL_MODES.map((item) => {
        const Icon = MODE_ICONS[item.id];
        const danger = item.id === "full-access";
        const active = item.id === selected;
        return (
          <button
            aria-pressed={active}
            className={cn(
              "settings-row flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring/50",
              active ? "bg-selected" : "hover:bg-hover",
              disabled && "pointer-events-none opacity-50",
            )}
            data-settings-row=""
            disabled={disabled}
            key={item.id}
            onClick={() => onSelect(item.id)}
            type="button"
          >
            <Icon
              className={cn("mt-0.5 shrink-0", danger ? "text-danger" : "text-fg-muted")}
              size={16}
              stroke={1.8}
            />
            <span className="min-w-0 flex-1">
              <span className={cn("block text-sm", danger ? "text-danger" : "text-fg")}>
                {modeLabel(item.id, t)}
              </span>
              {danger ? (
                <SettingsNotice className="mt-0.5" tone="danger">
                  {t("settings.general.modeFullAccessDesc")}
                </SettingsNotice>
              ) : null}
            </span>
            <span className="mt-0.5 flex w-4 shrink-0 justify-center text-(--accent-text,var(--color-accent))">
              {active ? <IconCheck size={14} stroke={2} /> : null}
            </span>
          </button>
        );
      })}
    </>
  );
}
