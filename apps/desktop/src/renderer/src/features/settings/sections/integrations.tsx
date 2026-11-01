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
import { type SettingsTextFn, settingsTextFor, useSettingsText } from "../../../lib/settingsText";
import { Disclosure } from "../form-controls";
import { SettingsList, SettingsPageHeader, SettingsSection } from "../settings-layout";

const MAX_ALLOWED_TOOLS = 500;
const CONSUMER_TOOLKIT_SLUG = "composio-for-you";
const CONNECTION_POLL_INTERVAL_MS = 500;
const CONNECTION_POLL_ATTEMPTS = 240;

function errorMessage(error: unknown, t: SettingsTextFn = settingsTextFor()): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : t("settings.integrations.requestFailed");
}

function operationMessage(
  operation: ComposioConnectionOperation,
  t: SettingsTextFn = settingsTextFor(),
): string | undefined {
  if (operation.status === "active") {
    return t("settings.integrations.operationConnected", { alias: operation.alias });
  }
  if (operation.error?.message) return operation.error.message;
  if (operation.status === "canceled") return t("settings.integrations.authorizationCanceled");
  if (operation.status === "expired") return t("settings.integrations.authorizationExpired");
  if (operation.status === "failed") return t("settings.integrations.connectionFailed");
  return undefined;
}

function toolkitDescription(
  toolkit: ComposioToolkitSummary,
  t: SettingsTextFn = settingsTextFor(),
): string {
  if (!toolkit.accounts.length) return t("settings.integrations.noAccountsConnected");
  const selected = toolkit.accounts.find((account) => account.id === toolkit.selectedAccountId);
  if (toolkit.enabled && selected) {
    return t("settings.integrations.agentsUseAccount", { alias: selected.alias });
  }
  if (selected) {
    return t("settings.integrations.accountSelectedNotEnabled", { alias: selected.alias });
  }
  return t.plural("settings.integrations.accountsConnected", toolkit.accounts.length);
}

function filterTools(tools: ComposioToolSummary[], query: string): ComposioToolSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tools;
  return tools.filter((tool) =>
    `${tool.name} ${tool.slug} ${tool.description ?? ""}`.toLowerCase().includes(needle),
  );
}

export function IntegrationsSettingsPanel({ standalone = false }: { standalone?: boolean } = {}) {
  const t = useSettingsText();
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
        if (active) setLocalError(errorMessage(error, t));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [t]);

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
      setLocalError(t("settings.integrations.enterApiKeyBeforeSaving"));
      return;
    }
    setSaving("api-key");
    setLocalError(undefined);
    resetCredentialViews();
    try {
      applySettings(await window.modus.composio.setApiKey({ apiKey: value }));
    } catch (error) {
      setLocalError(errorMessage(error, t));
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
      setLocalError(errorMessage(error, t));
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
      setLocalError(errorMessage(error, t));
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
      if (version === credentialVersion.current) setLocalError(errorMessage(error, t));
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
      if (version === credentialVersion.current) setLocalError(errorMessage(error, t));
    } finally {
      if (version === credentialVersion.current) setToolsLoading(undefined);
    }
  }

  async function savePolicy(input: ComposioToolkitPolicyInput): Promise<void> {
    const consumerPolicy = consumerMode && input.toolkitSlug === CONSUMER_TOOLKIT_SLUG;
    if (input.selectedToolSlugs.length > MAX_ALLOWED_TOOLS) {
      setLocalError(t("settings.integrations.tooManyOperationsSelected"));
      return;
    }
    if (
      input.enabled &&
      ((!consumerPolicy && !input.selectedAccountId) || input.selectedToolSlugs.length === 0)
    ) {
      setLocalError(
        consumerPolicy
          ? t("settings.integrations.selectToolBeforeEnablingConsumer")
          : t("settings.integrations.selectAccountAndOperationBeforeEnablingPlatform"),
      );
      return;
    }
    setSaving(input.toolkitSlug);
    setLocalError(undefined);
    try {
      const next = await window.modus.composio.setToolkitPolicy(input);
      applySettings(next);
    } catch (error) {
      setLocalError(errorMessage(error, t));
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
      if (version === credentialVersion.current) setLocalError(errorMessage(error, t));
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
        setLocalError(errorMessage(error, t));
        return;
      }
    }
    setLocalError(t("settings.integrations.connectionTakingLonger"));
  }

  async function startConnection(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!connectionToolkit) return;
    const alias = connectionAlias.trim();
    if (!alias) {
      setLocalError(t("settings.integrations.enterAccountName"));
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
      setLocalError(errorMessage(error, t));
    } finally {
      setSaving(undefined);
    }
  }

  async function renameAccount(toolkitSlug: string, accountId: string): Promise<void> {
    const alias = renamedAlias.trim();
    if (!alias) {
      setLocalError(t("settings.integrations.enterAccountName"));
      return;
    }
    setSaving(toolkitSlug);
    setLocalError(undefined);
    try {
      applySettings(await window.modus.composio.renameAccount({ toolkitSlug, accountId, alias }));
      setRenamingAccount(undefined);
    } catch (error) {
      setLocalError(errorMessage(error, t));
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
      setLocalError(errorMessage(error, t));
    } finally {
      setSaving(undefined);
    }
  }

  if (loading) {
    return (
      <div aria-live="polite" className="text-sm text-fg-muted">
        {standalone
          ? t("settings.integrations.loadingConnections")
          : t("settings.integrations.loadingIntegrations")}
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
              <IconRefresh size={14} /> {t("settings.integrations.refreshCatalog")}
            </button>
          ) : null
        }
        title={
          standalone
            ? t("settings.integrations.titleConnections")
            : t("settings.integrations.titleComposio")
        }
      />

      <SettingsSection title={t("settings.integrations.apiKeySectionTitle")}>
        <SettingsList>
          <div className="px-4 pt-3">
            <Disclosure label={t("settings.integrations.whereToFindKey")}>
              <p className="text-xs leading-5 text-fg-muted">
                {t("settings.integrations.whereToFindKeyHelp")}
              </p>
            </Disclosure>
          </div>
          <form
            className="flex flex-col gap-3 p-4 sm:flex-row"
            onSubmit={(event) => void saveApiKey(event)}
          >
            <label className="flex-1 text-xs text-fg-muted">
              <span className="mb-1.5 block">{t("settings.integrations.apiKeyLabel")}</span>
              <input
                autoComplete="new-password"
                className="h-9 w-full rounded-md bg-canvas px-3 text-sm text-fg outline-none placeholder:text-fg-faint focus-visible:ring-2 focus-visible:ring-focus-ring"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  settings?.apiKeyConfigured
                    ? t("settings.integrations.apiKeyPlaceholderReplace")
                    : t("settings.integrations.apiKeyPlaceholderInitial")
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
                  ? t("settings.integrations.saving")
                  : settings?.apiKeyConfigured
                    ? t("settings.integrations.replaceKey")
                    : t("settings.integrations.saveKey")}
              </button>
              {settings?.apiKeyConfigured ? (
                <button
                  className="h-9 rounded-md px-3 text-sm text-danger hover:bg-hover disabled:opacity-50"
                  disabled={saving !== undefined}
                  onClick={() => setShowRemoveKey((shown) => !shown)}
                  type="button"
                >
                  {t("settings.integrations.removeKey")}
                </button>
              ) : null}
            </div>
          </form>
          {settings?.apiKeyConfigured ? (
            <div className=" px-4 py-3 text-xs text-success">
              <p>{t("settings.integrations.keySavedForProfile")}</p>
              <p className="mt-1">
                {t("settings.integrations.connectedMode", {
                  mode: consumerMode
                    ? t("settings.integrations.modeConsumer")
                    : t("settings.integrations.modePlatform"),
                })}
              </p>
            </div>
          ) : null}
          {showRemoveKey ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <p className="text-xs text-fg-muted">
                {t("settings.integrations.removeKeyConfirmPrompt")}
              </p>
              <div className="flex gap-2">
                <button
                  className="rounded-md px-2.5 py-1.5 text-xs text-fg-muted hover:bg-hover"
                  onClick={() => setShowRemoveKey(false)}
                  type="button"
                >
                  {t("settings.integrations.cancel")}
                </button>
                <button
                  className="rounded-md bg-danger/15 px-2.5 py-1.5 text-xs text-danger hover:bg-danger/25"
                  disabled={saving !== undefined}
                  onClick={() => void removeApiKey()}
                  type="button"
                >
                  {t("settings.integrations.confirmRemoval")}
                </button>
              </div>
            </div>
          ) : null}
        </SettingsList>
      </SettingsSection>

      <SettingsSection title={t("settings.integrations.diagnosticsTitle")}>
        <SettingsList>
          <div className="flex flex-wrap items-center gap-3 p-4">
            <button
              className="h-9 rounded-md bg-active px-3 text-sm text-fg hover:bg-hover disabled:opacity-50"
              disabled={checkingConnectivity || saving !== undefined || !settings?.apiKeyConfigured}
              onClick={() => void diagnoseConnection()}
              type="button"
            >
              {checkingConnectivity
                ? t("settings.integrations.testingConnection")
                : t("settings.integrations.testConnection")}
            </button>
            {diagnostic ? (
              <div aria-live="polite" className="flex flex-col gap-1 text-xs">
                <span className={diagnostic.apiReachable ? "text-success" : "text-danger"}>
                  {t("settings.integrations.diagnosticStatus", {
                    target: consumerMode
                      ? t("settings.integrations.diagnosticTargetConsumerMcp")
                      : t("settings.integrations.diagnosticTargetApi"),
                    status: diagnostic.apiReachable
                      ? t("settings.integrations.diagnosticReachable")
                      : t("settings.integrations.diagnosticUnavailable"),
                  })}
                </span>
                <span className={diagnostic.mcpSessionReady ? "text-success" : "text-danger"}>
                  {t("settings.integrations.diagnosticStatus", {
                    target: consumerMode
                      ? t("settings.integrations.diagnosticTargetConsumerConnection")
                      : t("settings.integrations.diagnosticTargetSession"),
                    status: diagnostic.mcpSessionReady
                      ? t("settings.integrations.diagnosticConnected")
                      : t("settings.integrations.diagnosticNotConnected"),
                  })}
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
          aria-label={t("settings.integrations.integrationErrorAriaLabel")}
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          {currentError}
        </div>
      ) : null}

      {settings?.apiKeyConfigured && consumerMode ? (
        <SettingsSection title={t("settings.integrations.consumerToolsTitle")}>
          <SettingsList>
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="text-xs text-fg">{t("settings.integrations.allowedMcpTools")}</p>
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
                  {t("settings.integrations.selectAll")}
                </button>
                <button
                  className="rounded-md px-2.5 py-1.5 text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
                  disabled={saving !== undefined || consumerSelectedToolSlugs.length === 0}
                  onClick={() => void saveConsumerPolicy([], false)}
                  type="button"
                >
                  {t("settings.integrations.clearSelection")}
                </button>
              </div>
            </div>
            <div className=" px-4 py-3">
              <label className="block">
                <span className="sr-only">{t("settings.integrations.searchConsumerTools")}</span>
                <input
                  className="h-8 w-full rounded-md bg-canvas px-2.5 text-xs text-fg outline-none placeholder:text-fg-faint focus-visible:ring-2 focus-visible:ring-focus-ring"
                  onChange={(event) => setConsumerQuery(event.target.value)}
                  placeholder={t("settings.integrations.searchConsumerToolsPlaceholder")}
                  value={consumerQuery}
                />
              </label>
              {visibleConsumerTools.length ? (
                <div className="mt-2 max-h-72 overflow-y-auto rounded-md bg-chip-faint">
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
                    ? t("settings.integrations.noMatchingConsumerTools")
                    : t("settings.integrations.noConsumerToolsDiscovered")}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="text-xs text-fg">
                  {t("settings.integrations.allowConsumerForAgents")}
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
                {t("settings.integrations.enableForAgents")}
              </label>
            </div>
          </SettingsList>
        </SettingsSection>
      ) : settings?.apiKeyConfigured ? (
        <SettingsSection title={t("settings.integrations.platformsAndPermissionsTitle")}>
          <label className="relative block">
            <span className="sr-only">{t("settings.integrations.searchPlatforms")}</span>
            <input
              className="h-9 w-full rounded-md bg-panel px-3 text-sm text-fg outline-none placeholder:text-fg-faint focus-visible:ring-2 focus-visible:ring-focus-ring"
              onChange={(event) => setCatalogQuery(event.target.value)}
              placeholder={t("settings.integrations.searchPlatformsPlaceholder")}
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
                    className="overflow-hidden settings-group"
                    key={toolkit.slug}
                  >
                    <div className="flex items-center gap-3 px-4 py-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-chip text-fg-muted">
                        <IconPlugConnected size={17} stroke={1.7} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h4 className="text-sm text-fg">{toolkit.name}</h4>
                        <p className="mt-0.5 truncate text-xs text-fg-muted">
                          {toolkit.description || toolkitDescription(toolkit, t)}
                        </p>
                      </div>
                      {toolkit.enabled ? (
                        <span className="rounded-full bg-success/10 px-2 py-1 text-[11px] text-success">
                          {t("settings.integrations.enabledForAgentsBadge")}
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
                        {t("settings.integrations.configure")}
                      </button>
                    </div>
                    {expanded ? (
                      <div className=" p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h5 className="text-xs font-medium text-fg">
                              {t("settings.integrations.accountsHeading")}
                            </h5>
                            <p className="mt-1 text-xs text-fg-muted">
                              {t("settings.integrations.accountsSubheading")}
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
                            <IconLink size={14} />{" "}
                            {t("settings.integrations.connectAnotherAccount")}
                          </button>
                        </div>

                        {toolkit.accounts.length ? (
                          <div className="mt-3 rounded-md bg-chip-faint">
                            {toolkit.accounts.map((account) => (
                              <div
                                className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                                key={account.id}
                              >
                                <input
                                  aria-label={t("settings.integrations.accountRadioAriaLabel", {
                                    alias: account.alias,
                                    status: account.status,
                                  })}
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
                                        aria-label={t(
                                          "settings.integrations.renameAccountAriaLabel",
                                        )}
                                        className="h-7 min-w-0 flex-1 rounded border border-hairline-soft bg-canvas px-2 text-xs text-fg"
                                        maxLength={80}
                                        onChange={(event) => setRenamedAlias(event.target.value)}
                                        value={renamedAlias}
                                      />
                                      <button
                                        aria-label={t(
                                          "settings.integrations.saveAccountNameAriaLabel",
                                        )}
                                        className="text-success"
                                        onClick={() => void renameAccount(toolkit.slug, account.id)}
                                        type="button"
                                      >
                                        <IconCheck size={15} />
                                      </button>
                                      <button
                                        aria-label={t(
                                          "settings.integrations.cancelRenameAriaLabel",
                                        )}
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
                                      <div className="mt-0.5 text-[11px] capitalize text-fg-muted">
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
                                    {t("settings.integrations.renameAccount")}
                                  </button>
                                ) : null}
                                {disconnectingAccount === account.id ? (
                                  <span className="flex items-center gap-1.5 text-[11px]">
                                    <span className="text-fg-muted">
                                      {t("settings.integrations.disconnectPrompt")}
                                    </span>
                                    <button
                                      className="text-danger"
                                      disabled={saving === toolkit.slug}
                                      onClick={() =>
                                        void disconnectAccount(toolkit.slug, account.id)
                                      }
                                      type="button"
                                    >
                                      {t("settings.integrations.confirm")}
                                    </button>
                                    <button
                                      className="text-fg-muted"
                                      onClick={() => setDisconnectingAccount(undefined)}
                                      type="button"
                                    >
                                      {t("settings.integrations.cancel")}
                                    </button>
                                  </span>
                                ) : (
                                  <button
                                    aria-label={t(
                                      "settings.integrations.disconnectAccountAriaLabel",
                                      {
                                        alias: account.alias,
                                      },
                                    )}
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
                          <p className="mt-3 rounded-md bg-chip-faint px-3 py-4 text-center text-xs text-fg-muted">
                            {t("settings.integrations.noConnectedAccountsYet")}
                          </p>
                        )}

                        {connectionToolkit === toolkit.slug ? (
                          <form
                            className="mt-3 flex flex-wrap items-end gap-2 rounded-md bg-canvas p-3"
                            onSubmit={(event) => void startConnection(event)}
                          >
                            <label className="min-w-[180px] flex-1 text-xs text-fg-muted">
                              <span className="mb-1 block">
                                {t("settings.integrations.accountNameLabel")}
                              </span>
                              <input
                                className="h-8 w-full rounded-md bg-panel px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
                              {saving === toolkit.slug
                                ? t("settings.integrations.opening")
                                : t("settings.integrations.connect")}
                            </button>
                            <button
                              className="h-8 rounded-md px-2.5 text-xs text-fg-muted hover:bg-hover"
                              onClick={() => setConnectionToolkit(undefined)}
                              type="button"
                            >
                              {t("settings.integrations.cancel")}
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
                            {t("settings.integrations.waitingForConnection")}
                          </p>
                        ) : null}

                        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h5 className="text-xs font-medium text-fg">
                              {t("settings.integrations.allowedOperationsHeading")}
                            </h5>
                            <p className="mt-1 text-xs text-fg-muted">
                              {t("settings.integrations.allowedOperationsHint", {
                                count: selectedCount,
                              })}
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
                                    t("settings.integrations.tooManyOperationsSelected"),
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
                              {t("settings.integrations.selectAll")}
                            </button>
                          ) : null}
                        </div>
                        {toolsLoading === toolkit.slug ? (
                          <p aria-live="polite" className="mt-3 text-xs text-fg-muted">
                            {t("settings.integrations.loadingOperations")}
                          </p>
                        ) : tools.length ? (
                          <>
                            <label className="mt-3 block">
                              <span className="sr-only">
                                {t("settings.integrations.searchPlatformOperations", {
                                  name: toolkit.name,
                                })}
                              </span>
                              <input
                                className="h-8 w-full rounded-md bg-canvas px-2.5 text-xs text-fg outline-none placeholder:text-fg-faint focus-visible:ring-2 focus-visible:ring-focus-ring"
                                onChange={(event) =>
                                  setToolQueries((current) => ({
                                    ...current,
                                    [toolkit.slug]: event.target.value,
                                  }))
                                }
                                placeholder={t("settings.integrations.searchOperationsPlaceholder")}
                                value={toolQueries[toolkit.slug] ?? ""}
                              />
                            </label>
                            {visibleTools.length ? (
                              <div className="mt-2 max-h-72 overflow-y-auto rounded-md bg-chip-faint">
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
                                {t("settings.integrations.noMatchingOperations")}
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="mt-3 text-xs text-fg-muted">
                            {t("settings.integrations.noOperationsAvailable")}
                          </p>
                        )}
                        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 pt-3">
                          <div>
                            <p className="text-xs text-fg">
                              {t("settings.integrations.allowPlatformForAgents")}
                            </p>
                            <p className="mt-1 text-[11px] text-fg-muted">
                              {t("settings.integrations.allowPlatformRequirements")}
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
                            {t("settings.integrations.enabled")}
                          </label>
                        </div>
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="settings-group px-5 py-8 text-center">
              <p className="text-sm text-fg">
                {settings?.toolkits.length
                  ? t("settings.integrations.noMatchingPlatforms")
                  : t("settings.integrations.noPlatformsLoaded")}
              </p>
            </div>
          )}
        </SettingsSection>
      ) : (
        <div className="settings-group px-5 py-8 text-center">
          <IconPlugConnected className="mx-auto text-fg-faint" size={22} />
          <p className="mt-3 text-sm text-fg">{t("settings.integrations.addKeyPrompt")}</p>
        </div>
      )}

      {operation?.status === "active" ? (
        <p aria-live="polite" className="text-xs text-success">
          {operationMessage(operation, t)}
        </p>
      ) : null}
      {operation && ["canceled", "expired", "failed"].includes(operation.status) ? (
        <p
          aria-live="assertive"
          className="rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger"
          role="alert"
        >
          {operationMessage(operation, t)}
        </p>
      ) : null}
      {settings?.status === "error" && settings.apiKeyConfigured ? (
        <button
          className="self-start rounded-md px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          disabled={saving !== undefined}
          onClick={() => void refreshCatalog()}
          type="button"
        >
          {t("settings.integrations.retrySynchronization")}
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
