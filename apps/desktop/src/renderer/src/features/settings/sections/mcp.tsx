import { Switch } from "@base-ui/react/switch";
import {
  IconChevronRight,
  IconCodeDots,
  IconCube,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTerminal2,
  IconTrash,
  IconUser,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { joinCommandLine, splitCommandLine } from "../../../../../shared/command-line";
import type { McpServerInfo, WorkspaceInfo } from "../../../../../shared/contracts";
import { CollapsibleMotion } from "../../../components/ui/CollapsibleMotion";
import { Tooltip } from "../../../components/ui/Tooltip";
import { WorkingText } from "../../../components/ui/WorkingText";
import { cn } from "../../../lib/cn";
import { SelectField } from "../form-controls";
import { SettingsList, SettingsPageHeader, SettingsSection } from "../settings-layout";
import { McpTypeCard, type SettingsProjectTab, settingsProjectTabs } from "../settings-provider-ui";
import { IntegrationsSettingsPanel } from "./integrations";

const MCP_STATUS_STYLE: Record<McpServerInfo["status"], { dot: string; label: string }> = {
  connected: { dot: "bg-success", label: "Connected" },
  connecting: { dot: "bg-focus-ring-soft", label: "Connecting" },
  failed: { dot: "bg-danger", label: "Failed" },
  disabled: { dot: "bg-fg-faint", label: "Disabled" },
};

/** One-click starting points so first-time users never face an empty form. */
const MCP_PRESETS: ReadonlyArray<{ label: string; name: string; command: string }> = [
  {
    label: "Filesystem",
    name: "filesystem",
    command: "npx -y @modelcontextprotocol/server-filesystem .",
  },
  { label: "Fetch", name: "fetch", command: "npx -y @modelcontextprotocol/server-fetch" },
  { label: "Memory", name: "memory", command: "npx -y @modelcontextprotocol/server-memory" },
];

type KeyValuePair = { id: string; key: string; value: string };
type McpScope = "user" | "project";

export type McpFormState = {
  /** undefined = creating; otherwise the server being edited. */
  originalName: string | undefined;
  scope: McpScope;
  projectCwd: string;
  name: string;
  transport: "stdio" | "http";
  commandLine: string;
  url: string;
  env: KeyValuePair[];
  headers: KeyValuePair[];
  enabled: boolean;
  /** Exact raw tool names from a currently connected server. */
  discoveredTools: string[];
  readOnlyToolAllowlist: string[];
  confirmReadOnlyToolAllowlist: boolean;
};

const emptyMcpForm = (scope: McpScope = "project", projectCwd = ""): McpFormState => ({
  originalName: undefined,
  scope,
  projectCwd,
  name: "",
  transport: "stdio",
  commandLine: "",
  url: "",
  env: [],
  headers: [],
  enabled: true,
  discoveredTools: [],
  readOnlyToolAllowlist: [],
  confirmReadOnlyToolAllowlist: false,
});

export function normalizeReadOnlyMcpAllowlist(
  discoveredTools: string[],
  configuredNames: unknown,
  connected: boolean,
): string[] {
  if (!connected || !Array.isArray(configuredNames)) return [];
  const selected = new Set(
    configuredNames.filter((name): name is string => typeof name === "string"),
  );
  return [...new Set(discoveredTools)].filter((name) => selected.has(name));
}

export function toggleReadOnlyMcpTool(
  discoveredTools: string[],
  selectedNames: string[],
  toolName: string,
  checked: boolean,
): string[] {
  const available = [...new Set(discoveredTools)];
  if (!available.includes(toolName)) {
    return available.filter((name) => selectedNames.includes(name));
  }
  const selected = new Set(available.filter((name) => selectedNames.includes(name)));
  if (checked) selected.add(toolName);
  else selected.delete(toolName);
  return available.filter((name) => selected.has(name));
}

export function canSaveReadOnlyMcpAllowlist(selectedNames: string[], confirmed: boolean): boolean {
  return selectedNames.length === 0 || confirmed;
}

export function confirmedReadOnlyMcpAllowlist(
  discoveredTools: string[],
  selectedNames: string[],
  confirmed: boolean,
  connected: boolean,
): string[] | undefined {
  const selected = normalizeReadOnlyMcpAllowlist(discoveredTools, selectedNames, connected);
  return canSaveReadOnlyMcpAllowlist(selected, confirmed) ? selected : undefined;
}

const pair = (key = "", value = ""): KeyValuePair => ({ id: crypto.randomUUID(), key, value });

const pairsToRecord = (pairs: KeyValuePair[]): Record<string, string> =>
  Object.fromEntries(
    pairs.filter((item) => item.key.trim()).map((item) => [item.key.trim(), item.value]),
  );

const recordToPairs = (record: unknown): KeyValuePair[] =>
  typeof record === "object" && record !== null
    ? Object.entries(record as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => pair(key, value))
    : [];

const mcpInitial = (name: string): string => name.trim().slice(0, 1).toUpperCase() || "?";

function mcpCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"} enabled`;
}

function mcpServerSummary(server: McpServerInfo): string {
  if (server.status === "disabled") return "Disabled";
  if (server.status === "connecting") return "Connecting";
  if (server.status === "failed") {
    return server.error?.toLowerCase().includes("auth") ? "Needs authentication" : "Failed";
  }
  return server.tools.length > 0 ? mcpCount(server.tools.length, "tool") : "Connected";
}

/**
 * MCP server management — fully graphical. Add/edit/toggle/delete servers
 * without touching JSON; Modus writes the Cursor-compatible mcp.json behind
 * the scenes (the file stays available for power users).
 */
export function McpSettingsPanel({
  cwd,
  workspaces,
}: {
  cwd: string | undefined;
  workspaces: WorkspaceInfo[];
}) {
  const [serverList, setServerList] = useState<McpServerInfo[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mcpError, setMcpError] = useState<string | undefined>();
  const [form, setForm] = useState<McpFormState | undefined>();
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>();
  const [activeScope, setActiveScope] = useState<McpScope>("user");
  const [selectedProjectCwd, setSelectedProjectCwd] = useState(cwd ?? "");
  const projectTabs = useMemo(() => settingsProjectTabs(cwd, workspaces), [cwd, workspaces]);
  const selectedProject =
    projectTabs.find((project) => project.rootPath === selectedProjectCwd) ?? projectTabs[0];
  const effectiveProjectCwd = selectedProject?.rootPath ?? selectedProjectCwd;
  const visibleServers = useMemo(
    () =>
      serverList.filter((server) => {
        const projectScoped = Boolean(
          effectiveProjectCwd && server.source.startsWith(effectiveProjectCwd),
        );
        return activeScope === "project" ? projectScoped : !projectScoped;
      }),
    [activeScope, effectiveProjectCwd, serverList],
  );

  async function refresh(targetCwd: string): Promise<void> {
    setMcpError(undefined);
    try {
      if (targetCwd) {
        setSyncing(true);
        setServerList(await window.modus.mcp.sync(targetCwd));
      } else {
        setServerList(await window.modus.mcp.list());
      }
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    if (cwd) {
      setSelectedProjectCwd(cwd);
    }
  }, [cwd]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the selected config scope changes.
  useEffect(() => {
    void refresh(effectiveProjectCwd);
  }, [effectiveProjectCwd]);

  async function openEdit(server: McpServerInfo): Promise<void> {
    if (!effectiveProjectCwd) return;
    setMcpError(undefined);
    try {
      const scope = server.source.startsWith(effectiveProjectCwd) ? "project" : "user";
      const raw = await window.modus.mcp.entry({ cwd: effectiveProjectCwd, name: server.name });
      const entry = raw?.entry ?? {};
      const command = typeof entry.command === "string" ? entry.command : "";
      const args = Array.isArray(entry.args)
        ? entry.args.filter((item: unknown): item is string => typeof item === "string")
        : [];
      const discoveredTools =
        server.status === "connected" ? [...new Set(server.tools.map((tool) => tool.name))] : [];
      setForm({
        originalName: server.name,
        scope,
        projectCwd: effectiveProjectCwd,
        name: server.name,
        transport: typeof entry.url === "string" ? "http" : "stdio",
        commandLine: command ? joinCommandLine([command, ...args]) : "",
        url: typeof entry.url === "string" ? entry.url : "",
        env: recordToPairs(entry.env),
        headers: recordToPairs(entry.headers),
        enabled: server.status !== "disabled",
        discoveredTools,
        readOnlyToolAllowlist: normalizeReadOnlyMcpAllowlist(
          discoveredTools,
          entry.readOnlyToolAllowlist,
          server.status === "connected",
        ),
        confirmReadOnlyToolAllowlist: false,
      });
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveForm(current: McpFormState): Promise<void> {
    const targetCwd = current.scope === "project" ? current.projectCwd : effectiveProjectCwd;
    if (!targetCwd) return;
    const readOnlyToolAllowlist = confirmedReadOnlyMcpAllowlist(
      current.discoveredTools,
      current.readOnlyToolAllowlist,
      current.confirmReadOnlyToolAllowlist,
      current.discoveredTools.length > 0,
    );
    if (readOnlyToolAllowlist === undefined) {
      setMcpError("Confirm that every selected MCP tool is read-only before saving.");
      return;
    }
    setSaving(true);
    setMcpError(undefined);
    try {
      const [command, ...args] = splitCommandLine(current.commandLine);
      setServerList(
        await window.modus.mcp.upsert({
          cwd: targetCwd,
          name: current.name.trim(),
          originalName: current.originalName,
          scope: current.scope,
          transport: current.transport,
          enabled: current.enabled,
          readOnlyToolAllowlist,
          ...(current.transport === "stdio"
            ? { command: command ?? "", args, env: pairsToRecord(current.env) }
            : { url: current.url.trim(), headers: pairsToRecord(current.headers) }),
        }),
      );
      setActiveScope(current.scope);
      setSelectedProjectCwd(targetCwd);
      setForm(undefined);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleServer(server: McpServerInfo, enabled: boolean): Promise<void> {
    if (!effectiveProjectCwd) return;
    setMcpError(undefined);
    try {
      setServerList(
        await window.modus.mcp.setEnabled({ cwd: effectiveProjectCwd, name: server.name, enabled }),
      );
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteServer(server: McpServerInfo): Promise<void> {
    if (!effectiveProjectCwd) return;
    setMcpError(undefined);
    setConfirmingDelete(undefined);
    try {
      setServerList(await window.modus.mcp.delete({ cwd: effectiveProjectCwd, name: server.name }));
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  }

  function sourceBadge(source: string): string {
    if (effectiveProjectCwd && source.startsWith(effectiveProjectCwd)) {
      return "Project";
    }
    return "Global";
  }

  function startCreate(scope: McpScope): void {
    setConfirmingDelete(undefined);
    setActiveScope(scope);
    setForm(emptyMcpForm(scope, effectiveProjectCwd));
  }

  return (
    <>
      <SettingsPageHeader
        actions={
          <>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40"
              disabled={!effectiveProjectCwd || syncing}
              onClick={() => void refresh(effectiveProjectCwd)}
              type="button"
            >
              <IconRefresh size={14} stroke={1.7} />
              {syncing ? <WorkingText>Connecting…</WorkingText> : "Reload"}
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40"
              disabled={!effectiveProjectCwd}
              onClick={() => {
                setForm((current) =>
                  current ? undefined : emptyMcpForm(activeScope, effectiveProjectCwd),
                );
              }}
              type="button"
            >
              <IconPlus size={14} stroke={2} />
              Add server
            </button>
          </>
        }
        description="Give the agent extra tools — databases, issue trackers, web search and more — by connecting Model Context Protocol servers. No JSON required."
        title="MCP"
      />

      <SettingsSection
        description="Test API access and MCP connectivity separately. The test preserves existing tools and authorizations."
        title="Composio"
      >
        <IntegrationsSettingsPanel />
      </SettingsSection>
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
          const active = activeScope === "project" && project.rootPath === effectiveProjectCwd;
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

      {mcpError ? <p className="-mt-4 text-danger text-xs">{mcpError}</p> : null}

      <CollapsibleMotion open={Boolean(form && effectiveProjectCwd)} preset="default">
        {form ? (
          <McpServerForm
            busy={saving}
            form={form}
            isNew={form.originalName === undefined}
            onCancel={() => setForm(undefined)}
            onChange={setForm}
            projectOptions={projectTabs}
            onSubmit={(state) => void saveForm(state)}
          />
        ) : null}
      </CollapsibleMotion>

      <SettingsSection
        title={
          activeScope === "project"
            ? `${selectedProject?.displayName ?? "Project"} MCP Servers`
            : "Global MCP Servers"
        }
      >
        <SettingsList>
          {visibleServers.length > 0 ? (
            visibleServers.map((server) => {
              const status = MCP_STATUS_STYLE[server.status];
              const deleting = confirmingDelete === server.name;
              return (
                <div
                  className="group/mcp flex items-center gap-3 border-hairline-soft border-b px-4 py-3 last:border-b-0"
                  key={server.name}
                >
                  <span className="relative flex size-10 shrink-0 items-center justify-center rounded-lg bg-chip-strong font-mono text-fg-muted text-xs">
                    {mcpInitial(server.name)}
                    <span
                      aria-hidden
                      className={cn(
                        "-right-0.5 absolute bottom-1 size-2.5 rounded-full border border-panel",
                        status.dot,
                      )}
                    />
                  </span>
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => void openEdit(server)}
                    type="button"
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-fg text-sm">{server.name}</span>
                      <span className="shrink-0 text-2xs text-fg-faint">
                        {sourceBadge(server.source)}
                      </span>
                    </div>
                    <div
                      className={cn(
                        "flex items-center gap-1 text-xs",
                        server.status === "failed" ? "text-danger" : "text-fg-muted",
                      )}
                    >
                      <span>{mcpServerSummary(server)}</span>
                      {server.tools.length > 0 ? <IconChevronRight size={12} stroke={1.8} /> : null}
                    </div>
                  </button>
                  <span className="flex shrink-0 items-center gap-1">
                    {deleting ? (
                      <button
                        className="flex h-7 items-center gap-1 rounded-md bg-danger/10 px-2 text-danger text-xs transition-colors hover:bg-danger/20"
                        onClick={() => void deleteServer(server)}
                        type="button"
                      >
                        <IconTrash size={13} stroke={1.9} />
                        Delete
                      </button>
                    ) : (
                      <>
                        <Tooltip content="Edit server" side="bottom" sideOffset={6}>
                          <button
                            aria-label={`Edit ${server.name}`}
                            className="flex size-7 items-center justify-center rounded-md text-fg-faint opacity-0 transition-all hover:bg-hover hover:text-fg-muted group-hover/mcp:opacity-100"
                            onClick={() => void openEdit(server)}
                            type="button"
                          >
                            <IconEdit size={14} stroke={1.8} />
                          </button>
                        </Tooltip>
                        <Tooltip content="Remove server" side="bottom" sideOffset={6}>
                          <button
                            aria-label={`Remove ${server.name}`}
                            className="flex size-7 items-center justify-center rounded-md text-fg-faint opacity-0 transition-all hover:bg-danger/10 hover:text-danger group-hover/mcp:opacity-100"
                            onClick={() => setConfirmingDelete(server.name)}
                            type="button"
                          >
                            <IconTrash size={14} stroke={1.8} />
                          </button>
                        </Tooltip>
                        <Switch.Root
                          checked={server.status !== "disabled"}
                          className="ml-1 flex h-5 w-9 shrink-0 cursor-pointer rounded-full bg-chip-strong p-0.5 transition-colors data-checked:bg-success/70"
                          onCheckedChange={(checked) => void toggleServer(server, checked)}
                        >
                          <Switch.Thumb className="size-4 rounded-full bg-fg transition-transform data-checked:translate-x-4" />
                        </Switch.Root>
                      </>
                    )}
                  </span>
                </div>
              );
            })
          ) : (
            <div className="px-4 py-5 text-fg-muted text-sm">
              {activeScope === "project"
                ? "No project MCP servers yet."
                : "No global MCP servers yet."}
            </div>
          )}
          <button
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover disabled:opacity-40"
            disabled={!effectiveProjectCwd}
            onClick={() => startCreate(activeScope)}
            type="button"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-chip-strong text-fg-muted">
              <IconPlus size={18} stroke={1.8} />
            </span>
            <span className="min-w-0">
              <span className="block text-fg text-sm">New MCP Server</span>
              <span className="block text-fg-muted text-xs">
                {effectiveProjectCwd
                  ? activeScope === "project"
                    ? `Save to ${selectedProject?.displayName ?? "this project"}`
                    : "Save globally for every workspace"
                  : "Open a workspace to configure MCP servers"}
              </span>
            </span>
          </button>
        </SettingsList>
        <div className="flex items-center justify-between">
          <p className="text-fg-faint text-xs leading-relaxed">
            Global servers are available in every workspace. Project servers live in the selected
            workspace. “Always allow” trusts a tool for this workspace.
          </p>
          {activeScope === "project" ? (
            <button
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-fg-faint text-xs transition-colors hover:bg-hover hover:text-fg-subtle disabled:opacity-40"
              disabled={!effectiveProjectCwd}
              onClick={() => void window.modus.mcp.openConfig(effectiveProjectCwd)}
              title="Advanced: edit the underlying project mcp.json directly"
              type="button"
            >
              <IconCodeDots size={13} stroke={1.7} />
              Edit JSON
            </button>
          ) : null}
        </div>
      </SettingsSection>
    </>
  );
}

/** The add/edit server form — one paste-friendly command field, no JSON. */
export function McpServerForm({
  busy,
  form,
  isNew,
  onCancel,
  onChange,
  projectOptions,
  onSubmit,
}: {
  busy: boolean;
  form: McpFormState;
  isNew: boolean;
  onCancel(): void;
  onChange(next: McpFormState): void;
  projectOptions: SettingsProjectTab[];
  onSubmit(state: McpFormState): void;
}) {
  const projectSelectOptions = projectOptions.map((project) => ({
    label: project.displayName,
    value: project.rootPath,
  }));
  const canSave =
    form.name.trim().length > 0 &&
    (form.scope !== "project" || form.projectCwd.trim().length > 0) &&
    (form.transport === "stdio"
      ? form.commandLine.trim().length > 0
      : /^https?:\/\//.test(form.url.trim()));
  const allowlistConfirmed = canSaveReadOnlyMcpAllowlist(
    form.readOnlyToolAllowlist,
    form.confirmReadOnlyToolAllowlist,
  );

  const set = (patch: Partial<McpFormState>): void => onChange({ ...form, ...patch });

  return (
    <form
      className="flex flex-col gap-4 rounded-lg border border-hairline bg-panel p-5"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (canSave && allowlistConfirmed && !busy) {
          onSubmit(form);
        }
      }}
    >
      <div className="flex items-center justify-between">
        <h4 className="text-md text-fg">
          {isNew ? "Add MCP server" : `Edit “${form.originalName}”`}
        </h4>
        {isNew ? (
          <div className="flex gap-1">
            {MCP_PRESETS.map((preset) => (
              <button
                className="h-7 rounded-md bg-chip px-2 text-2xs text-fg-subtle transition-colors hover:bg-chip-strong hover:text-fg"
                key={preset.name}
                onClick={() =>
                  set({
                    name: form.name || preset.name,
                    transport: "stdio",
                    commandLine: preset.command,
                  })
                }
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {isNew ? (
        <div className="grid gap-2">
          <div className="grid grid-cols-2 gap-2">
            <McpTypeCard
              active={form.scope === "user"}
              description="Available in every workspace."
              icon={<IconUser size={16} stroke={1.7} />}
              label="Home"
              onClick={() => set({ scope: "user" })}
            />
            <McpTypeCard
              active={form.scope === "project"}
              description="Stored in one workspace."
              icon={<IconCube size={16} stroke={1.7} />}
              label="Project"
              onClick={() =>
                set({
                  scope: "project",
                  projectCwd: form.projectCwd || projectOptions[0]?.rootPath || "",
                })
              }
            />
          </div>
          {form.scope === "project" && projectSelectOptions.length > 1 ? (
            <SelectField
              label="Project"
              onChange={(projectCwd) => set({ projectCwd })}
              options={projectSelectOptions}
              value={form.projectCwd}
            />
          ) : null}
        </div>
      ) : (
        <div className="rounded-md border border-hairline-soft bg-surface px-3 py-2 text-fg-muted text-xs">
          Location: {form.scope === "project" ? "Project" : "Home"}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <McpTypeCard
          active={form.transport === "stdio"}
          description="Runs a command on this machine. Most servers from npm work this way."
          icon={<IconTerminal2 size={16} stroke={1.7} />}
          label="Local command"
          onClick={() => set({ transport: "stdio" })}
        />
        <McpTypeCard
          active={form.transport === "http"}
          description="Connects to a hosted MCP endpoint over HTTP or SSE."
          icon={<IconWorld size={16} stroke={1.7} />}
          label="Remote URL"
          onClick={() => set({ transport: "http" })}
        />
      </div>

      <McpField hint="Shown in tool calls, e.g. “linear”. Letters, numbers, - _ ." label="Name">
        <input
          className="h-9 w-full rounded-md border border-hairline-soft bg-surface px-3 font-mono text-sm text-fg outline-none placeholder:text-fg-faint focus:border-focus-ring"
          onChange={(event) => set({ name: event.target.value })}
          placeholder="my-server"
          value={form.name}
        />
      </McpField>

      {form.transport === "stdio" ? (
        <>
          <McpField
            hint="Paste the full command from the server's README — Modus splits it for you."
            label="Command"
          >
            <input
              className="h-9 w-full rounded-md border border-hairline-soft bg-surface px-3 font-mono text-sm text-fg outline-none placeholder:text-fg-faint focus:border-focus-ring"
              onChange={(event) => set({ commandLine: event.target.value })}
              placeholder="npx -y @modelcontextprotocol/server-filesystem ."
              value={form.commandLine}
            />
          </McpField>
          <McpKeyValueRows
            addLabel="Add variable"
            hint="Secrets the server needs. Use ${env:NAME} to reference your system environment."
            label="Environment variables"
            onChange={(env) => set({ env })}
            pairs={form.env}
            placeholderKey="API_KEY"
            placeholderValue="value or ${env:MY_KEY}"
          />
        </>
      ) : (
        <>
          <McpField hint="The server's MCP endpoint." label="URL">
            <input
              className="h-9 w-full rounded-md border border-hairline-soft bg-surface px-3 font-mono text-sm text-fg outline-none placeholder:text-fg-faint focus:border-focus-ring"
              onChange={(event) => set({ url: event.target.value })}
              placeholder="https://example.com/mcp"
              value={form.url}
            />
          </McpField>
          <McpKeyValueRows
            addLabel="Add header"
            hint="Sent with every request — auth tokens usually go here."
            label="Headers"
            onChange={(headers) => set({ headers })}
            pairs={form.headers}
            placeholderKey="Authorization"
            placeholderValue="Bearer ${env:MY_TOKEN}"
          />
        </>
      )}

      <fieldset className="min-w-0 rounded-lg border border-hairline-soft p-3">
        <legend className="px-1 font-medium text-fg text-sm">Read-only tools</legend>
        <p className="mb-2 text-xs leading-relaxed text-fg-muted">
          Only checked raw tool names are saved. Check each tool before marking it read-only.
        </p>
        {form.discoveredTools.length > 0 ? (
          <ul className="grid min-w-0 gap-1.5 sm:grid-cols-2">
            {form.discoveredTools.map((toolName) => (
              <li key={toolName}>
                <label className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs text-fg-subtle transition-colors hover:bg-hover">
                  <input
                    aria-label={`Allow ${toolName} as read-only`}
                    checked={form.readOnlyToolAllowlist.includes(toolName)}
                    className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-accent)]"
                    onChange={(event) =>
                      set({
                        readOnlyToolAllowlist: toggleReadOnlyMcpTool(
                          form.discoveredTools,
                          form.readOnlyToolAllowlist,
                          toolName,
                          event.target.checked,
                        ),
                        confirmReadOnlyToolAllowlist: false,
                      })
                    }
                    type="checkbox"
                  />
                  <span className="min-w-0 break-all font-mono">{toolName}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-md bg-surface px-2.5 py-2 text-xs text-fg-faint" role="status">
            Tool list unavailable. No tools are allowed by default.
          </p>
        )}
        {form.readOnlyToolAllowlist.length > 0 ? (
          <label className="mt-3 flex cursor-pointer items-start gap-2 border-hairline-soft border-t pt-3 text-xs text-warning">
            <input
              aria-label="Confirm selected tools are read-only"
              checked={form.confirmReadOnlyToolAllowlist}
              className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-warning)]"
              onChange={(event) => set({ confirmReadOnlyToolAllowlist: event.target.checked })}
              type="checkbox"
            />
            <span>I confirm that each selected tool is read-only.</span>
          </label>
        ) : null}
      </fieldset>

      <div className="flex items-center justify-between border-hairline-soft border-t pt-4">
        <div className="flex items-center gap-2 text-fg-muted text-xs">
          <Switch.Root
            aria-label="Connect automatically"
            checked={form.enabled}
            className="flex h-4.5 w-8 shrink-0 cursor-pointer rounded-full bg-chip-strong p-0.5 transition-colors data-checked:bg-success/70"
            onCheckedChange={(enabled) => set({ enabled })}
          >
            <Switch.Thumb className="size-3.5 rounded-full bg-fg transition-transform data-checked:translate-x-3.5" />
          </Switch.Root>
          Connect automatically
        </div>
        <div className="flex items-center gap-2">
          <button
            className="h-8 rounded-md px-3 text-fg-muted text-xs transition-colors hover:bg-hover hover:text-fg"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40"
            disabled={!canSave || !allowlistConfirmed || busy}
            type="submit"
          >
            {busy ? (
              <WorkingText className="text-canvas">Connecting…</WorkingText>
            ) : isNew ? (
              "Add server"
            ) : (
              "Save changes"
            )}
          </button>
        </div>
      </div>
    </form>
  );
}

function McpField({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint?: string;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-fg-muted text-xs">{label}</span>
      {children}
      {hint ? <span className="text-2xs text-fg-faint">{hint}</span> : null}
    </div>
  );
}

function McpKeyValueRows({
  addLabel,
  hint,
  label,
  onChange,
  pairs,
  placeholderKey,
  placeholderValue,
}: {
  addLabel: string;
  hint: string;
  label: string;
  onChange(pairs: KeyValuePair[]): void;
  pairs: KeyValuePair[];
  placeholderKey: string;
  placeholderValue: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-fg-muted text-xs">{label}</span>
      {pairs.map((item) => (
        <div className="flex items-center gap-1.5" key={item.id}>
          <input
            className="h-8 w-2/5 rounded-md border border-hairline-soft bg-surface px-2.5 font-mono text-fg text-xs outline-none placeholder:text-fg-faint focus:border-focus-ring"
            onChange={(event) =>
              onChange(
                pairs.map((existing) =>
                  existing.id === item.id ? { ...existing, key: event.target.value } : existing,
                ),
              )
            }
            placeholder={placeholderKey}
            value={item.key}
          />
          <input
            className="h-8 min-w-0 flex-1 rounded-md border border-hairline-soft bg-surface px-2.5 font-mono text-fg text-xs outline-none placeholder:text-fg-faint focus:border-focus-ring"
            onChange={(event) =>
              onChange(
                pairs.map((existing) =>
                  existing.id === item.id ? { ...existing, value: event.target.value } : existing,
                ),
              )
            }
            placeholder={placeholderValue}
            value={item.value}
          />
          <button
            aria-label="Remove row"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg-muted"
            onClick={() => onChange(pairs.filter((existing) => existing.id !== item.id))}
            type="button"
          >
            <IconX size={13} stroke={1.8} />
          </button>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <button
          className="flex h-7 items-center gap-1 rounded-md px-2 text-fg-subtle text-xs transition-colors hover:bg-hover hover:text-fg"
          onClick={() => onChange([...pairs, pair()])}
          type="button"
        >
          <IconPlus size={12} stroke={2} />
          {addLabel}
        </button>
        <span className="text-2xs text-fg-faint">{hint}</span>
      </div>
    </div>
  );
}
