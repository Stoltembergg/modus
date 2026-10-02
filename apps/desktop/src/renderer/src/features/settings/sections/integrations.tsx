import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconLink,
  IconPlugConnected,
  IconRefresh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  ComposioConnectionOperation,
  ComposioConnectivityResult,
  ComposioSettingsState,
  ComposioToolkitPolicyInput,
  ComposioToolkitSummary,
  ComposioToolSummary,
} from "../../../../../shared/contracts";
import { cn } from "../../../lib/cn";
import { SettingsList, SettingsPageHeader, SettingsSection } from "../settings-layout";

const MAX_ALLOWED_TOOLS = 500;
const CONSUMER_TOOLKIT_SLUG = "composio-for-you";
const CONNECTION_POLL_INTERVAL_MS = 500;
const CONNECTION_POLL_ATTEMPTS = 240;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "The Composio request failed. Try again.";
}

function operationMessage(operation: ComposioConnectionOperation): string | undefined {
  if (operation.status === "active") {
    return `Connected ${operation.alias}. Select this account and choose allowed operations before enabling it for agents.`;
  }
  if (operation.error?.message) return operation.error.message;
  if (operation.status === "canceled")
    return "Authorization was canceled. Start the connection again when you are ready.";
  if (operation.status === "expired")
    return "Authorization expired. Start the connection again to receive a fresh link.";
  if (operation.status === "failed")
    return "The account could not be connected. Check the platform authorization and try again.";
  return undefined;
}

function toolkitDescription(toolkit: ComposioToolkitSummary): string {
  if (!toolkit.accounts.length) return "No accounts connected";
  const selected = toolkit.accounts.find((account) => account.id === toolkit.selectedAccountId);
  if (toolkit.enabled && selected) return `Agents use ${selected.alias}`;
  if (selected) return `${selected.alias} selected · not enabled for agents`;
  return `${toolkit.accounts.length} account${toolkit.accounts.length === 1 ? "" : "s"} connected`;
}

function filterTools(tools: ComposioToolSummary[], query: string): ComposioToolSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tools;
  return tools.filter((tool) =>
    `${tool.name} ${tool.slug} ${tool.description ?? ""}`.toLowerCase().includes(needle),
  );
}

export function IntegrationsSettingsPanel({ standalone = false }: { standalone?: boolean } = {}) {
  const [settings, setSettings] = useState<ComposioSettingsState | undefined>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | undefined>();
  const [apiKey, setApiKey] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [expandedToolkit, setExpandedToolkit] = useState<string | undefined>();
  const [toolsByToolkit, setToolsByToolkit] = useState<Record<string, ComposioToolSummary[]>>({});
  const [toolsLoading, setToolsLoading] = useState<string | undefined>();
  const [toolQueries, setToolQueries] = useState<Record<string, string>>({});
  const [consumerQuery, setConsumerQuery] = useState("");
  const [localError, setLocalError] = useState<string | undefined>();
  const [operation, setOperation] = useState<ComposioConnectionOperation | undefined>();
  const [connectionToolkit, setConnectionToolkit] = useState<string | undefined>();
  const [connectionAlias, setConnectionAlias] = useState("");
  const [renamingAccount, setRenamingAccount] = useState<string | undefined>();
  const [renamedAlias, setRenamedAlias] = useState("");
  const [disconnectingAccount, setDisconnectingAccount] = useState<string | undefined>();
  const [showRemoveKey, setShowRemoveKey] = useState(false);
  const [diagnostic, setDiagnostic] = useState<ComposioConnectivityResult | undefined>();
  const [checkingConnectivity, setCheckingConnectivity] = useState(false);
  const mounted = useRef(true);
  const credentialVersion = useRef(0);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    window.modus.composio
      .getState()
      .then((state: ComposioSettingsState) => {
        if (active) setSettings(state);
      })
      .catch((error: unknown) => {
        if (active) setLocalError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, []);

  const visibleToolkits = useMemo(() => {
    const needle = catalogQuery.trim().toLowerCase();
    const toolkits = settings?.toolkits ?? [];
    if (!needle) return toolkits;
    return toolkits.filter((toolkit) =>
      `${toolkit.name} ${toolkit.slug} ${toolkit.description ?? ""}`.toLowerCase().includes(needle),
    );
  }, [catalogQuery, settings?.toolkits]);

  const currentError = localError ?? settings?.error?.message;
  const consumerMode = settings?.keyType === "consumer";
  const consumer = consumerMode ? settings?.consumer : undefined;
  const consumerTools = consumer?.tools ?? [];
  const consumerSelectedToolSlugs = consumer?.selectedToolSlugs ?? [];
  const visibleConsumerTools = filterTools(consumerTools, consumerQuery);
  const everyVisibleConsumerToolSelected =
    visibleConsumerTools.length > 0 &&
    visibleConsumerTools.every((tool) => consumerSelectedToolSlugs.includes(tool.slug));

  function applySettings(next: ComposioSettingsState): void {
    setSettings(next);
    if (next.status !== "error" || !next.error) setLocalError(undefined);
  }

  function resetCredentialViews(): void {
    credentialVersion.current += 1;
    setToolsByToolkit({});
    setToolsLoading(undefined);
    setExpandedToolkit(undefined);
    setCatalogQuery("");
    setToolQueries({});
    setConsumerQuery("");
    setOperation(undefined);
    setConnectionToolkit(undefined);
    setConnectionAlias("");
    setRenamingAccount(undefined);
    setRenamedAlias("");
    setDisconnectingAccount(undefined);
    setDiagnostic(undefined);
    setCheckingConnectivity(false);
  }

  async function saveApiKey(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const value = apiKey.trim();
    if (!value) {
      setLocalError("Enter a Composio API Key before saving.");
      return;
    }
    setSaving("api-key");
    setLocalError(undefined);
    resetCredentialViews();
    try {
      applySettings(await window.modus.composio.setApiKey({ apiKey: value }));
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setApiKey("");
      setSaving(undefined);
    }
  }

  async function removeApiKey(): Promise<void> {
    setSaving("api-key");
    setLocalError(undefined);
    resetCredentialViews();
    try {
      applySettings(await window.modus.composio.removeApiKey());
      setShowRemoveKey(false);
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setSaving(undefined);
    }
  }

  async function refreshCatalog(): Promise<void> {
    setSaving("catalog");
    setLocalError(undefined);
    resetCredentialViews();
    try {
      applySettings(await window.modus.composio.refreshCatalog());
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setSaving(undefined);
    }
  }

  async function diagnoseConnection(): Promise<void> {
    const version = credentialVersion.current;
    setCheckingConnectivity(true);
    setDiagnostic(undefined);
    setLocalError(undefined);
    try {
      const result = await window.modus.composio.diagnose();
      if (version === credentialVersion.current) setDiagnostic(result);
    } catch (error) {
      if (version === credentialVersion.current) setLocalError(errorMessage(error));
    } finally {
      if (version === credentialVersion.current) setCheckingConnectivity(false);
    }
  }

  async function openToolkit(toolkit: ComposioToolkitSummary): Promise<void> {
    const version = credentialVersion.current;
    if (expandedToolkit === toolkit.slug) {
      setExpandedToolkit(undefined);
      return;
    }
    setExpandedToolkit(toolkit.slug);
    if (toolsByToolkit[toolkit.slug]) return;
    setToolsLoading(toolkit.slug);
    setLocalError(undefined);
    try {
      const tools = await window.modus.composio.listTools({ toolkitSlug: toolkit.slug });
      if (version === credentialVersion.current) {
        setToolsByToolkit((current) => ({ ...current, [toolkit.slug]: tools }));
      }
    } catch (error) {
      if (version === credentialVersion.current) setLocalError(errorMessage(error));
    } finally {
      if (version === credentialVersion.current) setToolsLoading(undefined);
    }
  }

  async function savePolicy(input: ComposioToolkitPolicyInput): Promise<void> {
    const consumerPolicy = consumerMode && input.toolkitSlug === CONSUMER_TOOLKIT_SLUG;
    if (input.selectedToolSlugs.length > MAX_ALLOWED_TOOLS) {
      setLocalError(
        "Select 500 operations or fewer. Search the operation list and allow only what agents need.",
      );
      return;
    }
    if (
      input.enabled &&
      ((!consumerPolicy && !input.selectedAccountId) || input.selectedToolSlugs.length === 0)
    ) {
      setLocalError(
        consumerPolicy
          ? "Select at least one MCP tool before enabling Composio For You for agents."
          : "Select one active account and at least one allowed operation before enabling this platform for agents.",
      );
      return;
    }
    setSaving(input.toolkitSlug);
    setLocalError(undefined);
    try {
      const next = await window.modus.composio.setToolkitPolicy(input);
      applySettings(next);
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setSaving(undefined);
    }
  }

  async function saveConsumerPolicy(
    selectedToolSlugs: string[],
    enabled = consumer?.enabled ?? false,
  ): Promise<void> {
    await savePolicy({
      toolkitSlug: CONSUMER_TOOLKIT_SLUG,
      enabled: enabled && selectedToolSlugs.length > 0,
      selectedToolSlugs,
    });
  }

  async function toggleConsumerTool(toolSlug: string, checked: boolean): Promise<void> {
    const selected = new Set(consumerSelectedToolSlugs);
    if (checked) selected.add(toolSlug);
    else selected.delete(toolSlug);
    await saveConsumerPolicy([...selected]);
  }

  async function selectAccount(toolkit: ComposioToolkitSummary, accountId: string): Promise<void> {
    await savePolicy({
      toolkitSlug: toolkit.slug,
      enabled: toolkit.enabled,
      selectedToolSlugs: toolkit.selectedToolSlugs,
      selectedAccountId: accountId,
    });
  }

  async function toggleTool(
    toolkit: ComposioToolkitSummary,
    toolSlug: string,
    checked: boolean,
  ): Promise<void> {
    const selected = new Set(toolkit.selectedToolSlugs);
    if (checked) selected.add(toolSlug);
    else selected.delete(toolSlug);
    const selectedToolSlugs = [...selected];
    await savePolicy({
      toolkitSlug: toolkit.slug,
      enabled: toolkit.enabled && selectedToolSlugs.length > 0,
      selectedToolSlugs,
      ...(toolkit.selectedAccountId ? { selectedAccountId: toolkit.selectedAccountId } : {}),
    });
  }

  async function toggleToolkit(toolkit: ComposioToolkitSummary, enabled: boolean): Promise<void> {
    const selectedAccount = toolkit.accounts.find(
      (account) => account.id === toolkit.selectedAccountId && account.status === "active",
    );
    await savePolicy({
      toolkitSlug: toolkit.slug,
      enabled,
      selectedToolSlugs: toolkit.selectedToolSlugs,
      ...(selectedAccount ? { selectedAccountId: selectedAccount.id } : {}),
    });
  }

  async function loadLatestState(): Promise<void> {
    const version = credentialVersion.current;
    try {
      const next = await window.modus.composio.getState();
      if (version === credentialVersion.current) applySettings(next);
    } catch (error) {
      if (version === credentialVersion.current) setLocalError(errorMessage(error));
    }
  }

  async function pollConnection(operationId: string): Promise<void> {
    const version = credentialVersion.current;
    for (let attempt = 0; attempt < CONNECTION_POLL_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, CONNECTION_POLL_INTERVAL_MS));
      if (!mounted.current || version !== credentialVersion.current) return;
      try {
        const next = await window.modus.composio.getConnectionOperation({ operationId });
        if (version !== credentialVersion.current) return;
        setOperation(next);
        if (next.status !== "pending") {
          if (next.status === "active") await loadLatestState();
          return;
        }
      } catch (error) {
        setLocalError(errorMessage(error));
        return;
      }
    }
    setLocalError(
      "The connection is taking longer than expected. Finish authorization in your browser, then refresh the catalog.",
    );
  }

  async function startConnection(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!connectionToolkit) return;
    const alias = connectionAlias.trim();
    if (!alias) {
      setLocalError("Enter a name for this account.");
      return;
    }
    setSaving(connectionToolkit);
    setLocalError(undefined);
    setOperation(undefined);
    try {
      const next = await window.modus.composio.startConnection({
        toolkitSlug: connectionToolkit,
        alias,
      });
      setOperation(next);
      setConnectionAlias("");
      setConnectionToolkit(undefined);
      if (next.status === "pending") void pollConnection(next.id);
      else if (next.status === "active") await loadLatestState();
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setSaving(undefined);
    }
  }

  async function renameAccount(toolkitSlug: string, accountId: string): Promise<void> {
    const alias = renamedAlias.trim();
    if (!alias) {
      setLocalError("Enter a name for this account.");
      return;
    }
    setSaving(toolkitSlug);
    setLocalError(undefined);
    try {
      applySettings(await window.modus.composio.renameAccount({ toolkitSlug, accountId, alias }));
      setRenamingAccount(undefined);
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setSaving(undefined);
    }
  }

  async function disconnectAccount(toolkitSlug: string, accountId: string): Promise<void> {
    setSaving(toolkitSlug);
    setLocalError(undefined);
    try {
      applySettings(await window.modus.composio.disconnectAccount({ toolkitSlug, accountId }));
      setDisconnectingAccount(undefined);
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setSaving(undefined);
    }
  }

  if (loading) {
    return (
      <div aria-live="polite" className="text-sm text-fg-muted">
        Loading {standalone ? "connections" : "integrations"}…
      </div>
    );
  }

  return (
    <>
      <SettingsPageHeader
        actions={
          settings?.apiKeyConfigured ? (
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-fg-muted hover:bg-hover disabled:opacity-50"
              disabled={saving !== undefined}
              onClick={() => void refreshCatalog()}
              type="button"
            >
              <IconRefresh size={14} /> Refresh catalog
            </button>
          ) : null
        }
        description={
          consumerMode
            ? "Choose which Composio For You MCP tools agents can use with your personal connected apps."
            : "Connect Composio For You or Platform and choose which tools agents can use."
        }
        title={standalone ? "Connections" : "Composio"}
      />

      <SettingsSection
        description="Stored securely on this device and never displayed again. The connection mode is detected automatically from your key."
        title="Composio API Key"
      >
        <SettingsList>
          <p className="border-hairline-soft border-b px-4 py-3 text-xs text-fg-muted">
            Use a Composio For You key (ck_…) from Settings → Sessions &amp; API Key, or a Composio
            Platform Project API Key from your project → Settings → API Keys.
          </p>
          <form
            className="flex flex-col gap-3 p-4 sm:flex-row"
            onSubmit={(event) => void saveApiKey(event)}
          >
            <label className="flex-1 text-xs text-fg-muted">
              <span className="mb-1.5 block">Composio API Key</span>
              <input
                autoComplete="new-password"
                className="h-9 w-full rounded-md border border-hairline-soft bg-canvas px-3 text-sm text-fg outline-none placeholder:text-fg-faint focus-visible:ring-2 focus-visible:ring-focus-ring/35"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  settings?.apiKeyConfigured
                    ? "Enter a replacement key"
                    : "Paste a For You or Platform Project API Key"
                }
                type="password"
                value={apiKey}
              />
            </label>
            <div className="flex items-end gap-2">
              <button
                className="h-9 rounded-md bg-active px-3 text-sm text-fg hover:bg-hover disabled:opacity-50"
                disabled={saving !== undefined || !apiKey.trim()}
                type="submit"
              >
                {saving === "api-key"
                  ? "Saving…"
                  : settings?.apiKeyConfigured
                    ? "Replace key"
                    : "Save key"}
              </button>
              {settings?.apiKeyConfigured ? (
                <button
                  className="h-9 rounded-md px-3 text-sm text-danger hover:bg-hover disabled:opacity-50"
                  disabled={saving !== undefined}
                  onClick={() => setShowRemoveKey((shown) => !shown)}
                  type="button"
                >
                  Remove key
                </button>
              ) : null}
            </div>
          </form>
          {settings?.apiKeyConfigured ? (
            <div className="border-hairline-soft border-t px-4 py-3 text-xs text-success">
              <p>The key is configured for this local profile and cannot be read back.</p>
              <p className="mt-1">
                Connected mode: {consumerMode ? "Composio For You" : "Composio Platform"}
              </p>
            </div>
          ) : null}
          {showRemoveKey ? (
            <div className="flex items-center justify-between gap-3 border-hairline-soft border-t px-4 py-3">
              <p className="text-xs text-fg-muted">
                Remove the local key? Connected accounts will remain in Composio.
              </p>
              <div className="flex gap-2">
                <button
                  className="rounded-md px-2.5 py-1.5 text-xs text-fg-muted hover:bg-hover"
                  onClick={() => setShowRemoveKey(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="rounded-md bg-danger/15 px-2.5 py-1.5 text-xs text-danger hover:bg-danger/25"
                  disabled={saving !== undefined}
                  onClick={() => void removeApiKey()}
                  type="button"
                >
                  Confirm removal
                </button>
              </div>
            </div>
          ) : null}
        </SettingsList>
      </SettingsSection>

      <SettingsSection
        description={
          consumerMode
            ? "Check the Composio For You MCP connection without enabling tools."
            : "Check API access and MCP session connectivity separately without enabling tools."
        }
        title="Connection diagnostics"
      >
        <SettingsList>
          <div className="flex flex-wrap items-center gap-3 p-4">
            <button
              className="h-9 rounded-md bg-active px-3 text-sm text-fg hover:bg-hover disabled:opacity-50"
              disabled={checkingConnectivity || saving !== undefined || !settings?.apiKeyConfigured}
              onClick={() => void diagnoseConnection()}
              type="button"
            >
              {checkingConnectivity ? "Testing connection…" : "Test connection"}
            </button>
            {diagnostic ? (
              <div aria-live="polite" className="flex flex-col gap-1 text-xs">
                <span className={diagnostic.apiReachable ? "text-success" : "text-danger"}>
                  {consumerMode ? "Composio For You MCP" : "Composio API"}:{" "}
                  {diagnostic.apiReachable ? "reachable" : "unavailable"}
                </span>
                <span className={diagnostic.mcpSessionReady ? "text-success" : "text-danger"}>
                  {consumerMode ? "MCP connection" : "MCP session"}:{" "}
                  {diagnostic.mcpSessionReady ? "connected" : "not connected"}
                </span>
                {diagnostic.error ? (
                  <span className="max-w-xl break-words text-danger">
                    {diagnostic.error.message}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </SettingsList>
      </SettingsSection>

      {currentError ? (
        <div
          aria-label="Composio integration error"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          {currentError}
        </div>
      ) : null}

      {settings?.apiKeyConfigured && consumerMode ? (
        <SettingsSection
          description="MCP discovery and execution tools can access your personal connected apps. Selection controls which MCP tools agents can call; it does not restrict the app actions available inside an execution tool. Manage connected apps in Composio For You."
          title="Composio For You tools"
        >
          <SettingsList>
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="text-xs text-fg">Allowed MCP tools</p>
                <p className="mt-1 text-xs text-fg-muted">
                  {consumerSelectedToolSlugs.length} selected · select tools, then explicitly enable
                  them for agents.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="rounded-md px-2.5 py-1.5 text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
                  disabled={
                    saving !== undefined ||
                    everyVisibleConsumerToolSelected ||
                    visibleConsumerTools.length === 0
                  }
                  onClick={() =>
                    void saveConsumerPolicy([
                      ...new Set([
                        ...consumerSelectedToolSlugs,
                        ...visibleConsumerTools.map((tool) => tool.slug),
                      ]),
                    ])
                  }
                  type="button"
                >
                  Select all
                </button>
                <button
                  className="rounded-md px-2.5 py-1.5 text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
                  disabled={saving !== undefined || consumerSelectedToolSlugs.length === 0}
                  onClick={() => void saveConsumerPolicy([], false)}
                  type="button"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="border-hairline-soft border-t px-4 py-3">
              <label className="block">
                <span className="sr-only">Search Composio For You tools</span>
                <input
                  className="h-8 w-full rounded-md border border-hairline-soft bg-canvas px-2.5 text-xs text-fg outline-none placeholder:text-fg-faint focus-visible:ring-2 focus-visible:ring-focus-ring/35"
                  onChange={(event) => setConsumerQuery(event.target.value)}
                  placeholder="Search MCP tools…"
                  value={consumerQuery}
                />
              </label>
              {visibleConsumerTools.length ? (
                <div className="mt-2 max-h-72 divide-y divide-hairline-soft overflow-y-auto rounded-md border border-hairline-soft">
                  {visibleConsumerTools.map((tool) => (
                    <label
                      className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 hover:bg-hover"
                      key={tool.slug}
                    >
                      <input
                        checked={consumerSelectedToolSlugs.includes(tool.slug)}
                        className="mt-0.5 accent-[var(--color-focus-ring)]"
                        disabled={saving !== undefined}
                        onChange={(event) =>
                          void toggleConsumerTool(tool.slug, event.target.checked)
                        }
                        type="checkbox"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs text-fg">{tool.name}</span>
                        <span className="mt-0.5 block break-words font-mono text-[10px] text-fg-faint">
                          {tool.slug}
                        </span>
                        {tool.description ? (
                          <span className="mt-1 block text-[11px] text-fg-muted">
                            {tool.description}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-xs text-fg-muted">
                  {consumerTools.length
                    ? "No MCP tools match your search."
                    : "No MCP tools discovered yet. Refresh the catalog to try again."}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-hairline-soft border-t p-4">
              <div>
                <p className="text-xs text-fg">Allow agents to use Composio For You</p>
                <p className="mt-1 text-[11px] text-fg-faint">
                  Requires at least one selected MCP tool. Tools remain disabled until you enable
                  them here.
                </p>
              </div>
              <label className="inline-flex items-center gap-2 text-xs text-fg">
                <input
                  aria-checked={consumer?.enabled ?? false}
                  checked={consumer?.enabled ?? false}
                  disabled={saving !== undefined || consumerSelectedToolSlugs.length === 0}
                  onChange={(event) =>
                    void saveConsumerPolicy(consumerSelectedToolSlugs, event.target.checked)
                  }
                  role="switch"
                  type="checkbox"
                />
                Enable for agents
              </label>
            </div>
          </SettingsList>
        </SettingsSection>
      ) : settings?.apiKeyConfigured ? (
        <SettingsSection
          description="Accounts are shared within this local profile. Agents only see the active account and the operations you allow."
          title="Platforms and permissions"
        >
          <label className="relative block">
            <span className="sr-only">Search platforms</span>
            <input
              className="h-9 w-full rounded-md border border-hairline-soft bg-panel px-3 text-sm text-fg outline-none placeholder:text-fg-faint focus-visible:ring-2 focus-visible:ring-focus-ring/35"
              onChange={(event) => setCatalogQuery(event.target.value)}
              placeholder="Search platforms…"
              value={catalogQuery}
            />
          </label>
          {visibleToolkits.length ? (
            <div className="flex flex-col gap-3">
              {visibleToolkits.map((toolkit) => {
                const expanded = expandedToolkit === toolkit.slug;
                const selectedAccount = toolkit.accounts.find(
                  (account) => account.id === toolkit.selectedAccountId,
                );
                const selectedAccountIsActive = selectedAccount?.status === "active";
                const tools = toolsByToolkit[toolkit.slug] ?? [];
                const visibleTools = filterTools(tools, toolQueries[toolkit.slug] ?? "");
                const selectedCount = toolkit.selectedToolSlugs.length;
                const everyVisibleToolSelected =
                  visibleTools.length > 0 &&
                  visibleTools.every((tool) => toolkit.selectedToolSlugs.includes(tool.slug));
                return (
                  <section
                    aria-label={toolkit.name}
                    className="overflow-hidden rounded-lg border border-hairline-soft bg-panel"
                    key={toolkit.slug}
                  >
                    <div className="flex items-center gap-3 px-4 py-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-chip text-fg-muted">
                        <IconPlugConnected size={17} stroke={1.7} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h4 className="text-sm text-fg">{toolkit.name}</h4>
                        <p className="mt-0.5 truncate text-xs text-fg-muted">
                          {toolkit.description || toolkitDescription(toolkit)}
                        </p>
                      </div>
                      {toolkit.enabled ? (
                        <span className="rounded-full bg-success/10 px-2 py-1 text-[11px] text-success">
                          Enabled for agents
                        </span>
                      ) : null}
                      <button
                        aria-expanded={expanded}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                        disabled={saving === toolkit.slug}
                        onClick={() => void openToolkit(toolkit)}
                        type="button"
                      >
                        {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                        Configure
                      </button>
                    </div>
                    {expanded ? (
                      <div className="border-hairline-soft border-t p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h5 className="text-xs font-medium text-fg">Accounts</h5>
                            <p className="mt-1 text-xs text-fg-faint">
                              Choose one active account for agents.
                            </p>
                          </div>
                          <button
                            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                            onClick={() => {
                              setConnectionToolkit(toolkit.slug);
                              setConnectionAlias("");
                              setOperation(undefined);
                              setLocalError(undefined);
                            }}
                            type="button"
                          >
                            <IconLink size={14} /> Connect another account
                          </button>
                        </div>

                        {toolkit.accounts.length ? (
                          <div className="mt-3 divide-y divide-hairline-soft rounded-md border border-hairline-soft">
                            {toolkit.accounts.map((account) => (
                              <div
                                className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                                key={account.id}
                              >
                                <input
                                  aria-label={`${account.alias} (${account.status})`}
                                  checked={toolkit.selectedAccountId === account.id}
                                  className="accent-[var(--color-focus-ring)]"
                                  disabled={account.status !== "active" || saving === toolkit.slug}
                                  name={`composio-account-${toolkit.slug}`}
                                  onChange={() => void selectAccount(toolkit, account.id)}
                                  type="radio"
                                />
                                <div className="min-w-0 flex-1">
                                  {renamingAccount === account.id ? (
                                    <div className="flex gap-2">
                                      <input
                                        aria-label="Rename account"
                                        className="h-7 min-w-0 flex-1 rounded border border-hairline-soft bg-canvas px-2 text-xs text-fg"
                                        maxLength={80}
                                        onChange={(event) => setRenamedAlias(event.target.value)}
                                        value={renamedAlias}
                                      />
                                      <button
                                        aria-label="Save account name"
                                        className="text-success"
                                        onClick={() => void renameAccount(toolkit.slug, account.id)}
                                        type="button"
                                      >
                                        <IconCheck size={15} />
                                      </button>
                                      <button
                                        aria-label="Cancel rename"
                                        className="text-fg-muted"
                                        onClick={() => setRenamingAccount(undefined)}
                                        type="button"
                                      >
                                        <IconX size={15} />
                                      </button>
                                    </div>
                                  ) : (
                                    <>
                                      <div className="truncate text-xs text-fg">
                                        {account.alias}
                                      </div>
                                      <div className="mt-0.5 text-[11px] capitalize text-fg-faint">
                                        {account.status}
                                      </div>
                                    </>
                                  )}
                                </div>
                                {renamingAccount !== account.id ? (
                                  <button
                                    className="rounded px-2 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
                                    onClick={() => {
                                      setRenamingAccount(account.id);
                                      setRenamedAlias(account.alias);
                                    }}
                                    type="button"
                                  >
                                    Rename
                                  </button>
                                ) : null}
                                {disconnectingAccount === account.id ? (
                                  <span className="flex items-center gap-1.5 text-[11px]">
                                    <span className="text-fg-muted">Disconnect?</span>
                                    <button
                                      className="text-danger"
                                      disabled={saving === toolkit.slug}
                                      onClick={() =>
                                        void disconnectAccount(toolkit.slug, account.id)
                                      }
                                      type="button"
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      className="text-fg-muted"
                                      onClick={() => setDisconnectingAccount(undefined)}
                                      type="button"
                                    >
                                      Cancel
                                    </button>
                                  </span>
                                ) : (
                                  <button
                                    aria-label={`Disconnect ${account.alias}`}
                                    className="rounded p-1 text-fg-faint transition-colors hover:bg-hover hover:text-danger"
                                    onClick={() => setDisconnectingAccount(account.id)}
                                    type="button"
                                  >
                                    <IconTrash size={14} />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-3 rounded-md border border-dashed border-hairline-soft px-3 py-4 text-center text-xs text-fg-muted">
                            No connected accounts yet.
                          </p>
                        )}

                        {connectionToolkit === toolkit.slug ? (
                          <form
                            className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-hairline-soft bg-canvas p-3"
                            onSubmit={(event) => void startConnection(event)}
                          >
                            <label className="min-w-[180px] flex-1 text-xs text-fg-muted">
                              <span className="mb-1 block">Account name</span>
                              <input
                                className="h-8 w-full rounded-md border border-hairline-soft bg-panel px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/35"
                                maxLength={80}
                                onChange={(event) => setConnectionAlias(event.target.value)}
                                value={connectionAlias}
                              />
                            </label>
                            <button
                              className="h-8 rounded-md bg-active px-3 text-xs text-fg hover:bg-hover disabled:opacity-50"
                              disabled={saving === toolkit.slug || !connectionAlias.trim()}
                              type="submit"
                            >
                              {saving === toolkit.slug ? "Opening…" : "Connect"}
                            </button>
                            <button
                              className="h-8 rounded-md px-2.5 text-xs text-fg-muted hover:bg-hover"
                              onClick={() => setConnectionToolkit(undefined)}
                              type="button"
                            >
                              Cancel
                            </button>
                          </form>
                        ) : null}

                        {operation?.toolkitSlug === toolkit.slug &&
                        operation.status === "pending" ? (
                          <p
                            aria-live="polite"
                            className="mt-3 flex items-center gap-2 text-xs text-focus-ring"
                          >
                            <span className="size-2 animate-pulse rounded-full bg-focus-ring" />
                            Finish authorization in the browser. Modus is waiting for the account to
                            connect…
                          </p>
                        ) : null}

                        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h5 className="text-xs font-medium text-fg">Allowed operations</h5>
                            <p className="mt-1 text-xs text-fg-faint">
                              {selectedCount} selected · agents can call only these operations
                              through Modus approvals.
                            </p>
                          </div>
                          {tools.length ? (
                            <button
                              className="rounded-md px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
                              disabled={
                                saving === toolkit.slug ||
                                everyVisibleToolSelected ||
                                visibleTools.length === 0
                              }
                              onClick={() => {
                                const selectedToolSlugs = [
                                  ...new Set([
                                    ...toolkit.selectedToolSlugs,
                                    ...visibleTools.map((tool) => tool.slug),
                                  ]),
                                ];
                                if (selectedToolSlugs.length > MAX_ALLOWED_TOOLS) {
                                  setLocalError(
                                    "Select 500 operations or fewer. Search the operation list and allow only what agents need.",
                                  );
                                  return;
                                }
                                void savePolicy({
                                  toolkitSlug: toolkit.slug,
                                  enabled: toolkit.enabled && selectedToolSlugs.length > 0,
                                  selectedToolSlugs,
                                  ...(toolkit.selectedAccountId
                                    ? { selectedAccountId: toolkit.selectedAccountId }
                                    : {}),
                                });
                              }}
                              type="button"
                            >
                              Select all
                            </button>
                          ) : null}
                        </div>
                        {toolsLoading === toolkit.slug ? (
                          <p aria-live="polite" className="mt-3 text-xs text-fg-muted">
                            Loading operations…
                          </p>
                        ) : tools.length ? (
                          <>
                            <label className="mt-3 block">
                              <span className="sr-only">Search {toolkit.name} operations</span>
                              <input
                                className="h-8 w-full rounded-md border border-hairline-soft bg-canvas px-2.5 text-xs text-fg outline-none placeholder:text-fg-faint focus-visible:ring-2 focus-visible:ring-focus-ring/35"
                                onChange={(event) =>
                                  setToolQueries((current) => ({
                                    ...current,
                                    [toolkit.slug]: event.target.value,
                                  }))
                                }
                                placeholder="Search operations…"
                                value={toolQueries[toolkit.slug] ?? ""}
                              />
                            </label>
                            {visibleTools.length ? (
                              <div className="mt-2 max-h-72 divide-y divide-hairline-soft overflow-y-auto rounded-md border border-hairline-soft">
                                {visibleTools.map((tool) => (
                                  <label
                                    className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 hover:bg-hover"
                                    key={tool.slug}
                                  >
                                    <input
                                      checked={toolkit.selectedToolSlugs.includes(tool.slug)}
                                      className="mt-0.5 accent-[var(--color-focus-ring)]"
                                      disabled={saving === toolkit.slug}
                                      onChange={(event) =>
                                        void toggleTool(toolkit, tool.slug, event.target.checked)
                                      }
                                      type="checkbox"
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="block text-xs text-fg">{tool.name}</span>
                                      <span className="mt-0.5 block truncate font-mono text-[10px] text-fg-faint">
                                        {tool.slug}
                                      </span>
                                      {tool.description ? (
                                        <span className="mt-1 block text-[11px] text-fg-muted">
                                          {tool.description}
                                        </span>
                                      ) : null}
                                    </span>
                                  </label>
                                ))}
                              </div>
                            ) : (
                              <p className="mt-3 text-xs text-fg-muted">
                                No operations match this search.
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="mt-3 text-xs text-fg-muted">
                            No operations are available for this platform.
                          </p>
                        )}
                        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-hairline-soft pt-3">
                          <div>
                            <p className="text-xs text-fg">Allow agents to use this platform</p>
                            <p className="mt-1 text-[11px] text-fg-faint">
                              Requires one active account and at least one selected operation.
                            </p>
                          </div>
                          <label
                            className={cn(
                              "inline-flex items-center gap-2 text-xs",
                              selectedAccountIsActive && selectedCount
                                ? "text-fg"
                                : "text-fg-faint",
                            )}
                          >
                            <input
                              checked={toolkit.enabled}
                              disabled={
                                !selectedAccountIsActive ||
                                selectedCount === 0 ||
                                saving === toolkit.slug
                              }
                              onChange={(event) =>
                                void toggleToolkit(toolkit, event.target.checked)
                              }
                              type="checkbox"
                            />
                            Enabled
                          </label>
                        </div>
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-hairline-soft bg-panel px-5 py-8 text-center">
              <p className="text-sm text-fg">
                {settings?.toolkits.length
                  ? "No platforms match your search."
                  : "No platforms loaded yet."}
              </p>
              <p className="mt-1 text-xs text-fg-muted">
                Refresh the catalog to discover platforms available to this Composio project.
              </p>
            </div>
          )}
        </SettingsSection>
      ) : (
        <div className="rounded-lg border border-dashed border-hairline-soft bg-panel px-5 py-8 text-center">
          <IconPlugConnected className="mx-auto text-fg-faint" size={22} />
          <p className="mt-3 text-sm text-fg">Add a Composio API Key to connect your apps</p>
          <p className="mt-1 text-xs text-fg-muted">
            The generic MCP settings remain available separately for custom servers.
          </p>
        </div>
      )}

      {operation?.status === "active" ? (
        <p aria-live="polite" className="text-xs text-success">
          {operationMessage(operation)}
        </p>
      ) : null}
      {operation && ["canceled", "expired", "failed"].includes(operation.status) ? (
        <p
          aria-live="assertive"
          className="rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger"
          role="alert"
        >
          {operationMessage(operation)}
        </p>
      ) : null}
      {settings?.status === "error" && settings.apiKeyConfigured ? (
        <button
          className="self-start rounded-md px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          disabled={saving !== undefined}
          onClick={() => void refreshCatalog()}
          type="button"
        >
          Retry synchronization
        </button>
      ) : null}
      {currentError ? (
        <p
          aria-live="assertive"
          className="rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger"
          role="status"
        >
          {currentError}
        </p>
      ) : null}
    </>
  );
}
