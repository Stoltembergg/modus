import { IconCube, IconEdit, IconPlus, IconTrash, IconUser, IconWorld } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ConfigScope,
  SubagentDetail,
  SubagentInfo,
  WorkspaceInfo,
} from "../../../../../shared/contracts";
import { CollapsibleMotion } from "../../../components/ui/CollapsibleMotion";
import { ShinyText } from "../../../components/ui/ShinyText";
import { Tooltip } from "../../../components/ui/Tooltip";
import { cn } from "../../../lib/cn";
import { SelectField, SwitchControl } from "../form-controls";
import {
  ReadOnlyPill,
  SettingsList,
  SettingsPageHeader,
  SettingsSection,
} from "../settings-layout";
import { McpTypeCard, settingsProjectTabs } from "../settings-provider-ui";

type SubagentFormState = {
  path?: string;
  scope: ConfigScope;
  projectCwd: string;
  name: string;
  description: string;
  model: string;
  readOnly: boolean;
  tools: string;
  disallowedTools: string;
  isolation: "shared" | "worktree";
  body: string;
};

function emptySubagentForm(scope: ConfigScope = "workspace", projectCwd = ""): SubagentFormState {
  return {
    scope,
    projectCwd,
    name: "",
    description: "",
    model: "inherit",
    readOnly: false,
    tools: "",
    disallowedTools: "",
    isolation: "shared",
    body: "",
  };
}

function formFromSubagent(subagent: SubagentDetail): SubagentFormState {
  return {
    path: subagent.path,
    scope: subagent.scope,
    projectCwd: "",
    name: subagent.name,
    description: subagent.description,
    model: subagent.model,
    readOnly: subagent.readOnly,
    tools: (subagent.tools ?? []).join(", "),
    disallowedTools: (subagent.disallowedTools ?? []).join(", "),
    isolation: subagent.isolation,
    body: subagent.body,
  };
}

function splitToolList(value: string): string[] | undefined {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function SubagentsSettingsPanel({
  cwd,
  workspaces,
}: {
  cwd: string | undefined;
  workspaces: WorkspaceInfo[];
}) {
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [form, setForm] = useState<SubagentFormState | undefined>();
  const [saving, setSaving] = useState(false);
  const [activeScope, setActiveScope] = useState<ConfigScope>("user");
  const [selectedProjectCwd, setSelectedProjectCwd] = useState(cwd ?? "");
  const projectTabs = useMemo(() => settingsProjectTabs(cwd, workspaces), [cwd, workspaces]);
  const selectedProject =
    projectTabs.find((project) => project.rootPath === selectedProjectCwd) ?? projectTabs[0];
  const effectiveProjectCwd = selectedProject?.rootPath ?? selectedProjectCwd;
  const visibleSubagents = useMemo(
    () =>
      subagents.filter((subagent) =>
        activeScope === "workspace" ? subagent.scope === "workspace" : subagent.scope === "user",
      ),
    [activeScope, subagents],
  );
  const projectSelectOptions = projectTabs.map((project) => ({
    label: project.displayName,
    value: project.rootPath,
  }));

  async function refresh(targetCwd: string): Promise<void> {
    if (!targetCwd) {
      setSubagents([]);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      setSubagents(await window.modus.subagents.list(targetCwd));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (cwd) {
      setSelectedProjectCwd(cwd);
    }
  }, [cwd]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the selected project scope changes.
  useEffect(() => {
    void refresh(effectiveProjectCwd);
  }, [effectiveProjectCwd]);

  async function editSubagent(subagent: SubagentInfo): Promise<void> {
    if (!effectiveProjectCwd) return;
    setError(undefined);
    try {
      const detail = await window.modus.subagents.get({
        cwd: effectiveProjectCwd,
        path: subagent.path,
      });
      if (detail) {
        setForm({ ...formFromSubagent(detail), projectCwd: effectiveProjectCwd });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveSubagent(current: SubagentFormState): Promise<void> {
    const targetCwd = current.scope === "workspace" ? current.projectCwd : effectiveProjectCwd;
    if (!targetCwd || !current.name.trim() || !current.body.trim()) {
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const tools = splitToolList(current.tools);
      const disallowedTools = splitToolList(current.disallowedTools);
      const payload = {
        cwd: targetCwd,
        name: current.name.trim(),
        description: current.description.trim(),
        model: current.model.trim() || "inherit",
        readOnly: current.readOnly,
        ...(tools ? { tools } : {}),
        ...(disallowedTools ? { disallowedTools } : {}),
        isolation: current.isolation,
        body: current.body.trim(),
      };
      if (current.path) {
        await window.modus.subagents.update({ ...payload, path: current.path });
      } else {
        await window.modus.subagents.create({ ...payload, scope: current.scope });
      }
      setActiveScope(current.scope);
      setSelectedProjectCwd(targetCwd);
      setForm(undefined);
      await refresh(targetCwd);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function removeSubagent(subagent: SubagentInfo): Promise<void> {
    if (!effectiveProjectCwd || !subagent.deletable) return;
    const confirmed = window.confirm(`Delete subagent "${subagent.name}"?`);
    if (!confirmed) return;
    setError(undefined);
    try {
      setSubagents(
        await window.modus.subagents.delete({ cwd: effectiveProjectCwd, path: subagent.path }),
      );
      if (form?.path === subagent.path) {
        setForm(undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function scopeBadge(subagent: SubagentInfo): string {
    return subagent.scope === "user" ? `home · ${subagent.source}` : `project · ${subagent.source}`;
  }

  function startCreate(scope: ConfigScope): void {
    setActiveScope(scope);
    setForm(emptySubagentForm(scope, effectiveProjectCwd));
  }

  return (
    <>
      <SettingsPageHeader
        actions={
          <>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40"
              disabled={!effectiveProjectCwd}
              onClick={() =>
                void window.modus.subagents.openDir({
                  cwd: effectiveProjectCwd,
                  scope: activeScope,
                })
              }
              type="button"
            >
              <IconWorld size={14} stroke={1.7} />
              Open folder
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40"
              disabled={!effectiveProjectCwd}
              onClick={() =>
                setForm((current) =>
                  current ? undefined : emptySubagentForm(activeScope, effectiveProjectCwd),
                )
              }
              type="button"
            >
              <IconPlus size={14} stroke={2} />
              New
            </button>
          </>
        }
        description="Create specialized agents for focused work in parallel. Definitions are Markdown files in your agents folder."
        title="Subagents"
      />

      <div className="flex flex-wrap items-center gap-1">
        <button
          className={cn(
            "h-8 rounded-md px-3 text-sm transition-colors",
            activeScope === "user"
              ? "bg-active text-fg"
              : "text-fg-muted hover:bg-hover hover:text-fg",
          )}
          onClick={() => {
            setActiveScope("user");
            setForm(undefined);
          }}
          type="button"
        >
          Home
        </button>
        {projectTabs.map((project) => {
          const active = activeScope === "workspace" && project.rootPath === effectiveProjectCwd;
          return (
            <button
              className={cn(
                "h-8 max-w-40 truncate rounded-md px-3 text-sm transition-colors",
                active ? "bg-active text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
              )}
              key={project.rootPath}
              onClick={() => {
                setActiveScope("workspace");
                setSelectedProjectCwd(project.rootPath);
                setForm(undefined);
              }}
              title={project.rootPath}
              type="button"
            >
              {project.displayName}
            </button>
          );
        })}
      </div>

      {error ? <p className="-mt-4 text-danger text-xs">{error}</p> : null}

      <CollapsibleMotion open={Boolean(form && effectiveProjectCwd)} preset="default">
        {form ? (
          <div className="flex flex-col gap-3 rounded-lg border border-hairline-soft bg-panel px-5 py-4">
            {!form.path ? (
              <div className="grid gap-2">
                <div className="grid grid-cols-2 gap-2">
                  <McpTypeCard
                    active={form.scope === "user"}
                    description="Available in every workspace."
                    icon={<IconUser size={16} stroke={1.7} />}
                    label="Home"
                    onClick={() => setForm({ ...form, scope: "user" })}
                  />
                  <McpTypeCard
                    active={form.scope === "workspace"}
                    description="Stored in one workspace."
                    icon={<IconCube size={16} stroke={1.7} />}
                    label="Project"
                    onClick={() =>
                      setForm({
                        ...form,
                        scope: "workspace",
                        projectCwd: form.projectCwd || projectTabs[0]?.rootPath || "",
                      })
                    }
                  />
                </div>
                {form.scope === "workspace" && projectSelectOptions.length > 1 ? (
                  <SelectField
                    label="Project"
                    onChange={(projectCwd) => setForm({ ...form, projectCwd })}
                    options={projectSelectOptions}
                    value={form.projectCwd}
                  />
                ) : null}
              </div>
            ) : (
              <div className="rounded-md border border-hairline-soft bg-surface px-3 py-2 text-fg-muted text-xs">
                Location: {form.scope === "user" ? "Home" : "Project"}
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,220px)]">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-fg-subtle">Name</span>
                <input
                  className="h-8 rounded-md border border-hairline bg-surface px-2.5 font-mono text-sm text-fg outline-none focus:border-focus-ring"
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="security-auditor"
                  value={form.name}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-fg-subtle">Model</span>
                <input
                  className="h-8 rounded-md border border-hairline bg-surface px-2.5 font-mono text-sm text-fg outline-none focus:border-focus-ring"
                  onChange={(event) => setForm({ ...form, model: event.target.value })}
                  placeholder="inherit"
                  value={form.model}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-fg-subtle">Description</span>
              <textarea
                className="scroll-thin min-h-[68px] resize-none rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-fg leading-5 outline-none focus:border-focus-ring"
                maxLength={280}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                placeholder="Use for security-sensitive auth, payment, or permission changes"
                value={form.description}
              />
            </label>
            <div className="flex items-center justify-between gap-4 rounded-md border border-hairline-soft bg-surface px-3 py-2">
              <span>
                <span className="block text-sm text-fg">Readonly</span>
                <span className="block text-xs text-fg-faint">
                  Disable write/shell/control tools
                </span>
              </span>
              <SwitchControl
                ariaLabel="Readonly subagent"
                checked={form.readOnly}
                onCheckedChange={(checked) => setForm({ ...form, readOnly: checked })}
              />
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px]">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-fg-subtle">Tools</span>
                <input
                  className="h-8 rounded-md border border-hairline bg-surface px-2.5 font-mono text-sm text-fg outline-none focus:border-focus-ring"
                  onChange={(event) => setForm({ ...form, tools: event.target.value })}
                  placeholder="read, grep, web_search"
                  value={form.tools}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-fg-subtle">Disallowed tools</span>
                <input
                  className="h-8 rounded-md border border-hairline bg-surface px-2.5 font-mono text-sm text-fg outline-none focus:border-focus-ring"
                  onChange={(event) => setForm({ ...form, disallowedTools: event.target.value })}
                  placeholder="shell, process"
                  value={form.disallowedTools}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-fg-subtle">Isolation</span>
                <select
                  className="h-8 rounded-md border border-hairline bg-surface px-2.5 text-sm text-fg outline-none focus:border-focus-ring"
                  onChange={(event) =>
                    setForm({
                      ...form,
                      isolation: event.target.value === "worktree" ? "worktree" : "shared",
                    })
                  }
                  value={form.isolation}
                >
                  <option value="shared">shared</option>
                  <option value="worktree">worktree</option>
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-fg-subtle">Instructions</span>
              <textarea
                className="scroll-thin min-h-56 resize-y rounded-md border border-hairline bg-surface px-3 py-2 font-mono text-xs text-fg leading-5 outline-none placeholder:text-fg-faint focus:border-focus-ring"
                onChange={(event) => setForm({ ...form, body: event.target.value })}
                placeholder={
                  "You are a focused security reviewer.\n\nWhen invoked:\n1. Inspect the relevant code.\n2. Report concrete risks.\n3. Do not edit files unless asked."
                }
                value={form.body}
              />
            </label>
            <div className="flex items-center justify-end gap-2">
              <button
                className="flex h-8 items-center rounded-md border border-hairline bg-surface px-3 text-xs text-fg-muted transition-colors hover:bg-hover"
                onClick={() => setForm(undefined)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40"
                disabled={!form.name.trim() || !form.body.trim() || saving}
                onClick={() => void saveSubagent(form)}
                type="button"
              >
                {saving ? (
                  <ShinyText className="text-canvas">Saving…</ShinyText>
                ) : form.path ? (
                  "Save subagent"
                ) : (
                  "Create subagent"
                )}
              </button>
            </div>
          </div>
        ) : null}
      </CollapsibleMotion>

      <SettingsSection
        title={
          activeScope === "workspace"
            ? `${selectedProject?.displayName ?? "Project"} subagents`
            : "Home subagents"
        }
      >
        {!effectiveProjectCwd ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-6">
            <p className="text-sm text-fg-muted">
              Open a workspace to discover and create subagents.
            </p>
          </div>
        ) : loading && visibleSubagents.length === 0 ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-6 text-sm text-fg-muted">
            <ShinyText>Discovering subagents…</ShinyText>
          </div>
        ) : visibleSubagents.length === 0 ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-10 text-center">
            <div className="text-sm text-fg-muted">No Subagents Yet</div>
            <div className="mt-1 text-xs text-fg-faint">
              {activeScope === "workspace"
                ? "Create project agents for this workspace."
                : "Create home agents available in every workspace."}
            </div>
            <button
              className="mt-4 h-8 rounded-md border border-hairline bg-surface px-3 text-xs text-fg transition-colors hover:bg-hover"
              onClick={() => startCreate(activeScope)}
              type="button"
            >
              New Subagent
            </button>
          </div>
        ) : (
          <SettingsList>
            {visibleSubagents.map((subagent) => (
              <div
                className="group/subagent grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-hairline-soft border-b px-4 py-3 last:border-b-0"
                key={subagent.path}
              >
                <button
                  className="min-w-0 text-left"
                  onClick={() => void editSubagent(subagent)}
                  type="button"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-fg">/{subagent.name}</span>
                    <ReadOnlyPill>{subagent.model || "inherit"}</ReadOnlyPill>
                    {subagent.readOnly ? <ReadOnlyPill>readonly</ReadOnlyPill> : null}
                    {subagent.isolation === "worktree" ? (
                      <ReadOnlyPill>worktree</ReadOnlyPill>
                    ) : null}
                    <span className="rounded bg-chip-faint px-1.5 py-px text-2xs text-fg-faint">
                      {scopeBadge(subagent)}
                    </span>
                  </div>
                  {subagent.description ? (
                    <div className="mt-1 truncate text-xs text-fg-muted">
                      {subagent.description}
                    </div>
                  ) : null}
                </button>
                <div className="flex items-center gap-1">
                  <Tooltip content="Edit subagent" side="bottom" sideOffset={6}>
                    <button
                      aria-label={`Edit ${subagent.name}`}
                      className="flex size-7 items-center justify-center rounded-md text-fg-faint opacity-0 transition-all hover:bg-hover hover:text-fg group-hover/subagent:opacity-100"
                      onClick={() => void editSubagent(subagent)}
                      type="button"
                    >
                      <IconEdit size={14} stroke={1.8} />
                    </button>
                  </Tooltip>
                  {subagent.deletable ? (
                    <Tooltip content="Delete subagent" side="bottom" sideOffset={6}>
                      <button
                        aria-label={`Delete ${subagent.name}`}
                        className="flex size-7 items-center justify-center rounded-md text-fg-faint opacity-0 transition-all hover:bg-danger/10 hover:text-danger group-hover/subagent:opacity-100"
                        onClick={() => void removeSubagent(subagent)}
                        type="button"
                      >
                        <IconTrash size={14} stroke={1.8} />
                      </button>
                    </Tooltip>
                  ) : null}
                </div>
              </div>
            ))}
          </SettingsList>
        )}
      </SettingsSection>
    </>
  );
}
