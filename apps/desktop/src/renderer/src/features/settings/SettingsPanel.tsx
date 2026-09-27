import { Dialog } from "@base-ui/react/dialog";
import { Switch } from "@base-ui/react/switch";
import {
  IconAdjustments,
  IconArchiveOff,
  IconArrowLeft,
  IconBrain,
  IconBulb,
  IconCheck,
  IconChevronRight,
  IconCodeDots,
  IconCopy,
  IconCube,
  IconEdit,
  IconExternalLink,
  IconFileText,
  IconFilter,
  IconGauge,
  IconGavel,
  IconKey,
  IconMoon,
  IconMoonStars,
  IconPalette,
  IconPlugConnected,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconServerCog,
  IconSettings,
  IconSun,
  IconTerminal2,
  IconTrash,
  IconUser,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { joinCommandLine, splitCommandLine } from "../../../../shared/command-line";
import type {
  ConfigScope,
  CustomProviderConfig,
  HarnessInsight,
  HarnessInsightConfidence,
  HarnessInsightsQuery,
  HarnessInsightsResult,
  McpServerInfo,
  ModelInfo,
  ModelProviderDetail,
  ModelProviderInfo,
  ModelSettingsState,
  PersonalizationState,
  ProjectMemoryCategory,
  ProjectMemoryExternalReference,
  ProjectMemoryRecord,
  ProjectMemoryScope,
  ProjectMemorySnapshot,
  ProjectMemoryStatus,
  ProviderAccountUsage,
  ProviderAuthOperationState,
  ProviderConnectionMethod,
  ProviderLimitsState,
  ProviderModelConfig,
  ProviderUsageMessage,
  ProviderUsageMetric,
  ProviderUsageStatus,
  RuleFileInfo,
  RuleMode,
  RuleSource,
  SkillInfo,
  SubagentDetail,
  SubagentInfo,
  WorkspaceAgentsState,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../../shared/contracts";
import { CollapsibleMotion } from "../../components/ui/CollapsibleMotion";
import { ContentTransition } from "../../components/ui/ContentTransition";
import { EmptyState } from "../../components/ui/Panel";
import { ShinyText } from "../../components/ui/ShinyText";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { formatClock } from "../../lib/formatClock";
import {
  modelThinkingOptions,
  selectedThinkingLabel,
  selectedThinkingOption,
} from "../../lib/modelThinking";
import { type ThemeMode, useTheme } from "../../lib/theme";
import { ApprovalModeSettings } from "./ApprovalModeSettings";
import { CustomProviderForm } from "./CustomProviderForm";
import { Field, parsePositiveInteger, SelectField, SwitchControl } from "./form-controls";
import { groupProviderModels, modelResultLabel } from "./modelListUtils";
import { ProviderLogo } from "./ProviderLogo";

type SettingsPanelProps = {
  state: ModelSettingsState | null;
  onClose(): void;
  onRefresh(): void;
  onRefreshCatalog(): Promise<void>;
  initialSection?: SettingsSectionId;
  /** Active workspace root — enables the MCP section's config + sync actions. */
  workspaceCwd?: string | undefined;
  /** Recent workspaces — used as project MCP scopes. */
  workspaces?: WorkspaceInfo[] | undefined;
  /** Active project scope for the memory manager; omitted in Inbox. */
  workspaceId?: string | undefined;
};

type SettingsSectionId =
  | "general"
  | "model-provider"
  | "appearance"
  | "personalization"
  | "skills"
  | "subagents"
  | "mcp"
  | "rules"
  | "project-memory"
  | "harness-insights"
  | "limits";
type ModelConfigPatch = {
  thinkingVariant?: string;
  contextWindow?: number;
  maxTokens?: number;
};

export function SettingsPanel({
  state,
  onClose,
  onRefresh,
  onRefreshCatalog,
  workspaceId,
  workspaceCwd,
  workspaces = [],
  initialSection = "model-provider",
}: SettingsPanelProps) {
  const reduceMotion = useReducedMotion();
  const closeStartedRef = useRef(false);
  const [isClosing, setIsClosing] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | undefined>();
  const [detail, setDetail] = useState<ModelProviderDetail | undefined>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [providerDetailOpen, setProviderDetailOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customInitial, setCustomInitial] = useState<CustomProviderConfig | undefined>();
  const [connectionProvider, setConnectionProvider] = useState<ModelProviderInfo | undefined>();
  const [connectionMethods, setConnectionMethods] = useState<ProviderConnectionMethod[]>([]);
  const [authOperation, setAuthOperation] = useState<ProviderAuthOperationState | undefined>();
  const authOperationRef = useRef(authOperation);
  authOperationRef.current = authOperation;
  const [credentialEditorProvider, setCredentialEditorProvider] = useState<string | undefined>();
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({});
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection);
  const [settingsQuery, setSettingsQuery] = useState("");

  const providers = state?.providers ?? [];
  const connected = providers.filter(
    (provider) => provider.configured || provider.enabledModelCount > 0,
  );
  const popular = providers.filter(
    (provider) => !connected.some((item) => item.id === provider.id),
  );
  const currentProvider = providers.find((provider) => provider.id === selectedProvider);

  const closeSettings = (): void => {
    if (closeStartedRef.current) {
      return;
    }
    closeStartedRef.current = true;
    setIsClosing(true);
  };

  useEffect(
    () => () => {
      const operationId = authOperationRef.current?.id;
      if (operationId) {
        void window.modus.model.cancelProviderAuth({ operationId }).catch(() => undefined);
      }
    },
    [],
  );

  useEffect(() => {
    if (!selectedProvider) {
      setDetail(undefined);
      setDetailLoading(false);
      return;
    }
    let alive = true;
    setError(undefined);
    setDetail(undefined);
    setDetailLoading(true);
    void window.modus.model
      .providerDetail(selectedProvider)
      .then((next: ModelProviderDetail | undefined) => {
        if (alive) setDetail(next);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedProvider]);

  async function connectProvider(
    provider: ModelProviderInfo,
    apiKey?: string,
    baseUrl?: string,
  ): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const providerDetail: ModelProviderDetail | undefined =
        await window.modus.model.providerDetail(provider.id);
      await window.modus.model.configureProvider({
        provider: provider.id,
        apiKey: apiKey?.trim(),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        enabledModelIds: providerDetail?.models.map((model) => model.id),
      });
      setProviderKeys((current) => ({ ...current, [provider.id]: "" }));
      setCredentialEditorProvider(undefined);
      onRefresh();
      setSelectedProvider(provider.id);
      setDetail(await window.modus.model.providerDetail(provider.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleModel(model: ProviderModelConfig, enabled: boolean): Promise<void> {
    if (!detail) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await window.modus.model.updateConfig({
        model: `${detail.id}/${model.id}`,
        enabled,
      });
      onRefresh();
      setDetail(await window.modus.model.providerDetail(detail.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function setAllProviderModels(enabled: boolean): Promise<void> {
    if (!detail) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setDetail(
        await window.modus.model.setProviderModelsEnabled({
          provider: detail.id,
          enabled,
        }),
      );
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function editModel(model: ProviderModelConfig, patch: ModelConfigPatch): Promise<void> {
    if (!detail) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await window.modus.model.updateConfig({ model: `${detail.id}/${model.id}`, ...patch });
      onRefresh();
      setDetail(await window.modus.model.providerDetail(detail.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function openCustomEditor(providerId: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const config = await window.modus.model.customProviderConfig(providerId);
      setCustomInitial(config ?? undefined);
      setActiveSection("model-provider");
      setProviderDetailOpen(false);
      setCustomOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteProvider(provider: ModelProviderInfo): Promise<void> {
    const confirmed = window.confirm(
      `Remove "${provider.name}"? This deletes its local configuration and models from Modus.`,
    );
    if (!confirmed) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await window.modus.model.deleteCustomProvider(provider.id);
      if (selectedProvider === provider.id) {
        setSelectedProvider(undefined);
        setDetail(undefined);
        setProviderDetailOpen(false);
      }
      setCustomOpen(false);
      setCustomInitial(undefined);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnectProvider(provider: ModelProviderInfo): Promise<void> {
    const keepsDefinition =
      provider.source === "custom"
        ? " Its endpoint and model definition will remain for reconnection."
        : " Any Modus base URL override will also be removed.";
    const confirmed = window.confirm(
      `Disconnect "${provider.name}"? This removes saved credentials and enabled models from Modus.${keepsDefinition}`,
    );
    if (!confirmed) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await window.modus.model.disconnectProvider(provider.id);
      setProviderKeys((current) => ({ ...current, [provider.id]: "" }));
      setProviderDetailOpen(false);
      setSelectedProvider(undefined);
      setDetail(undefined);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function selectProvider(provider: ModelProviderInfo): Promise<void> {
    setCustomOpen(false);
    setCredentialEditorProvider(undefined);
    setDetail(undefined);
    setDetailLoading(true);
    setSelectedProvider(provider.id);

    const connectedProvider = provider.configured || provider.enabledModelCount > 0;
    if (provider.source === "custom" && !connectedProvider) {
      await openCustomEditor(provider.id);
      return;
    }
    if (connectedProvider) {
      setProviderDetailOpen(true);
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      const methods = await window.modus.model.connectionMethods(provider.id);
      if (methods.length > 1) {
        setConnectionMethods(methods);
        setConnectionProvider(provider);
        return;
      }
      setProviderDetailOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProviderDetailOpen(true);
    } finally {
      setBusy(false);
    }
  }

  async function openProviderConnection(provider: ModelProviderInfo): Promise<void> {
    if (provider.source === "custom") {
      await openCustomEditor(provider.id);
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      const methods = await window.modus.model.connectionMethods(provider.id);
      if (methods.length > 1) {
        setConnectionMethods(methods);
        setConnectionProvider(provider);
        return;
      }
      setCredentialEditorProvider(provider.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startProviderAuth(provider: ModelProviderInfo): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const operation = await window.modus.model.startProviderAuth({ provider: provider.id });
      setConnectionProvider(undefined);
      setAuthOperation(operation);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function respondProviderAuth(value: string | undefined): Promise<void> {
    if (!authOperation) {
      return;
    }
    setBusy(true);
    try {
      await window.modus.model.respondProviderAuth({ operationId: authOperation.id, value });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAuthOperation(undefined);
    } finally {
      setBusy(false);
    }
  }

  function cancelProviderAuth(): void {
    if (authOperation) {
      void window.modus.model.cancelProviderAuth({ operationId: authOperation.id });
    }
    setAuthOperation(undefined);
  }

  useEffect(() => {
    const operationId = authOperation?.id;
    if (!operationId) {
      return;
    }
    let alive = true;
    const poll = () => {
      void window.modus.model
        .providerAuthState({ operationId })
        .then(async (next: ProviderAuthOperationState) => {
          if (!alive) {
            return;
          }
          if (next.status === "complete") {
            setAuthOperation(undefined);
            setDetailLoading(true);
            setSelectedProvider(next.provider);
            setProviderDetailOpen(true);
            onRefresh();
            setDetail(await window.modus.model.providerDetail(next.provider));
            setDetailLoading(false);
            return;
          }
          if (next.status === "error") {
            setError(next.message ?? "Provider sign-in failed.");
            setAuthOperation(undefined);
            return;
          }
          if (next.status === "cancelled") {
            setAuthOperation(undefined);
            return;
          }
          setAuthOperation(next);
        })
        .catch((err: unknown) => {
          if (alive) {
            setError(err instanceof Error ? err.message : String(err));
            setAuthOperation(undefined);
          }
        });
    };
    poll();
    const timer = window.setInterval(poll, 400);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [authOperation?.id, onRefresh]);

  return (
    <m.div
      animate={isClosing ? { opacity: 0, y: -3 } : { opacity: 1, y: 0 }}
      className="flex min-h-0 flex-1 overflow-hidden bg-panel"
      initial={reduceMotion ? false : { opacity: 0, y: 4 }}
      aria-hidden={isClosing}
      inert={isClosing}
      onAnimationComplete={() => {
        if (isClosing) {
          onClose();
        }
      }}
      style={{ pointerEvents: isClosing ? "none" : "auto" }}
      transition={{ duration: reduceMotion ? 0 : 0.14, ease: [0.22, 1, 0.36, 1] }}
    >
      <SettingsSidebar
        activeSection={activeSection}
        onBack={closeSettings}
        onQueryChange={setSettingsQuery}
        onSectionChange={setActiveSection}
        query={settingsQuery}
      />

      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto border-hairline-strong border-l bg-canvas">
        <ContentTransition
          className="mx-auto flex w-full max-w-[1080px] flex-col gap-8 px-10 pt-16 pb-12"
          transitionKey={activeSection}
        >
          {activeSection === "general" ? (
            <GeneralSettingsPanel cwd={workspaceCwd} workspaces={workspaces} />
          ) : null}
          {activeSection === "appearance" ? <AppearanceSettingsPanel /> : null}
          {activeSection === "personalization" ? <PersonalizationSettingsPanel /> : null}
          {activeSection === "skills" ? <SkillsSettingsPanel cwd={workspaceCwd} /> : null}
          {activeSection === "subagents" ? (
            <SubagentsSettingsPanel cwd={workspaceCwd} workspaces={workspaces} />
          ) : null}
          {activeSection === "mcp" ? (
            <McpSettingsPanel cwd={workspaceCwd} workspaces={workspaces} />
          ) : null}
          {activeSection === "rules" ? <RulesSettingsPanel cwd={workspaceCwd} /> : null}
          {activeSection === "project-memory" ? (
            <ProjectMemorySettingsPanel workspaceId={workspaceId} />
          ) : null}
          {activeSection === "harness-insights" ? (
            <HarnessInsightsSettingsPanel workspaceId={workspaceId} />
          ) : null}
          {activeSection === "limits" ? <LimitsSettingsPanel models={state?.models ?? []} /> : null}
          {activeSection === "model-provider" ? (
            <ModelProviderSettingsPanel
              authOperation={authOperation}
              busy={busy}
              connectionMethods={connectionMethods}
              connectionProvider={connectionProvider}
              connected={connected}
              credentialEditorOpen={credentialEditorProvider === detail?.id}
              currentProvider={currentProvider}
              customInitial={customInitial}
              customOpen={customOpen}
              detail={detail}
              detailLoading={detailLoading}
              error={error}
              keyValue={detail ? (providerKeys[detail.id] ?? "") : ""}
              providerDetailOpen={providerDetailOpen}
              onConnectProvider={(provider, apiKey, baseUrl) =>
                void connectProvider(provider, apiKey, baseUrl)
              }
              onCancelProviderAuth={cancelProviderAuth}
              onChooseConnectionMethod={(method) => {
                if (!connectionProvider) {
                  return;
                }
                const provider = connectionProvider;
                if (method.kind === "oauth") {
                  setConnectionProvider(undefined);
                  void startProviderAuth(provider);
                  return;
                }
                setConnectionProvider(undefined);
                setCredentialEditorProvider(provider.id);
                setProviderDetailOpen(true);
              }}
              onCredentialEditorClose={() => setCredentialEditorProvider(undefined)}
              onCustomCancel={() => {
                setCustomOpen(false);
                setCustomInitial(undefined);
              }}
              onCustomComplete={(provider) => {
                setCustomOpen(false);
                setCustomInitial(undefined);
                setCredentialEditorProvider(undefined);
                setDetail(undefined);
                setDetailLoading(true);
                setSelectedProvider(provider);
                setProviderDetailOpen(true);
                setActiveSection("model-provider");
                onRefresh();
              }}
              onCustomOpen={() => {
                setCustomInitial(undefined);
                setProviderDetailOpen(false);
                setCustomOpen(true);
                setActiveSection("model-provider");
              }}
              onEditModel={(model, patch) => void editModel(model, patch)}
              onEditProvider={(providerId) => void openCustomEditor(providerId)}
              onDeleteProvider={(provider) => void deleteProvider(provider)}
              onDisconnectProvider={(provider) => void disconnectProvider(provider)}
              onError={setError}
              onKeyChange={(apiKey) => {
                if (!detail) {
                  return;
                }
                setProviderKeys((current) => ({ ...current, [detail.id]: apiKey }));
              }}
              onProviderDetailClose={() => {
                setProviderDetailOpen(false);
                setCredentialEditorProvider(undefined);
                setSelectedProvider(undefined);
                setDetail(undefined);
                setDetailLoading(false);
              }}
              onProviderConnectionClose={() => setConnectionProvider(undefined)}
              onOpenProviderConnection={(provider) => void openProviderConnection(provider)}
              onProviderAuthRespond={(value) => void respondProviderAuth(value)}
              onRefreshCatalog={onRefreshCatalog}
              onSelectProvider={(provider) => void selectProvider(provider)}
              onSetAllModels={(enabled) => void setAllProviderModels(enabled)}
              onToggleModel={(model, enabled) => void toggleModel(model, enabled)}
              popular={popular}
            />
          ) : null}
        </ContentTransition>
      </main>
    </m.div>
  );
}

export function SettingsSidebar({
  activeSection,
  query,
  onBack,
  onQueryChange,
  onSectionChange,
}: {
  activeSection: SettingsSectionId;
  query: string;
  onBack(): void;
  onQueryChange(query: string): void;
  onSectionChange(section: SettingsSectionId): void;
}) {
  return (
    <aside className="flex w-[260px] shrink-0 flex-col bg-panel px-2.5 py-3">
      <button
        className="mb-4 flex h-8 items-center gap-2 rounded-md px-2 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        onClick={onBack}
        type="button"
      >
        <IconArrowLeft size={16} stroke={1.7} />
        Back
      </button>

      <label className="relative mb-5 block">
        <IconSearch
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint"
          size={15}
          stroke={1.7}
        />
        <input
          className="h-9 w-full rounded-lg border border-hairline-soft bg-surface/45 pr-3 pl-8 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-hairline-strong"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search settings..."
          value={query}
        />
      </label>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <SettingsNavGroup title="Personal">
          <SettingsNavItem
            active={activeSection === "general"}
            icon={<IconSettings size={16} stroke={1.7} />}
            onClick={() => onSectionChange("general")}
          >
            General
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "model-provider"}
            icon={<IconServerCog size={16} stroke={1.7} />}
            onClick={() => onSectionChange("model-provider")}
          >
            Model & Provider
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "appearance"}
            icon={<IconPalette size={16} stroke={1.7} />}
            onClick={() => onSectionChange("appearance")}
          >
            Appearance
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "personalization"}
            icon={<IconUser size={16} stroke={1.7} />}
            onClick={() => onSectionChange("personalization")}
          >
            Personalization
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "project-memory"}
            icon={<IconBrain size={16} stroke={1.7} />}
            onClick={() => onSectionChange("project-memory")}
          >
            Project memory
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "harness-insights"}
            icon={<IconBulb size={16} stroke={1.7} />}
            onClick={() => onSectionChange("harness-insights")}
          >
            Harness Insights
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "mcp"}
            icon={<IconPlugConnected size={16} stroke={1.7} />}
            onClick={() => onSectionChange("mcp")}
          >
            MCP
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "skills"}
            icon={<IconCube size={16} stroke={1.7} />}
            onClick={() => onSectionChange("skills")}
          >
            Skills
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "subagents"}
            icon={<IconUser size={16} stroke={1.7} />}
            onClick={() => onSectionChange("subagents")}
          >
            Subagents
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "rules"}
            icon={<IconGavel size={16} stroke={1.7} />}
            onClick={() => onSectionChange("rules")}
          >
            Rules
          </SettingsNavItem>
          <SettingsNavItem
            active={activeSection === "limits"}
            icon={<IconGauge size={16} stroke={1.7} />}
            onClick={() => onSectionChange("limits")}
          >
            Limits
          </SettingsNavItem>
        </SettingsNavGroup>
      </div>

      <div className="border-hairline-soft border-t px-2 pt-3 text-xs text-fg-faint">
        <div>Modus Desktop</div>
        <div className="mt-1">v0.1.0</div>
      </div>
    </aside>
  );
}

function SettingsNavGroup({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="mb-7">
      <h3 className="mb-2 px-2 text-xs font-normal text-fg-faint">{title}</h3>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function SettingsNavItem({
  active = false,
  children,
  icon,
  onClick,
}: {
  active?: boolean;
  children: string;
  icon: ReactNode;
  onClick(): void;
}) {
  return (
    <button
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors",
        active ? "bg-active text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
      )}
      onClick={onClick}
      type="button"
    >
      <span className={active ? "text-fg" : "text-fg-subtle"}>{icon}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}

function ModelProviderSettingsPanel({
  authOperation,
  busy,
  connected,
  connectionMethods,
  connectionProvider,
  credentialEditorOpen,
  currentProvider,
  customInitial,
  customOpen,
  detail,
  detailLoading,
  error,
  keyValue,
  popular,
  providerDetailOpen,
  onConnectProvider,
  onCancelProviderAuth,
  onChooseConnectionMethod,
  onCredentialEditorClose,
  onCustomCancel,
  onCustomComplete,
  onCustomOpen,
  onDeleteProvider,
  onDisconnectProvider,
  onEditModel,
  onEditProvider,
  onError,
  onKeyChange,
  onProviderDetailClose,
  onProviderConnectionClose,
  onProviderAuthRespond,
  onOpenProviderConnection,
  onRefreshCatalog,
  onSelectProvider,
  onSetAllModels,
  onToggleModel,
}: {
  authOperation: ProviderAuthOperationState | undefined;
  busy: boolean;
  connected: ModelProviderInfo[];
  connectionMethods: ProviderConnectionMethod[];
  connectionProvider: ModelProviderInfo | undefined;
  credentialEditorOpen: boolean;
  currentProvider: ModelProviderInfo | undefined;
  customInitial: CustomProviderConfig | undefined;
  customOpen: boolean;
  detail: ModelProviderDetail | undefined;
  detailLoading: boolean;
  error: string | undefined;
  keyValue: string;
  popular: ModelProviderInfo[];
  providerDetailOpen: boolean;
  onConnectProvider(provider: ModelProviderInfo, apiKey?: string, baseUrl?: string): void;
  onCancelProviderAuth(): void;
  onChooseConnectionMethod(method: ProviderConnectionMethod): void;
  onCredentialEditorClose(): void;
  onCustomCancel(): void;
  onCustomComplete(provider: string): void;
  onCustomOpen(): void;
  onDeleteProvider(provider: ModelProviderInfo): void;
  onDisconnectProvider(provider: ModelProviderInfo): void;
  onEditModel(model: ProviderModelConfig, patch: ModelConfigPatch): void;
  onEditProvider(providerId: string): void;
  onError(message: string | undefined): void;
  onKeyChange(apiKey: string): void;
  onProviderDetailClose(): void;
  onProviderConnectionClose(): void;
  onProviderAuthRespond(value: string | undefined): void;
  onOpenProviderConnection(provider: ModelProviderInfo): void;
  onRefreshCatalog(): Promise<void>;
  onSelectProvider(provider: ModelProviderInfo): void;
  onSetAllModels(enabled: boolean): void;
  onToggleModel(model: ProviderModelConfig, enabled: boolean): void;
}) {
  const [providerQuery, setProviderQuery] = useState("");
  const providers = useMemo(() => [...connected, ...popular], [connected, popular]);
  const enabledModelCount = useMemo(
    () => providers.reduce((total, provider) => total + provider.enabledModelCount, 0),
    [providers],
  );

  return (
    <>
      <SettingsPageHeader
        actions={
          <>
            <Tooltip content="Refresh providers">
              <button
                aria-label="Refresh providers"
                className="flex size-8 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg"
                onClick={() => {
                  onError(undefined);
                  void onRefreshCatalog().catch((error) =>
                    onError(error instanceof Error ? error.message : String(error)),
                  );
                }}
                type="button"
              >
                <IconRefresh size={15} stroke={1.7} />
              </button>
            </Tooltip>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-sm text-canvas transition-colors hover:bg-white"
              onClick={onCustomOpen}
              type="button"
            >
              <IconPlus size={14} stroke={2.1} />
              Connect custom provider
            </button>
          </>
        }
        description="Connect PI providers, enable models, and choose reasoning behavior."
        title="Model & Provider"
      />

      <div className="flex flex-wrap gap-2">
        <ReadOnlyPill>{`${connected.length} connected`}</ReadOnlyPill>
        <ReadOnlyPill>{`${enabledModelCount} enabled models`}</ReadOnlyPill>
        <ReadOnlyPill>{`${providers.length} providers`}</ReadOnlyPill>
      </div>

      <AnimatePresence initial={false}>
        {error ? (
          <m.div
            animate={{ opacity: 1, y: 0 }}
            className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-xs text-danger"
            exit={{ opacity: 0, y: -4 }}
            initial={{ opacity: 0, y: -4 }}
            key="settings-error"
            transition={{ duration: 0.14, ease: "easeOut" }}
          >
            {error}
          </m.div>
        ) : null}
      </AnimatePresence>

      <div className="grid gap-5">
        <ProviderCatalog
          connected={connected}
          currentProvider={currentProvider}
          onQueryChange={setProviderQuery}
          onSelectProvider={onSelectProvider}
          popular={popular}
          query={providerQuery}
        />
      </div>

      <ProviderDetailDialog
        busy={busy}
        credentialEditorOpen={credentialEditorOpen}
        detail={detail}
        detailLoading={detailLoading}
        keyValue={keyValue}
        open={providerDetailOpen}
        onClose={onProviderDetailClose}
        onConnectProvider={onConnectProvider}
        onCredentialEditorClose={onCredentialEditorClose}
        onDeleteProvider={onDeleteProvider}
        onDisconnectProvider={onDisconnectProvider}
        onEditModel={onEditModel}
        onEditProvider={onEditProvider}
        onKeyChange={onKeyChange}
        onOpenProviderConnection={onOpenProviderConnection}
        onSetAllModels={onSetAllModels}
        onToggleModel={onToggleModel}
      />

      <ProviderConnectionDialog
        methods={connectionMethods}
        provider={connectionProvider}
        onClose={onProviderConnectionClose}
        onSelect={onChooseConnectionMethod}
      />

      <ProviderAuthDialog
        busy={busy}
        key={`${authOperation?.id ?? "none"}:${authOperation?.status ?? "closed"}`}
        operation={authOperation}
        onCancel={onCancelProviderAuth}
        onRespond={onProviderAuthRespond}
      />

      <CustomProviderDialog
        initial={customInitial}
        open={customOpen}
        onCancel={onCustomCancel}
        onComplete={onCustomComplete}
        onError={onError}
      />
    </>
  );
}

function ProviderCatalog({
  connected,
  currentProvider,
  popular,
  query,
  onQueryChange,
  onSelectProvider,
}: {
  connected: ModelProviderInfo[];
  currentProvider: ModelProviderInfo | undefined;
  popular: ModelProviderInfo[];
  query: string;
  onQueryChange(query: string): void;
  onSelectProvider(provider: ModelProviderInfo): void;
}) {
  const normalizedQuery = normalizeSearchValue(query);
  const visibleConnected = useMemo(
    () => connected.filter((provider) => providerMatchesQuery(provider, normalizedQuery)),
    [connected, normalizedQuery],
  );
  const visiblePopular = useMemo(
    () => popular.filter((provider) => providerMatchesQuery(provider, normalizedQuery)),
    [popular, normalizedQuery],
  );
  const visibleCount = visibleConnected.length + visiblePopular.length;

  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-normal text-fg">Providers</h3>
          <p className="mt-1 text-xs text-fg-faint">
            Connected, available, and custom providers in one place.
          </p>
        </div>
        <ReadOnlyPill>{`${visibleCount} shown`}</ReadOnlyPill>
      </div>

      <div className="overflow-hidden rounded-lg border border-hairline-soft bg-panel">
        <div className="border-hairline-soft border-b p-3">
          <SearchField
            ariaLabel="Search providers"
            onChange={onQueryChange}
            placeholder="Search providers..."
            value={query}
          />
        </div>

        <div className="scroll-thin max-h-[min(560px,calc(100vh-280px))] min-h-[320px] overflow-y-auto p-2">
          {visibleCount > 0 ? (
            <>
              <ProviderGroup title="Connected">
                {visibleConnected.map((provider) => (
                  <ProviderCatalogRow
                    active={provider.id === currentProvider?.id}
                    key={provider.id}
                    onClick={() => onSelectProvider(provider)}
                    provider={provider}
                  />
                ))}
              </ProviderGroup>

              <ProviderGroup title="Available">
                {visiblePopular.map((provider) => (
                  <ProviderCatalogRow
                    active={provider.id === currentProvider?.id}
                    key={provider.id}
                    onClick={() => onSelectProvider(provider)}
                    provider={provider}
                  />
                ))}
              </ProviderGroup>
            </>
          ) : (
            <EmptyState
              compact
              description="Try another provider name, model count, or source."
              hint="No providers found"
            />
          )}
        </div>
      </div>
    </section>
  );
}

function ProviderConfigDialogShell({
  children,
  description,
  open,
  title,
  closeLabel,
  onClose,
}: {
  children: ReactNode;
  description?: string;
  open: boolean;
  title: string;
  closeLabel: string;
  onClose(): void;
}) {
  return (
    <Dialog.Root
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
      open={open}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-fg/20 backdrop-blur-[1px] transition-opacity duration-150 motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden px-6 py-6">
          <Dialog.Popup className="flex h-[min(820px,calc(100vh-48px))] w-full max-w-[760px] flex-col overflow-hidden rounded-lg border border-popup-border bg-canvas shadow-popup outline-none transition-[opacity,transform] duration-150 motion-reduce:transition-none data-ending-style:translate-y-2 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0">
            <div className="flex h-[52px] items-center justify-between gap-3 px-5">
              <Dialog.Close
                aria-label={`Back from ${title}`}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg"
              >
                <IconArrowLeft size={16} stroke={1.7} />
              </Dialog.Close>
              <Dialog.Close
                aria-label={closeLabel}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg"
              >
                <IconX size={16} stroke={1.7} />
              </Dialog.Close>
            </div>
            <div className="sr-only">
              <Dialog.Title>{title}</Dialog.Title>
              {description ? <Dialog.Description>{description}</Dialog.Description> : null}
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ProviderDetailDialog({
  busy,
  credentialEditorOpen,
  detail,
  detailLoading,
  keyValue,
  open,
  onClose,
  onConnectProvider,
  onCredentialEditorClose,
  onDeleteProvider,
  onDisconnectProvider,
  onEditModel,
  onEditProvider,
  onKeyChange,
  onOpenProviderConnection,
  onSetAllModels,
  onToggleModel,
}: {
  busy: boolean;
  credentialEditorOpen: boolean;
  detail: ModelProviderDetail | undefined;
  detailLoading: boolean;
  keyValue: string;
  open: boolean;
  onClose(): void;
  onConnectProvider(provider: ModelProviderInfo, apiKey?: string, baseUrl?: string): void;
  onCredentialEditorClose(): void;
  onDeleteProvider(provider: ModelProviderInfo): void;
  onDisconnectProvider(provider: ModelProviderInfo): void;
  onEditModel(model: ProviderModelConfig, patch: ModelConfigPatch): void;
  onEditProvider(providerId: string): void;
  onKeyChange(apiKey: string): void;
  onOpenProviderConnection(provider: ModelProviderInfo): void;
  onSetAllModels(enabled: boolean): void;
  onToggleModel(model: ProviderModelConfig, enabled: boolean): void;
}) {
  const title = detail ? `Configure ${detail.name}` : "Configure provider";

  return (
    <ProviderConfigDialogShell
      closeLabel="Close provider configuration"
      description="Connect provider credentials and choose which models Modus should expose."
      open={open}
      title={title}
      onClose={onClose}
    >
      {detailLoading ? (
        <ProviderDetailLoading />
      ) : detail ? (
        <ProviderDetail
          busy={busy}
          credentialEditorOpen={credentialEditorOpen}
          detail={detail}
          key={detail.id}
          keyValue={keyValue}
          onConnect={(apiKey, baseUrl) => onConnectProvider(detail, apiKey, baseUrl)}
          onCredentialEditorClose={onCredentialEditorClose}
          onDeleteProvider={() => onDeleteProvider(detail)}
          onDisconnectProvider={() => onDisconnectProvider(detail)}
          onEditModel={onEditModel}
          onEditProvider={onEditProvider}
          onKeyChange={onKeyChange}
          onOpenProviderConnection={() => onOpenProviderConnection(detail)}
          onSetAllModels={onSetAllModels}
          onToggleModel={onToggleModel}
        />
      ) : (
        <EmptyState
          compact
          description="The selected provider is not available anymore. Close this panel and choose another provider."
          hint="Provider unavailable"
        />
      )}
    </ProviderConfigDialogShell>
  );
}

function ProviderConnectionDialog({
  methods,
  provider,
  onClose,
  onSelect,
}: {
  methods: ProviderConnectionMethod[];
  provider: ModelProviderInfo | undefined;
  onClose(): void;
  onSelect(method: ProviderConnectionMethod): void;
}) {
  if (!provider) {
    return null;
  }

  return (
    <ProviderConfigDialogShell
      closeLabel="Close connection method selection"
      description="Choose how Modus should connect this provider."
      open
      title={`Connect ${provider.name}`}
      onClose={onClose}
    >
      <div className="pt-5">
        <div className="flex items-center gap-3">
          <ProviderLogo framed={false} name={provider.name} provider={provider.id} size="lg" />
          <div>
            <h3 className="text-md font-normal text-fg">Connect {provider.name}</h3>
            <p className="mt-1 text-xs text-fg-faint">Choose a sign-in method.</p>
          </div>
        </div>
        <div className="mt-7 grid gap-2">
          {methods.map((method) => (
            <button
              className="flex min-h-12 items-center justify-between gap-4 rounded-md px-3 text-left transition-colors hover:bg-hover"
              key={`${method.kind}:${method.label}`}
              onClick={() => onSelect(method)}
              type="button"
            >
              <span className="flex min-w-0 items-center gap-3">
                {method.kind === "api-key" ? (
                  <IconKey className="text-fg-subtle" size={17} stroke={1.7} />
                ) : (
                  <IconPlugConnected className="text-fg-subtle" size={17} stroke={1.7} />
                )}
                <span className="truncate text-sm text-fg">{method.label}</span>
              </span>
              <IconChevronRight className="shrink-0 text-fg-faint" size={16} stroke={1.7} />
            </button>
          ))}
        </div>
      </div>
    </ProviderConfigDialogShell>
  );
}

function ProviderAuthDialog({
  busy,
  operation,
  onCancel,
  onRespond,
}: {
  busy: boolean;
  operation: ProviderAuthOperationState | undefined;
  onCancel(): void;
  onRespond(value: string | undefined): void;
}) {
  const [value, setValue] = useState("");

  if (!operation) {
    return null;
  }

  const canSubmit = operation.allowEmpty || Boolean(value.trim());
  const copy = (text: string | undefined) => {
    if (text) {
      void navigator.clipboard.writeText(text).catch(() => undefined);
    }
  };

  return (
    <ProviderConfigDialogShell
      closeLabel="Cancel provider sign-in"
      description="Complete the provider sign-in in the requested browser or device flow."
      open
      title="Complete sign-in"
      onClose={onCancel}
    >
      <div className="pt-5">
        <h3 className="text-md font-normal text-fg">Complete sign-in</h3>
        <p className="mt-2 text-sm text-fg-muted">{operation.message ?? "Waiting for sign-in…"}</p>

        {operation.status === "select" ? (
          <div className="mt-6 grid gap-2">
            {operation.options?.map((option) => (
              <button
                className="flex min-h-12 items-center justify-between gap-4 rounded-md px-3 text-left transition-colors hover:bg-hover disabled:opacity-50"
                disabled={busy}
                key={option.id}
                onClick={() => onRespond(option.id)}
                type="button"
              >
                <span className="text-sm text-fg">{option.label}</span>
                <IconChevronRight className="text-fg-faint" size={16} stroke={1.7} />
              </button>
            ))}
          </div>
        ) : null}

        {operation.status === "browser" || operation.status === "device-code" ? (
          <div className="mt-6 space-y-3">
            {operation.userCode ? (
              <div className="rounded-md border border-hairline-soft bg-panel px-3 py-3">
                <div className="text-2xs text-fg-faint">Verification code</div>
                <div className="mt-1 font-mono text-lg text-fg">{operation.userCode}</div>
              </div>
            ) : null}
            {operation.url ? (
              <div className="rounded-md border border-hairline-soft bg-panel px-3 py-3">
                <div className="break-all font-mono text-xs text-fg-muted">{operation.url}</div>
                <button
                  className="mt-3 flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-canvas px-2.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                  onClick={() => copy(operation.url)}
                  type="button"
                >
                  <IconCopy size={13} stroke={1.7} />
                  Copy link
                </button>
              </div>
            ) : null}
            {operation.instructions ? (
              <p className="text-xs text-fg-faint">{operation.instructions}</p>
            ) : null}
          </div>
        ) : null}

        {operation.status === "prompt" || operation.status === "manual-code" ? (
          <form
            className="mt-6 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) {
                onRespond(value.trim() || undefined);
              }
            }}
          >
            <input
              className="h-9 min-w-0 flex-1 rounded-md border border-hairline bg-panel px-3 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-hairline-strong"
              onChange={(event) => setValue(event.target.value)}
              placeholder={operation.placeholder}
              type="text"
              value={value}
            />
            <button
              className="h-9 rounded-md bg-fg px-3 text-sm text-canvas transition-colors hover:bg-white disabled:opacity-50"
              disabled={busy || !canSubmit}
              type="submit"
            >
              Continue
            </button>
          </form>
        ) : null}

        {operation.status === "pending" ? (
          <div className="mt-6 text-sm text-fg-faint">
            <ShinyText>Waiting for provider…</ShinyText>
          </div>
        ) : null}
      </div>
    </ProviderConfigDialogShell>
  );
}

function CustomProviderDialog({
  initial,
  open,
  onCancel,
  onComplete,
  onError,
}: {
  initial: CustomProviderConfig | undefined;
  open: boolean;
  onCancel(): void;
  onComplete(provider: string): void;
  onError(message: string | undefined): void;
}) {
  const title = initial ? `Edit ${initial.name || initial.provider}` : "Connect custom provider";

  return (
    <ProviderConfigDialogShell
      closeLabel="Close custom provider dialog"
      description="Connect an OpenAI, Anthropic or Gemini compatible endpoint and choose the models Modus should expose."
      open={open}
      title={title}
      onClose={onCancel}
    >
      <CustomProviderForm
        initial={initial}
        key={initial?.provider ?? "new-custom-provider"}
        onCancel={onCancel}
        onComplete={onComplete}
        onError={onError}
      />
    </ProviderConfigDialogShell>
  );
}

function GeneralSettingsPanel({
  cwd,
  workspaces = [],
}: {
  cwd?: string | undefined;
  workspaces?: WorkspaceInfo[] | undefined;
}) {
  return (
    <>
      <SettingsPageHeader
        description="Choose when Modus asks before risky agent actions — globally or per project."
        title="General"
      />
      <ApprovalModeSettings {...(cwd ? { cwd } : {})} workspaces={workspaces} />
    </>
  );
}

const HARNESS_INSIGHTS_WINDOW_DAYS = 30;
const HARNESS_INSIGHTS_LIMIT = 50;
const MIN_COMPARABLE_INSIGHT_EPISODES = 3;
type HarnessInsightsWindowDays = 7 | 30 | 90;

export function harnessInsightsQueryForWorkspace(
  workspaceId: string | undefined,
  now = new Date(),
  windowDays: HarnessInsightsWindowDays = HARNESS_INSIGHTS_WINDOW_DAYS,
): HarnessInsightsQuery | undefined {
  if (!workspaceId || workspaceId === CHATS_WORKSPACE_ID) return undefined;
  return {
    workspaceId,
    since: new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString(),
    limit: HARNESS_INSIGHTS_LIMIT,
  };
}

export function harnessInsightConfidenceLabel(confidence: HarnessInsightConfidence): string {
  return `${confidence.charAt(0).toUpperCase()}${confidence.slice(1)} confidence`;
}

function harnessInsightKindLabel(kind: HarnessInsight["kind"]): string {
  const labels: Record<HarnessInsight["kind"], string> = {
    repeated_failures: "Repeated failures",
    same_path_rework: "Same-path rework",
    context_pressure: "Context pressure",
    delegation_mismatch: "Delegation mismatch",
    missing_verification: "Missing verification",
  };
  return labels[kind];
}

function harnessInsightDate(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date)
    : "Date unavailable";
}

function harnessInsightPeriod(period: HarnessInsight["period"]): string {
  return `${harnessInsightDate(period.since)} – ${harnessInsightDate(period.until)}`;
}

export type HarnessInsightsViewState =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; result: HarnessInsightsResult };

export function HarnessInsightsView({
  onPeriodChange,
  onRefresh,
  periodDays,
  state,
}: {
  onPeriodChange(days: HarnessInsightsWindowDays): void;
  onRefresh(): void;
  periodDays: HarnessInsightsWindowDays;
  state: HarnessInsightsViewState;
}) {
  return (
    <>
      <SettingsPageHeader
        actions={
          state.status !== "unavailable" ? (
            <>
              <label className="flex h-8 items-center gap-1.5 rounded-md border border-hairline-soft px-2 text-xs text-fg-muted">
                <span className="sr-only">Insights time window</span>
                <select
                  aria-label="Insights time window"
                  className="h-full cursor-pointer bg-transparent text-fg outline-none"
                  onChange={(event) =>
                    onPeriodChange(Number(event.target.value) as HarnessInsightsWindowDays)
                  }
                  value={periodDays}
                >
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                </select>
              </label>
              <button
                aria-label="Refresh Harness Insights"
                className="flex h-8 items-center gap-1.5 rounded-md border border-hairline-soft px-2.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-wait disabled:opacity-50"
                disabled={state.status === "loading"}
                onClick={onRefresh}
                type="button"
              >
                <IconRefresh
                  aria-hidden
                  className={
                    state.status === "loading" ? "animate-spin motion-reduce:animate-none" : ""
                  }
                  size={14}
                />
                Refresh
              </button>
            </>
          ) : undefined
        }
        description="A local, on-demand summary of patterns in this workspace. Findings are hypotheses, not proof."
        title="Harness Insights"
      />
      {state.status === "unavailable" ? (
        <div className="rounded-xl border border-hairline-soft bg-panel p-5 text-sm text-fg-muted">
          Choose a workspace to view local insights.
        </div>
      ) : state.status === "loading" ? (
        <div
          aria-live="polite"
          className="flex min-h-28 items-center justify-center gap-2 rounded-xl border border-hairline-soft bg-panel text-sm text-fg-muted"
          role="status"
        >
          <IconRefresh aria-hidden className="animate-spin motion-reduce:animate-none" size={16} />
          Loading local insights…
        </div>
      ) : state.status === "error" ? (
        <div
          className="flex flex-col items-start gap-3 rounded-xl border border-danger/20 bg-danger/5 p-5"
          role="alert"
        >
          <p className="text-sm text-fg">Insights could not be loaded.</p>
          <button
            className="h-8 rounded-md border border-hairline-soft px-3 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            onClick={onRefresh}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : (
        <HarnessInsightsResults result={state.result} />
      )}
    </>
  );
}

function HarnessInsightsResults({ result }: { result: HarnessInsightsResult }) {
  const insufficient =
    result.evidenceState === "unknown" || result.sampleCount < MIN_COMPARABLE_INSIGHT_EPISODES;

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline-soft bg-panel p-4">
        <div className="min-w-0">
          <p className="font-medium text-fg text-sm">Local evidence</p>
          <p className="mt-1 text-xs text-fg-muted">
            {result.sampleCount} {result.sampleCount === 1 ? "episode" : "episodes"} sampled
          </p>
        </div>
        <span className="max-w-full break-words rounded-full border border-hairline-soft px-2.5 py-1 text-2xs text-fg-faint">
          <span className="mr-1 font-medium">Period</span>
          {harnessInsightPeriod(result.period)}
        </span>
      </section>

      <p className="text-xs leading-relaxed text-fg-faint">
        Patterns are suggestions from structured local activity. Nothing is applied or changed.
      </p>

      {insufficient ? (
        <section
          aria-live="polite"
          className="rounded-xl border border-hairline-soft bg-panel p-5"
          role="status"
        >
          <h3 className="font-medium text-fg text-sm">Not enough comparable activity yet</h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            At least {MIN_COMPARABLE_INSIGHT_EPISODES} similar task episodes are needed before
            patterns can be suggested. Unknown means there is not enough comparable evidence, not
            zero activity.
          </p>
          <HarnessInsightLimitations limitations={result.limitations} />
        </section>
      ) : result.insights.length === 0 ? (
        <section className="rounded-xl border border-hairline-soft bg-panel p-5">
          <h3 className="font-medium text-fg text-sm">No findings for this period.</h3>
          <p className="mt-1 text-xs text-fg-muted">
            No clear pattern was surfaced from these episodes.
          </p>
          <HarnessInsightLimitations limitations={result.limitations} />
        </section>
      ) : (
        <>
          <HarnessInsightLimitations limitations={result.limitations} />
          <div className="grid min-w-0 gap-3">
            {result.insights.map((insight) => (
              <article
                className="min-w-0 rounded-xl border border-hairline-soft bg-panel p-4"
                key={insight.id}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium text-fg text-sm">
                    {harnessInsightKindLabel(insight.kind)}
                  </h3>
                  <span className="rounded-full border border-warning/25 bg-warning/8 px-2 py-0.5 text-2xs text-warning">
                    Hypothesis
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-fg">{insight.claim}</p>
                <div className="mt-3 rounded-lg bg-surface/60 p-3">
                  <p className="text-2xs font-medium text-fg-muted">Suggestion</p>
                  <p className="mt-1 text-xs leading-relaxed text-fg-subtle">
                    {insight.recommendation}
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-fg-faint">
                  <span>
                    {insight.sampleCount} {insight.sampleCount === 1 ? "sample" : "samples"}
                  </span>
                  <span>{harnessInsightConfidenceLabel(insight.confidence)}</span>
                  <span>Period · {harnessInsightPeriod(insight.period)}</span>
                </div>
                <HarnessInsightLimitations limitations={insight.limitations} />
                {insight.sourceRefs.length ? (
                  <div className="mt-3 border-hairline-soft border-t pt-2.5">
                    <p className="text-2xs font-medium text-fg-muted">Source references</p>
                    <ul className="mt-1 flex flex-wrap gap-1.5">
                      {insight.sourceRefs.slice(0, 6).map((reference) => (
                        <li
                          className="max-w-full break-all rounded-md bg-surface px-2 py-1 font-mono text-2xs text-fg-faint"
                          key={`${insight.id}-${reference.runId}-${reference.eventId ?? "run"}`}
                        >
                          Run {reference.runId}
                          {reference.eventId ? ` · Event ${reference.eventId}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function HarnessInsightLimitations({ limitations }: { limitations: string[] }) {
  return limitations.length ? (
    <ul className="mt-3 space-y-1 text-2xs leading-relaxed text-fg-faint">
      {limitations.slice(0, 4).map((limitation) => (
        <li className="break-words" key={limitation}>
          {limitation}
        </li>
      ))}
    </ul>
  ) : null;
}

function HarnessInsightsSettingsPanel({ workspaceId }: { workspaceId?: string | undefined }) {
  const [periodDays, setPeriodDays] = useState<HarnessInsightsWindowDays>(30);
  const [state, setState] = useState<HarnessInsightsViewState>(() =>
    harnessInsightsQueryForWorkspace(workspaceId, new Date(), 30)
      ? { status: "loading" }
      : { status: "unavailable" },
  );
  const requestId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const currentRequestId = ++requestId.current;
    const query = harnessInsightsQueryForWorkspace(workspaceId, new Date(), periodDays);
    if (!query) {
      setState({ status: "unavailable" });
      return;
    }
    setState({ status: "loading" });
    try {
      const result = await window.modus.harnessInsights.get(query);
      if (currentRequestId === requestId.current) {
        setState(
          result.workspaceId === query.workspaceId
            ? { status: "loaded", result }
            : { status: "error" },
        );
      }
    } catch {
      if (currentRequestId === requestId.current) setState({ status: "error" });
    }
  }, [workspaceId, periodDays]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  return (
    <HarnessInsightsView
      onPeriodChange={setPeriodDays}
      onRefresh={() => void load()}
      periodDays={periodDays}
      state={state}
    />
  );
}

export function groupProjectMemories(
  memories: ProjectMemoryRecord[],
  workspaceId?: string,
): { global: ProjectMemoryRecord[]; project: ProjectMemoryRecord[] } {
  return {
    global: memories.filter((memory) => memory.scope.kind === "global"),
    project:
      workspaceId && workspaceId !== CHATS_WORKSPACE_ID
        ? memories.filter(
            (memory) => memory.scope.kind === "project" && memory.scope.workspaceId === workspaceId,
          )
        : [],
  };
}

export function projectMemoryStatusLabel(status: ProjectMemoryStatus): string {
  switch (status) {
    case "candidate":
      return "Candidate";
    case "active":
      return "Active";
    case "provisional":
      return "Provisional";
    case "needs_review":
      return "Needs review";
    case "superseded":
      return "Superseded";
    case "obsolete":
      return "Obsolete";
  }
}

export function projectMemoryVerifyVisible(status: ProjectMemoryStatus): boolean {
  return status === "provisional" || status === "needs_review";
}

export function projectMemoryVerificationLabel(
  verification: ProjectMemoryRecord["verification"],
): string {
  switch (verification) {
    case "user_explicit":
      return "User explicit";
    case "agent_observed":
      return "Agent observed";
    case "tests_passed":
      return "Tests passed";
    case "parent_verified":
      return "Parent verified";
    case "unverified":
      return "Unverified";
  }
}

export function projectMemoryProvisionalExplanation(): string {
  return "Provisional child/worktree finding — excluded from automatic memory context until parent-checkout verification or integration.";
}

export async function setProjectMemoryScopeEnabled({
  snapshot,
  scope,
  enabled,
  onSnapshot,
  persist,
}: {
  snapshot: ProjectMemorySnapshot;
  scope: ProjectMemoryScope;
  enabled: boolean;
  onSnapshot(snapshot: ProjectMemorySnapshot): void;
  persist(input: { scope: ProjectMemoryScope; enabled: boolean }): Promise<ProjectMemorySnapshot>;
}): Promise<ProjectMemorySnapshot> {
  const optimistic = {
    ...snapshot,
    ...(scope.kind === "global" ? { globalEnabled: enabled } : { projectEnabled: enabled }),
  };
  onSnapshot(optimistic);
  try {
    const updated = await persist({ scope, enabled });
    onSnapshot(updated);
    return updated;
  } catch (error) {
    onSnapshot(snapshot);
    throw error;
  }
}

export async function confirmProjectMemoryRemoval(
  memoryId: string,
  action: "obsolete" | "delete",
  confirm: (action: "obsolete" | "delete") => boolean,
  remove: (memoryId: string, action: "obsolete" | "delete") => Promise<void>,
): Promise<boolean> {
  if (!confirm(action)) return false;
  await remove(memoryId, action);
  return true;
}

function projectMemoryCategoryLabel(category: ProjectMemoryCategory): string {
  return category.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function projectMemorySourceLabel(memory: ProjectMemoryRecord): string {
  const source = memory.evidence[0];
  if (!source) return "No source details";
  if (source.externalReference) return source.externalReference.sourceLabel;
  const detail =
    source.path ?? source.symbol ?? source.branch ?? source.commitSha ?? source.taskRef;
  return detail
    ? `${source.kind.replaceAll("_", " ")} · ${detail}`
    : source.kind.replaceAll("_", " ");
}

export function safeExternalReferenceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function ExternalMemoryReference({ reference }: { reference: ProjectMemoryExternalReference }) {
  const href = safeExternalReferenceUrl(reference.url);
  const label = reference.title?.trim() || reference.url;
  const attribution =
    reference.origin === "agent_supplied_unverified"
      ? `Untrusted · ${reference.sourceLabel} · Needs review`
      : reference.sourceLabel;

  return (
    <div className="flex min-w-0 items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 px-2.5 py-2">
      <IconExternalLink aria-hidden className="mt-0.5 shrink-0 text-warning" size={14} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-2xs text-warning">Untrusted external reference</span>
          <span className="max-w-full truncate text-2xs text-fg-faint">{attribution}</span>
        </div>
        <p className="mt-0.5 text-2xs text-fg-faint">External page content is not verified.</p>
        {href ? (
          <a
            aria-label={`Open external reference: ${label}`}
            className="mt-1 inline-flex max-w-full items-center gap-1 rounded-sm text-xs text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/50"
            href={href}
            rel="noopener noreferrer"
            target="_blank"
          >
            <span className="flex min-w-0 flex-col">
              <span className="block max-w-full truncate">{label}</span>
              {reference.title?.trim() ? (
                <span className="block max-w-full truncate text-2xs text-fg-faint">{href}</span>
              ) : null}
            </span>
            <IconExternalLink aria-hidden className="shrink-0" size={12} />
          </a>
        ) : (
          <span className="mt-1 block max-w-full truncate text-xs text-fg-faint">
            External URL unavailable
          </span>
        )}
      </div>
    </div>
  );
}

function ProjectMemorySettingsPanel({ workspaceId }: { workspaceId?: string | undefined }) {
  const hasProjectScope = Boolean(workspaceId && workspaceId !== CHATS_WORKSPACE_ID);
  const [snapshot, setSnapshot] = useState<ProjectMemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  const loadSnapshot = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setSnapshot(await window.modus.projectMemory.snapshot(workspaceId ? { workspaceId } : {}));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSnapshot(null);
    setError(undefined);
    void window.modus.projectMemory
      .snapshot(workspaceId ? { workspaceId } : {})
      .then((next: ProjectMemorySnapshot) => {
        if (alive) setSnapshot(next);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  async function toggleScope(scope: ProjectMemoryScope, enabled: boolean): Promise<void> {
    if (!snapshot) return;
    setBusy(scope.kind);
    setError(undefined);
    try {
      await setProjectMemoryScopeEnabled({
        snapshot,
        scope,
        enabled,
        onSnapshot: setSnapshot,
        persist: (input) => window.modus.projectMemory.setEnabled(input),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function verifyMemory(memoryId: string): Promise<void> {
    setBusy(memoryId);
    setError(undefined);
    try {
      setSnapshot(await window.modus.projectMemory.verify({ memoryId }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function removeMemory(memoryId: string, action: "obsolete" | "delete"): Promise<void> {
    setBusy(memoryId);
    setError(undefined);
    try {
      await confirmProjectMemoryRemoval(
        memoryId,
        action,
        (kind) =>
          window.confirm(
            kind === "obsolete"
              ? "Mark this memory obsolete? It will no longer be used as current project knowledge."
              : "Delete this memory and its metadata? This cannot be undone.",
          ),
        async (id, kind) => {
          const next =
            kind === "obsolete"
              ? await window.modus.projectMemory.markObsolete({ memoryId: id })
              : await window.modus.projectMemory.delete({ memoryId: id });
          setSnapshot(next);
        },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const groups = groupProjectMemories(snapshot?.memories ?? [], workspaceId);

  return (
    <>
      <SettingsPageHeader
        description="Keep useful project knowledge visible and under your control."
        title="Project memory"
      />

      {error ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-xs text-danger">
          <span>{error}</span>
          <button
            className="shrink-0 rounded-md px-2 py-1 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            onClick={() => void loadSnapshot()}
            type="button"
          >
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-lg border border-hairline-soft bg-panel px-4 py-5 text-sm text-fg-faint">
          Loading project memory…
        </div>
      ) : snapshot ? (
        <div className="grid gap-5">
          <ProjectMemoryScopeSection
            enabled={snapshot.globalEnabled}
            busy={busy === "global"}
            records={groups.global}
            title="Global"
            description="Available across projects and Inbox."
            onToggle={(enabled) => void toggleScope({ kind: "global" }, enabled)}
            onVerify={(id) => void verifyMemory(id)}
            onRemove={(id, action) => void removeMemory(id, action)}
            busyMemoryId={busy}
          />
          {hasProjectScope ? (
            <ProjectMemoryScopeSection
              enabled={snapshot.projectEnabled}
              busy={busy === "project"}
              records={groups.project}
              title="Current project"
              description="Only available in this project."
              onToggle={(enabled) =>
                void toggleScope({ kind: "project", workspaceId: workspaceId as string }, enabled)
              }
              onVerify={(id) => void verifyMemory(id)}
              onRemove={(id, action) => void removeMemory(id, action)}
              busyMemoryId={busy}
            />
          ) : null}
          {groups.global.length === 0 && groups.project.length === 0 ? (
            <EmptyState
              compact
              description="Verified project knowledge will appear here."
              hint="No saved memories"
            />
          ) : null}
        </div>
      ) : (
        <EmptyState
          compact
          description="Try loading project memory again."
          hint="Memory is unavailable"
        />
      )}
    </>
  );
}

function ProjectMemoryScopeSection({
  title,
  description,
  enabled,
  busy,
  records,
  busyMemoryId,
  onToggle,
  onVerify,
  onRemove,
}: {
  title: string;
  description: string;
  enabled: boolean;
  busy: boolean;
  records: ProjectMemoryRecord[];
  busyMemoryId: string | null;
  onToggle(enabled: boolean): void;
  onVerify(memoryId: string): void;
  onRemove(memoryId: string, action: "obsolete" | "delete"): void;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-hairline-soft bg-panel">
      <div className="flex items-center justify-between gap-4 border-hairline-soft border-b px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-normal text-fg">{title}</h3>
          <p className="mt-1 text-xs text-fg-faint">{description}</p>
        </div>
        <SwitchControl
          ariaLabel={`Enable ${title.toLowerCase()} memory`}
          checked={enabled}
          disabled={busy || busyMemoryId !== null}
          onCheckedChange={onToggle}
        />
      </div>
      {records.length === 0 ? (
        <p className="px-4 py-4 text-xs text-fg-faint">No memories in this scope yet.</p>
      ) : (
        <div className="divide-y divide-hairline-soft">
          {records.map((memory) => (
            <ProjectMemoryRow
              key={memory.id}
              memory={memory}
              busy={busyMemoryId === memory.id}
              onVerify={() => onVerify(memory.id)}
              onRemove={(action) => onRemove(memory.id, action)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function ProjectMemoryRow({
  memory,
  busy,
  onVerify,
  onRemove,
}: {
  memory: ProjectMemoryRecord;
  busy: boolean;
  onVerify(): void;
  onRemove(action: "obsolete" | "delete"): void;
}) {
  const status = projectMemoryStatusLabel(memory.status);
  const statusStyle =
    memory.status === "provisional" || memory.status === "needs_review"
      ? "border-warning/30 bg-warning/8 text-warning"
      : memory.status === "active"
        ? "border-accent/25 bg-accent/8 text-fg-muted"
        : "border-hairline-soft bg-surface/45 text-fg-faint";
  const lastVerified = memory.lastVerifiedAt
    ? formatClock(Date.parse(memory.lastVerifiedAt))
    : "Not verified";
  const externalReferences = memory.evidence.flatMap((evidence) =>
    evidence.externalReference ? [evidence.externalReference] : [],
  );

  return (
    <article className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-normal text-fg">{memory.title}</h4>
            <span className={cn("rounded border px-1.5 py-0.5 text-2xs", statusStyle)}>
              {status}
            </span>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-fg-muted">
            {memory.claim}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-fg-faint">
            <span>{projectMemoryCategoryLabel(memory.category)}</span>
            <span>Source: {projectMemorySourceLabel(memory)}</span>
            <span>Verification: {projectMemoryVerificationLabel(memory.verification)}</span>
            <span>Last verified: {lastVerified}</span>
          </div>
          {externalReferences.length ? (
            <fieldset className="mt-2 min-w-0 border-0 p-0">
              <legend className="sr-only">External evidence</legend>
              {externalReferences.map((reference) => (
                <ExternalMemoryReference
                  key={`${memory.id}-${reference.url}-${reference.retrievedAt}`}
                  reference={reference}
                />
              ))}
            </fieldset>
          ) : null}
          {projectMemoryVerifyVisible(memory.status) ? (
            <p className="mt-2 text-xs text-warning">
              {memory.status === "provisional"
                ? projectMemoryProvisionalExplanation()
                : "Needs review — verify before relying on it."}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {projectMemoryVerifyVisible(memory.status) ? (
            <button
              className="flex h-7 items-center gap-1.5 rounded-md border border-hairline-soft px-2 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
              disabled={busy}
              onClick={onVerify}
              type="button"
            >
              <IconCheck size={13} stroke={1.8} />
              Verify
            </button>
          ) : null}
          {memory.status !== "obsolete" ? (
            <button
              aria-label={`Mark ${memory.title} obsolete`}
              className="flex size-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
              disabled={busy}
              onClick={() => onRemove("obsolete")}
              title="Mark obsolete"
              type="button"
            >
              <IconArchiveOff size={14} stroke={1.7} />
            </button>
          ) : null}
          <button
            aria-label={`Delete ${memory.title}`}
            className="flex size-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
            disabled={busy}
            onClick={() => onRemove("delete")}
            title="Delete memory"
            type="button"
          >
            <IconTrash size={14} stroke={1.7} />
          </button>
        </div>
      </div>
    </article>
  );
}

type ConfiguredModelLimit = {
  id: string;
  providerId: string;
  providerName: string;
  modelName: string;
  contextWindow?: number;
  maxTokens?: number;
};

export function configuredModelLimits(models: ModelInfo[]): ConfiguredModelLimit[] {
  return models
    .filter((model) => model.enabled && model.configured)
    .map((model) => ({
      id: model.id,
      providerId: model.provider,
      providerName: model.providerName || model.provider,
      modelName: model.name,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    }));
}

export function groupConfiguredModelLimits(
  rows: ConfiguredModelLimit[],
): Array<[string, ConfiguredModelLimit[]]> {
  const groups = new Map<string, ConfiguredModelLimit[]>();
  for (const row of rows) {
    const group = groups.get(row.providerName) ?? [];
    group.push(row);
    groups.set(row.providerName, group);
  }
  return [...groups.entries()];
}

export function accountStatusLabel(
  status: ProviderUsageStatus,
  message?: ProviderUsageMessage,
): string {
  if (status === "fresh") return "Updated";
  if (status === "stale") return "Stale";
  if (status === "unavailable") {
    switch (message) {
      case "unsupported":
        return "No supported source";
      case "not-configured":
        return "Not configured";
      case "codex-disabled":
        return "Codex CLI off";
      case "codex-cli-missing":
        return "Codex CLI not found";
      default:
        return "Unavailable";
    }
  }
  switch (message) {
    case "authentication-failed":
      return "Authentication failed";
    case "request-failed":
      return "Request failed";
    case "invalid-response":
      return "Unexpected response";
    default:
      return "Could not load";
  }
}

export function usageMetricText(metric: ProviderUsageMetric): string {
  const value = formatMetricNumber(metric.value);
  if (metric.limit === undefined || (metric.kind === "budget" && metric.value === metric.limit)) {
    return formatMetricValue(metric.value, metric.unit);
  }
  return `${value} / ${formatMetricNumber(metric.limit)} ${metric.unit}`.trim();
}

export function accountMetricLabel(metric: ProviderUsageMetric): string {
  if (metric.kind === "budget") return "Key budget";
  if (metric.kind === "balance") return "Account balance";
  return metric.label;
}

function formatMetricValue(value: number, unit: string): string {
  const formatted = formatMetricNumber(value);
  return unit === "%" ? `${formatted}%` : `${formatted} ${unit}`.trim();
}

function formatMetricNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function groupConfiguredModelLimitsByProvider(models: ModelInfo[]) {
  return groupConfiguredModelLimits(configuredModelLimits(models));
}

function LimitsSettingsPanel({ models }: { models: ModelInfo[] }) {
  const [limits, setLimits] = useState<ProviderLimitsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [codexBusy, setCodexBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const modelGroups = useMemo(() => groupConfiguredModelLimitsByProvider(models), [models]);

  useEffect(() => {
    let alive = true;
    void window.modus.model
      .limits()
      .then((next: ProviderLimitsState) => {
        if (alive) setLimits(next);
      })
      .catch(() => {
        if (alive)
          setError("Account usage could not be loaded. Check your connection and try again.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function refreshLimits(): Promise<void> {
    setRefreshing(true);
    setError(undefined);
    try {
      setLimits(await window.modus.model.refreshLimits());
    } catch {
      setError("Refresh failed. Your last available account values are still shown as stale.");
      setLimits((current) =>
        current
          ? {
              ...current,
              accounts: current.accounts.map((account) =>
                account.status === "fresh" ? { ...account, status: "stale" } : account,
              ),
            }
          : current,
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function toggleCodex(enabled: boolean): Promise<void> {
    setCodexBusy(true);
    setError(undefined);
    try {
      setLimits(await window.modus.model.setCodexLimitsEnabled(enabled));
    } catch {
      setError("Codex CLI preference could not be saved. Please try again.");
    } finally {
      setCodexBusy(false);
    }
  }

  return (
    <>
      <SettingsPageHeader
        actions={
          <button
            aria-label="Refresh account usage"
            className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-50 motion-reduce:transition-none"
            disabled={loading || refreshing}
            onClick={() => void refreshLimits()}
            type="button"
          >
            <IconRefresh
              className={refreshing ? "animate-spin motion-reduce:animate-none" : ""}
              size={14}
              stroke={1.7}
            />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        }
        description="Configured model caps are separate from account usage reported by providers."
        title="Limits"
      />

      {error ? (
        <p aria-live="polite" className="-mt-4 text-danger text-xs">
          {error}
        </p>
      ) : null}

      <SettingsSection title="Model limits">
        <p className="-mt-2 mb-3 text-xs text-fg-faint">
          Configured metadata for enabled models; these are not live account quotas.
        </p>
        {modelGroups.length ? (
          <div className="grid gap-3">
            {modelGroups.map(([provider, rows]) => (
              <section
                className="overflow-hidden rounded-lg border border-hairline-soft bg-panel"
                key={provider}
              >
                <h3 className="border-hairline-soft border-b px-3 py-2 text-xs text-fg-muted">
                  {provider}
                </h3>
                <div className="divide-y divide-hairline-soft">
                  {rows.map((row) => (
                    <div
                      className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
                      key={row.id}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm text-fg">{row.modelName}</div>
                        <div className="text-2xs text-fg-faint">{row.providerName}</div>
                      </div>
                      <LimitValue label="Context window" value={row.contextWindow} />
                      <LimitValue label="Max output" value={row.maxTokens} />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <EmptyState
            compact
            description="Enable a model from a configured provider to see its catalog limits here."
            hint="No configured model limits"
          />
        )}
      </SettingsSection>

      <SettingsSection title="Account usage">
        <p className="-mt-2 mb-3 text-xs text-fg-faint">
          Provider-reported values only. Budgets and balances are not rate limits.
        </p>
        <div className="mb-3 rounded-lg border border-hairline-soft bg-panel px-3 py-3">
          <SettingsRow
            control={
              <SwitchControl
                ariaLabel="Include local Codex CLI usage"
                checked={limits?.codexCliEnabled ?? false}
                disabled={codexBusy || loading}
                onCheckedChange={(checked) => void toggleCodex(checked)}
              />
            }
            description="Reads rate-limit windows from the local Codex CLI. Its first-party app-server protocol is not a stable public API."
            title="ChatGPT / Codex"
          />
        </div>

        {loading ? (
          <div aria-label="Loading account usage" className="grid gap-2" role="status">
            <div className="h-20 animate-pulse rounded-lg border border-hairline-soft bg-panel motion-reduce:animate-none" />
            <span className="sr-only">Loading account usage…</span>
          </div>
        ) : limits?.accounts.length ? (
          <div className="grid gap-3">
            {limits.accounts.map((account) => (
              <article
                className="rounded-lg border border-hairline-soft bg-panel px-4 py-3"
                key={account.providerId}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm text-fg">{account.providerName}</h3>
                  <span
                    className={cn(
                      "rounded-full px-2 py-1 text-2xs",
                      account.status === "error"
                        ? "bg-danger/10 text-danger"
                        : account.status === "stale"
                          ? "bg-warning/10 text-warning"
                          : "bg-surface text-fg-faint",
                    )}
                  >
                    {accountStatusLabel(account.status, account.message)}
                  </span>
                </div>
                {account.metrics.length ? (
                  <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                    {account.metrics.map((metric) => (
                      <div
                        className="rounded-md border border-hairline-soft bg-canvas px-3 py-2"
                        key={metric.id}
                      >
                        <dt className="text-2xs text-fg-faint">{accountMetricLabel(metric)}</dt>
                        <dd className="mt-1 text-sm tabular-nums text-fg">
                          {usageMetricText(metric)}
                        </dd>
                        {metric.window ? (
                          <div className="mt-1 text-2xs text-fg-faint">Window: {metric.window}</div>
                        ) : null}
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="mt-2 text-xs text-fg-muted">
                    {accountStatusDescription(account.status, account.message)}
                  </p>
                )}
                {account.metrics.length > 0 &&
                (account.status === "stale" || account.status === "error") ? (
                  <p className="mt-2 text-xs text-fg-muted">
                    {accountStatusDescription(account.status, account.message)}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-x-3 text-2xs text-fg-faint">
                  {account.source ? <span>Source: {usageSourceLabel(account.source)}</span> : null}
                  {account.updatedAt ? (
                    <time dateTime={account.updatedAt}>
                      Updated {formatClock(Date.parse(account.updatedAt))}
                    </time>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            compact
            description="Connect a provider to see any account usage it officially reports."
            hint="No account usage available"
          />
        )}
      </SettingsSection>
    </>
  );
}

function LimitValue({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="min-w-[104px]">
      <div className="text-2xs text-fg-faint">{label}</div>
      <div className="mt-0.5 text-xs tabular-nums text-fg-muted">
        {value === undefined ? "Unavailable" : `${new Intl.NumberFormat().format(value)} tokens`}
      </div>
    </div>
  );
}

function accountStatusDescription(
  status: ProviderUsageStatus,
  message?: ProviderUsageMessage,
): string {
  if (status === "stale" && message === "authentication-failed") {
    return "Authentication failed. Reconnect or reconfigure this provider; the last available snapshot is still shown.";
  }
  if (status === "stale") return "The latest refresh failed; showing the last available snapshot.";
  if (status === "error" && message === "authentication-failed")
    return "Reconnect or reconfigure this provider to check its account usage.";
  if (status === "error") return "Could not reach this provider. Check your network and try again.";
  if (message === "unsupported")
    return "No supported account-usage source is available for this provider.";
  if (message === "not-configured") return "Configure this provider to check its account usage.";
  if (message === "codex-disabled")
    return "Turn on the optional local Codex CLI check to see its rate-limit windows.";
  if (message === "codex-cli-missing")
    return "Install the Codex CLI to use this optional account-usage source.";
  return "No account usage is currently available.";
}

function usageSourceLabel(source: NonNullable<ProviderAccountUsage["source"]>): string {
  switch (source) {
    case "openrouter-key":
      return "OpenRouter API key";
    case "deepseek-balance":
      return "DeepSeek account balance";
    case "codex-cli":
      return "Local Codex CLI";
  }
}

function AppearanceSettingsPanel() {
  const [theme, setTheme] = useTheme();
  return (
    <>
      <SettingsPageHeader
        description="Visual preferences aligned with the current Modus desktop theme."
        title="Appearance"
      />
      <SettingsSection title="Theme">
        <SettingsList>
          <SettingsRow
            control={<ThemeToggle onChange={setTheme} value={theme} />}
            description="Switch between light, dark, and softer Dark+ palettes."
            title="Color scheme"
          />
          <SettingsRow
            control={<ReadOnlyPill>Inter + Noto SC</ReadOnlyPill>}
            description="Self-hosted Inter Variable (Latin) and Noto Sans SC Variable (CJK); system faces only cover gaps."
            title="Font family"
          />
        </SettingsList>
      </SettingsSection>
    </>
  );
}

function PersonalizationSettingsPanel() {
  const [state, setState] = useState<PersonalizationState | undefined>();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.modus.personalization.get();
      setState(next);
      setDraft(next.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: initial load only; refresh is also used by Open file.
  useEffect(() => {
    void refresh();
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const next = await window.modus.personalization.save({ content: draft });
      setState(next);
      setDraft(next.content);
      setMessage("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function openFile(): Promise<void> {
    setError(undefined);
    try {
      await window.modus.personalization.open();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const dirty = state ? draft !== state.content : false;

  return (
    <>
      <SettingsPageHeader
        actions={
          <>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40"
              disabled={loading || saving}
              onClick={() => void openFile()}
              type="button"
            >
              <IconFileText size={14} stroke={1.7} />
              Open file
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40"
              disabled={!dirty || loading || saving}
              onClick={() => void save()}
              type="button"
            >
              <IconCheck size={13} stroke={2} />
              {saving ? <ShinyText className="text-canvas">Saving…</ShinyText> : "Save"}
            </button>
          </>
        }
        description="Persistent AGENTS.md guidance loaded before workspace rules."
        title="Personalization"
      />

      {error ? <p className="-mt-4 text-danger text-xs">{error}</p> : null}
      {message ? <p className="-mt-4 text-success text-xs">{message}</p> : null}

      <SettingsSection title="Custom instructions">
        <textarea
          className="scroll-thin min-h-[320px] resize-y rounded-lg border border-hairline-soft bg-panel px-4 py-3 font-mono text-sm text-fg leading-6 outline-none placeholder:text-fg-faint focus:border-focus-ring disabled:opacity-60"
          disabled={loading}
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage(undefined);
          }}
          placeholder="Add custom instructions..."
          value={loading ? "" : draft}
        />
      </SettingsSection>

      {state ? (
        <SettingsSection title="Files">
          <SettingsList>
            <SettingsRow
              control={<ReadOnlyPill>{state.overrideActive ? "Override" : "Base"}</ReadOnlyPill>}
              description={state.activePath}
              title="Active file"
            />
            <SettingsRow
              control={<ReadOnlyPill>{state.overrideActive ? "Active" : "Inactive"}</ReadOnlyPill>}
              description={state.overridePath}
              title="AGENTS.override.md"
            />
          </SettingsList>
        </SettingsSection>
      ) : null}
    </>
  );
}

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
type SettingsProjectTab = { rootPath: string; displayName: string };

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

const projectLabel = (cwd: string): string =>
  cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project";

function settingsProjectTabs(
  cwd: string | undefined,
  workspaces: WorkspaceInfo[],
): SettingsProjectTab[] {
  const seen = new Set<string>();
  const tabs: SettingsProjectTab[] = [];
  const push = (rootPath: string, displayName: string): void => {
    if (!rootPath || seen.has(rootPath)) return;
    seen.add(rootPath);
    tabs.push({ rootPath, displayName: displayName || projectLabel(rootPath) });
  };
  if (cwd) push(cwd, workspaces.find((workspace) => workspace.rootPath === cwd)?.displayName ?? "");
  for (const workspace of workspaces) push(workspace.rootPath, workspace.displayName);
  return tabs;
}

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
function McpSettingsPanel({
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
              {syncing ? <ShinyText>Connecting…</ShinyText> : "Reload"}
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
        <h4 className="text-sm text-fg">
          {isNew ? "Add MCP server" : `Edit “${form.originalName}”`}
        </h4>
        {isNew ? (
          <div className="flex gap-1">
            {MCP_PRESETS.map((preset) => (
              <button
                className="h-6 rounded-md bg-chip px-2 text-2xs text-fg-subtle transition-colors hover:bg-chip-strong hover:text-fg"
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
              <ShinyText className="text-canvas">Connecting…</ShinyText>
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

function McpTypeCard({
  active,
  description,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  description: string;
  icon: ReactNode;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
        active
          ? "border-focus-ring bg-chip-faint"
          : "border-hairline-soft bg-surface/45 hover:border-hairline-strong",
      )}
      onClick={onClick}
      type="button"
    >
      <span
        className={cn("flex items-center gap-1.5 text-sm", active ? "text-fg" : "text-fg-muted")}
      >
        {icon}
        {label}
      </span>
      <span className="text-2xs text-fg-faint leading-relaxed">{description}</span>
    </button>
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

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string; icon: typeof IconSun }> = [
  { value: "light", label: "Light", icon: IconSun },
  { value: "dark", label: "Dark", icon: IconMoon },
  { value: "dark-plus", label: "Eye-care Dark", icon: IconMoonStars },
];

function ThemeToggle({
  value,
  onChange,
}: {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-hairline-soft bg-canvas p-0.5">
      {THEME_OPTIONS.map(({ value: option, label, icon: Icon }) => {
        const active = option === value;
        return (
          <button
            aria-pressed={active}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
              active ? "bg-active text-fg shadow-composer" : "text-fg-subtle hover:text-fg-muted",
            )}
            key={option}
            onClick={() => onChange(option)}
            title={`${label} theme`}
            type="button"
          >
            <Icon size={14} stroke={1.8} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function RulesSettingsPanel({ cwd }: { cwd: string | undefined }) {
  const [rules, setRules] = useState<RuleFileInfo[]>([]);
  const [agents, setAgents] = useState<WorkspaceAgentsState | undefined>();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rulesError, setRulesError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();

  async function refresh(): Promise<void> {
    if (!cwd) {
      setRules([]);
      setAgents(undefined);
      setDraft("");
      return;
    }
    setLoading(true);
    setRulesError(undefined);
    try {
      const [nextRules, nextAgents] = await Promise.all([
        window.modus.rules.list(cwd),
        window.modus.rules.getAgents(cwd),
      ]);
      setRules(nextRules);
      setAgents(nextAgents);
      setDraft(nextAgents.exists ? nextAgents.content : nextAgents.example);
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is recreated each render; cwd is the real trigger.
  useEffect(() => {
    void refresh();
  }, [cwd]);

  async function openRule(rule: RuleFileInfo): Promise<void> {
    if (!cwd) {
      return;
    }
    try {
      await window.modus.file.open({ cwd, path: rule.relPath });
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveAgents(): Promise<void> {
    if (!cwd) {
      return;
    }
    setSaving(true);
    setRulesError(undefined);
    setMessage(undefined);
    try {
      const next = await window.modus.rules.saveAgents({ cwd, content: draft });
      setAgents(next);
      setDraft(next.content);
      setMessage(next.exists ? "AGENTS.md saved." : "AGENTS.md created.");
      setRules(await window.modus.rules.list(cwd));
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function useExample(): void {
    if (!agents) {
      return;
    }
    setDraft(agents.example);
    setMessage(undefined);
  }

  const autoApplied = rules.filter((rule) => rule.mode === "always");
  const dirty = agents ? draft !== (agents.exists ? agents.content : agents.example) : false;
  const exampleLoaded = Boolean(agents && !agents.exists && draft === agents.example);

  return (
    <>
      <SettingsPageHeader
        actions={
          <>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40"
              disabled={!cwd || loading}
              onClick={() => void refresh()}
              type="button"
            >
              <IconRefresh size={14} stroke={1.7} />
              {loading ? <ShinyText>Refreshing…</ShinyText> : "Refresh"}
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40"
              disabled={!cwd || loading || saving || (!dirty && Boolean(agents?.exists))}
              onClick={() => void saveAgents()}
              type="button"
            >
              <IconCheck size={13} stroke={2} />
              {saving ? (
                <ShinyText className="text-canvas">Saving…</ShinyText>
              ) : agents?.exists ? (
                "Save"
              ) : (
                "Create AGENTS.md"
              )}
            </button>
          </>
        }
        description="Project rules are injected into every agent session automatically when marked Always Apply (AGENTS.md, CLAUDE.md, .cursorrules, or .cursor/rules/*.mdc with alwaysApply: true). Other rules stay available through the @rules context attachment."
        title="Rules"
      />

      {rulesError ? <p className="-mt-4 text-danger text-xs">{rulesError}</p> : null}
      {message ? <p className="-mt-4 text-success text-xs">{message}</p> : null}

      <SettingsSection
        title="AGENTS.md"
        description={
          exampleLoaded
            ? "Starter example — edit freely, then create the file in this workspace."
            : "Always-applied workspace rules. Edit here or open the file on disk."
        }
      >
        {!cwd ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-6">
            <p className="text-sm text-fg-muted">Open a workspace to edit project rules.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <ReadOnlyPill>{agents?.exists ? "On disk" : "Example (not saved)"}</ReadOnlyPill>
              <button
                className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40"
                disabled={!agents || loading || saving}
                onClick={useExample}
                type="button"
              >
                Reset to example
              </button>
              {agents?.exists ? (
                <button
                  className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40"
                  disabled={loading || saving}
                  onClick={() =>
                    void openRule({
                      path: agents.path,
                      relPath: "AGENTS.md",
                      source: "agents-md",
                      mode: "always",
                      size: new TextEncoder().encode(agents.content).byteLength,
                    })
                  }
                  type="button"
                >
                  <IconFileText size={14} stroke={1.7} />
                  Open file
                </button>
              ) : null}
            </div>
            <textarea
              className="scroll-thin min-h-[280px] w-full resize-y rounded-lg border border-hairline-soft bg-panel px-4 py-3 font-mono text-sm text-fg leading-6 outline-none placeholder:text-fg-faint focus:border-focus-ring disabled:opacity-60"
              disabled={loading || saving}
              onChange={(event) => {
                setDraft(event.target.value);
                setMessage(undefined);
              }}
              placeholder="Project rules…"
              spellCheck={false}
              value={loading ? "" : draft}
            />
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Detected rule files">
        {!cwd ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-6">
            <p className="text-sm text-fg-muted">Open a workspace to discover project rules.</p>
          </div>
        ) : loading && rules.length === 0 && !agents ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-6 text-sm text-fg-muted">
            <ShinyText>Scanning workspace…</ShinyText>
          </div>
        ) : rules.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-hairline-soft bg-panel px-5 py-6">
            <p className="text-sm text-fg-muted">
              No rule files on disk yet. Save the example above to create{" "}
              <span className="font-mono text-xs">AGENTS.md</span>, or add{" "}
              <span className="font-mono text-xs">.cursor/rules/*.mdc</span> with{" "}
              <span className="font-mono text-xs">alwaysApply: true</span>.
            </p>
          </div>
        ) : (
          <SettingsList>
            {rules.map((rule) => (
              <button
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-hairline-soft border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-hover"
                key={rule.path}
                onClick={() => void openRule(rule)}
                type="button"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex size-5 shrink-0 items-center justify-center text-fg-faint">
                      <IconGavel size={15} stroke={1.7} />
                    </span>
                    <span className="shrink-0 font-mono text-sm text-fg">{rule.relPath}</span>
                    <RuleModeBadge mode={rule.mode} />
                  </div>
                  {rule.description ? (
                    <p className="mt-1 truncate pl-7.5 text-xs text-fg-subtle">
                      {rule.description}
                    </p>
                  ) : null}
                  {rule.globs ? (
                    <p className="mt-0.5 truncate pl-7.5 font-mono text-2xs text-fg-faint">
                      globs: {rule.globs}
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 rounded bg-chip-faint px-1.5 py-px text-2xs text-fg-faint">
                  {ruleSourceLabel(rule.source)}
                </span>
              </button>
            ))}
          </SettingsList>
        )}
      </SettingsSection>

      {cwd && autoApplied.length > 0 ? (
        <SettingsSection title="Auto-applied">
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-4">
            <p className="text-sm text-fg-muted">
              {autoApplied.length} rule file{autoApplied.length === 1 ? "" : "s"} injected into the
              system prompt for every new agent session in this workspace.
            </p>
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
}

function ruleSourceLabel(source: RuleSource): string {
  switch (source) {
    case "agents-md":
      return "AGENTS.md";
    case "claude-md":
      return "CLAUDE.md";
    case "cursorrules":
      return ".cursorrules";
    case "cursor-rule":
      return ".mdc";
  }
}

function RuleModeBadge({ mode }: { mode: RuleMode }) {
  const label =
    mode === "always"
      ? "Always"
      : mode === "glob"
        ? "Glob"
        : mode === "intelligent"
          ? "Intelligent"
          : "Manual";
  const tone =
    mode === "always"
      ? "bg-focus-ring-soft/15 text-focus-ring-soft"
      : "bg-chip-faint text-fg-faint";
  return <span className={cn("shrink-0 rounded px-1.5 py-px text-2xs", tone)}>{label}</span>;
}

function SkillsSettingsPanel({ cwd }: { cwd: string | undefined }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function refresh(): Promise<void> {
    if (!cwd) {
      setSkills([]);
      return;
    }
    setLoading(true);
    setSkillsError(undefined);
    try {
      setSkills(await window.modus.skills.list(cwd));
    } catch (error) {
      setSkillsError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is recreated each render; cwd is the real trigger.
  useEffect(() => {
    void refresh();
  }, [cwd]);

  async function saveSkill(): Promise<void> {
    if (!cwd || !draftName.trim()) {
      return;
    }
    setSaving(true);
    setSkillsError(undefined);
    try {
      await window.modus.skills.create({
        cwd,
        name: draftName.trim(),
        description: draftDescription.trim(),
        body: draftBody.trim(),
      });
      setCreating(false);
      setDraftName("");
      setDraftDescription("");
      setDraftBody("");
      await refresh();
    } catch (error) {
      setSkillsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function scopeBadge(skill: SkillInfo): string {
    if (skill.scope === "builtin") {
      return "builtin";
    }
    return skill.scope === "user" ? `user · ${skill.source}` : `project · ${skill.source}`;
  }

  return (
    <>
      <SettingsPageHeader
        actions={
          <>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40"
              disabled={!cwd}
              onClick={() => void window.modus.skills.openDir(cwd as string)}
              type="button"
            >
              <IconWorld size={14} stroke={1.7} />
              Open folder
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40"
              disabled={!cwd}
              onClick={() => setCreating((value) => !value)}
              type="button"
            >
              <IconPlus size={14} stroke={2} />
              New
            </button>
          </>
        }
        description="Skills are specialized capabilities that help the agent accomplish specific tasks. Skills are invoked by the agent when relevant, or triggered manually with / in chat."
        title="Skills"
      />

      {skillsError ? <p className="-mt-4 text-danger text-xs">{skillsError}</p> : null}

      <CollapsibleMotion open={creating && Boolean(cwd)} preset="default">
        <div className="flex flex-col gap-3 rounded-lg border border-hairline-soft bg-panel px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-subtle">Name</span>
            <input
              className="h-8 rounded-md border border-hairline bg-surface px-2.5 text-sm text-fg outline-none focus:border-focus-ring"
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="code-review"
              value={draftName}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-subtle">Description</span>
            <textarea
              className="scroll-thin min-h-[68px] resize-none rounded-md border border-hairline bg-surface px-2.5 py-2 text-sm text-fg leading-5 outline-none focus:border-focus-ring"
              maxLength={280}
              onChange={(event) => setDraftDescription(event.target.value)}
              placeholder="Review a diff for correctness and security"
              value={draftDescription}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-subtle">Instructions</span>
            <textarea
              className="scroll-thin min-h-48 resize-y rounded-md border border-hairline bg-surface px-3 py-2 font-mono text-xs text-fg leading-5 outline-none placeholder:text-fg-faint focus:border-focus-ring"
              onChange={(event) => setDraftBody(event.target.value)}
              placeholder={
                "# code-review\n\nUse this skill when reviewing code.\n\n## Steps\n\n1. Read the diff.\n2. Find correctness risks.\n3. Return concise findings first."
              }
              value={draftBody}
            />
          </label>
          <div className="flex items-center justify-end gap-2">
            <button
              className="flex h-8 items-center rounded-md border border-hairline bg-surface px-3 text-xs text-fg-muted transition-colors hover:bg-hover"
              onClick={() => setCreating(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40"
              disabled={!draftName.trim() || !draftBody.trim() || saving}
              onClick={() => void saveSkill()}
              type="button"
            >
              {saving ? <ShinyText className="text-canvas">Creating…</ShinyText> : "Create skill"}
            </button>
          </div>
        </div>
      </CollapsibleMotion>

      <SettingsSection title="Available skills">
        {!cwd ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-6">
            <p className="text-sm text-fg-muted">Open a workspace to discover and create skills.</p>
          </div>
        ) : loading && skills.length === 0 ? (
          <div className="rounded-lg border border-hairline-soft bg-panel px-5 py-6 text-sm text-fg-muted">
            <ShinyText>Discovering skills…</ShinyText>
          </div>
        ) : skills.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-hairline-soft bg-panel px-5 py-6">
            <p className="text-sm text-fg-muted">
              No skills yet. Create one, or drop a{" "}
              <span className="font-mono text-xs">SKILL.md</span> into{" "}
              <span className="font-mono text-xs">.modus/skills/&lt;name&gt;/</span>.
            </p>
          </div>
        ) : (
          <SettingsList>
            {skills.map((skill) => (
              <div
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-hairline-soft border-b px-4 py-3 last:border-b-0"
                key={skill.path}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-5 shrink-0 items-center justify-center text-fg-faint">
                    <IconCube size={15} stroke={1.7} />
                  </span>
                  <span className="shrink-0 font-mono text-sm text-fg">/{skill.name}</span>
                  {skill.description ? (
                    <span className="min-w-0 truncate text-xs text-fg-subtle">
                      {skill.description}
                    </span>
                  ) : null}
                </div>
                <span className="shrink-0 rounded bg-chip-faint px-1.5 py-px text-2xs text-fg-faint">
                  {scopeBadge(skill)}
                </span>
              </div>
            ))}
          </SettingsList>
        )}
      </SettingsSection>
    </>
  );
}

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

function SubagentsSettingsPanel({
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

function SettingsPageHeader({
  actions,
  description,
  title,
}: {
  actions?: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <header className="sticky top-0 z-10 -mx-10 -mt-16 flex items-end justify-between gap-5 bg-gradient-to-b from-canvas via-canvas to-canvas/0 px-10 pt-16 pb-8">
      <div className="min-w-0">
        <h2 className="text-lg font-normal text-fg">{title}</h2>
        <p className="mt-2 text-sm text-fg-muted">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2 pb-0.5">{actions}</div> : null}
    </header>
  );
}

function SettingsSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="min-w-0">
        <h3 className="text-sm font-normal text-fg">{title}</h3>
        {description ? <p className="mt-1 text-xs text-fg-faint">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function SettingsList({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-hairline-soft bg-panel">
      {children}
    </div>
  );
}

function SettingsRow({
  control,
  description,
  title,
}: {
  control: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="flex min-h-[72px] items-center gap-5 border-hairline-soft border-b px-5 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg">{title}</div>
        <div className="mt-1 text-xs text-fg-muted">{description}</div>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function ReadOnlyPill({ children }: { children: string }) {
  return <span className="rounded-md bg-chip px-2.5 py-1 text-xs text-fg-muted">{children}</span>;
}

function ProviderGroup({ children, title }: { children: ReactNode; title: string }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  if (items.length === 0) {
    return null;
  }

  return (
    <section className="mb-4 last:mb-0">
      <div className="mb-2 flex items-center justify-between px-2">
        <h4 className="text-xs font-normal text-fg-faint">{title}</h4>
        <span className="font-mono text-2xs text-fg-faint">{items.length}</span>
      </div>
      <div className="grid gap-1">{items}</div>
    </section>
  );
}

function ProviderCatalogRow({
  provider,
  active,
  onClick,
}: {
  provider: ModelProviderInfo;
  active: boolean;
  onClick(): void;
}) {
  return <ProviderRow active={active} onClick={onClick} provider={provider} />;
}

function ProviderRow({
  provider,
  active,
  onClick,
}: {
  provider: ModelProviderInfo;
  active: boolean;
  onClick(): void;
}) {
  const status = providerStatus(provider);

  return (
    <m.button
      aria-current={active ? "true" : undefined}
      className={cn(
        "group grid min-h-[58px] w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 text-left outline-none transition-colors",
        active
          ? "border-hairline-strong bg-active text-fg"
          : "border-transparent text-fg-muted hover:border-hairline-soft hover:bg-hover hover:text-fg",
      )}
      layout
      onClick={onClick}
      type="button"
      whileTap={{ scale: 0.992 }}
    >
      <ProviderLogo framed={false} name={provider.name} provider={provider.id} size="sm" />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-fg">{provider.name}</span>
          {provider.source === "custom" ? <TinyBadge>custom</TinyBadge> : null}
        </span>
        <span className="mt-0.5 block truncate text-xs text-fg-faint">
          {providerSummary(provider)}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <ProviderStatusPill status={status} />
        <IconChevronRight
          className={cn(
            "text-fg-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg-subtle",
            active && "text-fg-subtle",
          )}
          size={14}
          stroke={1.7}
        />
      </span>
    </m.button>
  );
}

function ProviderDetail({
  detail,
  busy,
  credentialEditorOpen,
  keyValue,
  onConnect,
  onCredentialEditorClose,
  onDeleteProvider,
  onDisconnectProvider,
  onEditModel,
  onEditProvider,
  onKeyChange,
  onOpenProviderConnection,
  onSetAllModels,
  onToggleModel,
}: {
  detail: ModelProviderDetail;
  busy: boolean;
  credentialEditorOpen: boolean;
  keyValue: string;
  onConnect(apiKey: string, baseUrl?: string): void;
  onCredentialEditorClose(): void;
  onDeleteProvider(): void;
  onDisconnectProvider(): void;
  onEditModel(model: ProviderModelConfig, patch: ModelConfigPatch): void;
  onEditProvider(providerId: string): void;
  onKeyChange(apiKey: string): void;
  onOpenProviderConnection(): void;
  onSetAllModels(enabled: boolean): void;
  onToggleModel(model: ProviderModelConfig, enabled: boolean): void;
}) {
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [modelFilter, setModelFilter] = useState<ModelFilter>("all");
  const models = useMemo(() => detail.models.slice().sort(compareModelConfig), [detail.models]);
  const enabledCount = useMemo(() => models.filter((model) => model.enabled).length, [models]);
  const thinkingCount = useMemo(() => models.filter((model) => model.reasoning).length, [models]);
  const filteredModels = useMemo(
    () =>
      models.filter(
        (model) =>
          modelMatchesFilter(model, modelFilter) &&
          modelMatchesQuery(model, normalizeSearchValue(modelQuery)),
      ),
    [models, modelFilter, modelQuery],
  );
  const modelGroups = useMemo(() => groupProviderModels(filteredModels), [filteredModels]);
  const allEnabled = enabledCount === models.length && models.length > 0;
  const noneEnabled = enabledCount === 0;

  return (
    <m.section
      animate={{ opacity: 1, y: 0 }}
      className="flex min-w-0 flex-col"
      exit={{ opacity: 0, y: 8 }}
      initial={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
    >
      <div className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <ProviderLogo name={detail.name} provider={detail.id} size="lg" />
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="truncate text-md font-normal text-fg">{detail.name}</h3>
                {detail.source === "custom" ? <TinyBadge>custom</TinyBadge> : null}
              </div>
            </div>
          </div>
          <ProviderStatusPill status={providerStatus(detail)} />
        </div>
      </div>

      <ProviderCredentials
        busy={busy}
        credentialEditorOpen={credentialEditorOpen}
        detail={detail}
        keyValue={keyValue}
        onConnect={onConnect}
        onCredentialEditorClose={onCredentialEditorClose}
        onDeleteProvider={onDeleteProvider}
        onDisconnectProvider={onDisconnectProvider}
        onEditProvider={() => onEditProvider(detail.id)}
        onKeyChange={onKeyChange}
        onOpenConnection={onOpenProviderConnection}
      />

      <div className="mt-4">
        <button
          aria-expanded={modelsOpen}
          className="flex w-full items-center justify-between gap-3 rounded-lg bg-chip-faint px-3 py-3 text-left transition-colors hover:bg-hover"
          onClick={() => setModelsOpen((open) => !open)}
          type="button"
        >
          <span className="min-w-0">
            <span className="block text-sm text-fg">Models</span>
            <span className="mt-0.5 block text-xs text-fg-faint">
              {`${enabledCount} of ${detail.modelCount} enabled`}
            </span>
          </span>
          <IconChevronRight
            className={cn("shrink-0 text-fg-faint transition-transform", modelsOpen && "rotate-90")}
            size={16}
            stroke={1.7}
          />
        </button>

        <CollapsibleMotion open={modelsOpen} preset="compact">
          <div className="pt-3">
            <div className="flex flex-wrap items-center justify-end gap-2">
              {busy ? (
                <span className="rounded-md bg-chip px-2.5 py-1 text-xs text-fg-muted">
                  <ShinyText>Saving</ShinyText>
                </span>
              ) : (
                <ReadOnlyPill>{modelResultLabel(filteredModels.length)}</ReadOnlyPill>
              )}
              <button
                className="flex h-8 items-center rounded-md bg-chip-faint px-3 text-sm text-fg-subtle transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
                disabled={busy || allEnabled || models.length === 0}
                onClick={() => onSetAllModels(true)}
                type="button"
              >
                Enable all
              </button>
              <button
                className="flex h-8 items-center rounded-md bg-chip-faint px-3 text-sm text-fg-subtle transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
                disabled={busy || noneEnabled}
                onClick={() => onSetAllModels(false)}
                type="button"
              >
                Disable all
              </button>
              {detail.source === "custom" ? (
                <button
                  className="flex h-8 items-center gap-1.5 rounded-md bg-chip-faint px-3 text-sm text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
                  onClick={() => onEditProvider(detail.id)}
                  type="button"
                >
                  <IconPlus size={14} stroke={1.8} />
                  Edit models
                </button>
              ) : null}
            </div>

            <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-center">
              <SearchField
                ariaLabel="Search models"
                onChange={setModelQuery}
                placeholder="Search models..."
                value={modelQuery}
              />
              <SegmentedFilter
                enabledCount={enabledCount}
                onChange={setModelFilter}
                thinkingCount={thinkingCount}
                value={modelFilter}
              />
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border border-hairline-soft bg-panel">
              {filteredModels.length > 0 ? (
                modelGroups.map((group) => (
                  <ModelGroupSection
                    busy={busy}
                    editableLimits={detail.source === "custom"}
                    group={group}
                    key={group.id}
                    onEditModel={onEditModel}
                    onToggleModel={onToggleModel}
                  />
                ))
              ) : (
                <EmptyState
                  compact
                  description="Adjust the search text or filter to bring models back."
                  hint="No models match"
                />
              )}
            </div>
          </div>
        </CollapsibleMotion>
      </div>
    </m.section>
  );
}

function ProviderCredentials({
  detail,
  busy,
  credentialEditorOpen,
  keyValue,
  onConnect,
  onCredentialEditorClose,
  onDeleteProvider,
  onDisconnectProvider,
  onEditProvider,
  onKeyChange,
  onOpenConnection,
}: {
  detail: ModelProviderDetail;
  busy: boolean;
  credentialEditorOpen: boolean;
  keyValue: string;
  onConnect(apiKey: string, baseUrl?: string): void;
  onCredentialEditorClose(): void;
  onDeleteProvider(): void;
  onDisconnectProvider(): void;
  onEditProvider(): void;
  onKeyChange(apiKey: string): void;
  onOpenConnection(): void;
}) {
  const storedBaseUrl = detail.baseUrl ?? "";
  const [baseUrl, setBaseUrl] = useState(storedBaseUrl);
  const baseUrlChanged = baseUrl.trim() !== storedBaseUrl;
  const canSubmit = Boolean(keyValue.trim()) || baseUrlChanged;
  const canDisconnect = detail.authSource === "stored" && Boolean(detail.authKind);
  const editing = detail.source === "builtin" && (!detail.configured || credentialEditorOpen);
  const connectionLabel = !detail.configured
    ? "Not connected"
    : canDisconnect
      ? (detail.authLabel ?? "Connected locally")
      : detail.authSource
        ? `Managed by ${detail.authLabel ?? detail.authSource}`
        : "Saved in Modus";

  if (!editing) {
    return (
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-chip-faint px-3 py-3">
        <span className="min-w-0">
          <span className="block text-sm text-fg">Connection</span>
          <span className="mt-0.5 block truncate text-xs text-fg-faint">{connectionLabel}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            className="h-8 rounded-full bg-canvas/70 px-3 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
            onClick={detail.source === "custom" ? onEditProvider : onOpenConnection}
            type="button"
          >
            {detail.source === "custom" ? "Edit" : "Change"}
          </button>
          {canDisconnect ? (
            <button
              className="h-8 rounded-full bg-danger/10 px-3 text-xs text-danger transition-[background-color,transform] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-danger/15 active:scale-[0.97]"
              onClick={onDisconnectProvider}
              type="button"
            >
              Disconnect
            </button>
          ) : null}
          {detail.source === "custom" ? (
            <button
              aria-label={`Remove ${detail.name}`}
              className="flex size-8 items-center justify-center rounded-full text-danger transition-colors hover:bg-danger/10"
              onClick={onDeleteProvider}
              type="button"
            >
              <IconTrash size={14} stroke={1.7} />
            </button>
          ) : null}
        </span>
      </section>
    );
  }

  return (
    <form
      className="rounded-lg bg-chip-faint p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onConnect(keyValue, baseUrl.trim());
      }}
    >
      <div className="flex flex-wrap gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">API key for {detail.name}</span>
          <IconKey
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-faint"
            size={15}
            stroke={1.7}
          />
          <input
            className="h-9 w-full rounded-md border border-hairline bg-canvas pr-3 pl-9 text-sm text-fg outline-none placeholder:text-fg-faint transition-colors focus:border-hairline-strong"
            onChange={(event) => onKeyChange(event.target.value)}
            placeholder={detail.configured ? "Update API key" : "API key"}
            type="password"
            value={keyValue}
          />
        </label>
        <button
          className="flex h-9 min-w-[92px] items-center justify-center gap-1.5 rounded-md bg-fg px-3 text-sm text-canvas transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || !canSubmit}
          type="submit"
        >
          {busy ? (
            <ShinyText className="text-canvas">Connecting…</ShinyText>
          ) : detail.configured ? (
            "Update"
          ) : (
            "Connect"
          )}
        </button>
        {detail.configured ? (
          <button
            className="h-9 rounded-md px-3 text-sm text-fg-faint transition-colors hover:bg-hover hover:text-fg"
            disabled={busy}
            onClick={onCredentialEditorClose}
            type="button"
          >
            Cancel
          </button>
        ) : null}
      </div>

      <label className="relative mt-2 block min-w-0">
        <span className="sr-only">Custom base URL for {detail.name}</span>
        <IconWorld
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-faint"
          size={15}
          stroke={1.7}
        />
        <input
          autoComplete="off"
          className="h-9 w-full rounded-md border border-hairline bg-canvas pr-3 pl-9 font-mono text-sm text-fg outline-none placeholder:text-fg-faint transition-colors focus:border-hairline-strong"
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="Custom base URL — official endpoint by default"
          spellCheck={false}
          type="url"
          value={baseUrl}
        />
      </label>
    </form>
  );
}

function ModelGroupSection({
  group,
  busy,
  editableLimits,
  onEditModel,
  onToggleModel,
}: {
  group: ReturnType<typeof groupProviderModels>[number];
  busy: boolean;
  editableLimits: boolean;
  onEditModel(model: ProviderModelConfig, patch: ModelConfigPatch): void;
  onToggleModel(model: ProviderModelConfig, enabled: boolean): void;
}) {
  return (
    <section>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-hairline-soft border-b bg-panel/95 px-5 py-2.5 backdrop-blur">
        <div className="min-w-0">
          <h5 className="text-xs font-normal text-fg-muted">{group.title}</h5>
          <p className="mt-0.5 text-2xs text-fg-faint">{group.description}</p>
        </div>
        <ReadOnlyPill>{group.models.length.toString()}</ReadOnlyPill>
      </div>
      <AnimatePresence initial={false}>
        {group.models.map((model) => (
          <ModelRow
            busy={busy}
            editableLimits={editableLimits}
            key={model.id}
            model={model}
            onEditModel={onEditModel}
            onToggleModel={onToggleModel}
          />
        ))}
      </AnimatePresence>
    </section>
  );
}

function ModelRow({
  model,
  busy,
  editableLimits,
  onEditModel,
  onToggleModel,
}: {
  model: ProviderModelConfig;
  busy: boolean;
  editableLimits: boolean;
  onEditModel(model: ProviderModelConfig, patch: ModelConfigPatch): void;
  onToggleModel(model: ProviderModelConfig, enabled: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const thinkingOptions = useMemo(() => modelThinkingOptions(model), [model]);
  const thinkingSelection = selectedThinkingOption(model);
  const thinkingLabel = selectedThinkingLabel(model);
  const canEditThinking = thinkingOptions.length > 1 || Boolean(model.thinkingBudget);
  const expandable = canEditThinking || editableLimits;
  const [budgetDraft, setBudgetDraft] = useState(
    model.thinkingLevel !== "off" && model.thinkingVariant
      ? model.thinkingVariant
      : model.thinkingBudget?.min !== undefined
        ? String(model.thinkingBudget.min)
        : "",
  );
  const [contextDraft, setContextDraft] = useState(
    model.contextWindow ? String(model.contextWindow) : "",
  );
  const [maxTokensDraft, setMaxTokensDraft] = useState(
    model.maxTokens ? String(model.maxTokens) : "",
  );
  useEffect(() => {
    setBudgetDraft(
      model.thinkingLevel !== "off" && model.thinkingVariant
        ? model.thinkingVariant
        : model.thinkingBudget?.min !== undefined
          ? String(model.thinkingBudget.min)
          : "",
    );
  }, [model.thinkingBudget?.min, model.thinkingLevel, model.thinkingVariant]);

  function saveLimits(): void {
    const patch: { contextWindow?: number; maxTokens?: number } = {};
    const context = parsePositiveInteger(contextDraft);
    const maxTokens = parsePositiveInteger(maxTokensDraft);
    if (context !== undefined && context !== model.contextWindow) {
      patch.contextWindow = context;
    }
    if (maxTokens !== undefined && maxTokens !== model.maxTokens) {
      patch.maxTokens = maxTokens;
    }
    if (patch.contextWindow !== undefined || patch.maxTokens !== undefined) {
      onEditModel(model, patch);
    }
  }

  function saveBudget(): void {
    const tokens = Number(budgetDraft);
    const budget = model.thinkingBudget;
    if (
      !budget ||
      !Number.isSafeInteger(tokens) ||
      tokens < 0 ||
      (budget.min !== undefined && tokens < budget.min) ||
      (budget.max !== undefined && tokens > budget.max)
    ) {
      return;
    }
    onEditModel(model, { thinkingVariant: String(tokens) });
  }

  return (
    <m.div
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "border-hairline-soft border-b px-5 py-3 last:border-b-0",
        model.enabled ? "bg-chip-faint" : "hover:bg-hover",
      )}
      exit={{ opacity: 0, y: -4 }}
      initial={{ opacity: 0, y: 4 }}
      layout
      transition={{ duration: 0.14, ease: "easeOut" }}
    >
      <div className="grid min-h-[44px] grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-sm text-fg">{model.name}</span>
            <ModelKindBadge model={model} />
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-fg-faint">
            <span className="min-w-0 truncate font-mono">{model.id}</span>
            {model.contextWindow ? (
              <span>{`${model.contextWindow.toLocaleString()} ctx`}</span>
            ) : null}
            {model.maxTokens ? <span>{`${model.maxTokens.toLocaleString()} out`}</span> : null}
            {model.thinkingLevel !== "off" ? <span>{thinkingLabel}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {expandable ? (
            <button
              aria-expanded={open}
              aria-label={`Configure ${model.name}`}
              className="flex size-8 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg"
              onClick={() => setOpen((value) => !value)}
              type="button"
            >
              <IconAdjustments size={15} stroke={1.7} />
            </button>
          ) : null}
          <SwitchControl
            ariaLabel={`${model.enabled ? "Disable" : "Enable"} ${model.name}`}
            checked={model.enabled}
            disabled={busy}
            onCheckedChange={(checked) => onToggleModel(model, checked)}
          />
        </div>
      </div>

      <CollapsibleMotion open={open && expandable} preset="default">
        <div className="mt-3 grid gap-4 border-hairline-soft border-t pt-4">
          {model.thinkingBudget ? (
            <div className="grid max-w-sm grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-2">
              <Field
                label="Thinking budget (tokens)"
                onChange={setBudgetDraft}
                placeholder={model.thinkingBudget.min?.toString() ?? "Tokens"}
                value={budgetDraft}
              />
              <button
                className="flex h-10 items-center justify-center rounded-md bg-fg px-3 text-sm text-canvas transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy}
                onClick={saveBudget}
                type="button"
              >
                Apply
              </button>
              <button
                className="flex h-10 items-center justify-center rounded-md px-3 text-fg-muted text-sm transition-colors hover:bg-hover hover:text-fg"
                disabled={busy || model.thinkingLevel === "off"}
                onClick={() => onEditModel(model, { thinkingVariant: "off" })}
                type="button"
              >
                Off
              </button>
            </div>
          ) : canEditThinking ? (
            <div className="grid max-w-xs gap-2">
              <SelectField
                label="Default thinking level"
                onChange={(value) => onEditModel(model, { thinkingVariant: value })}
                options={thinkingOptions}
                value={thinkingSelection.value}
              />
            </div>
          ) : null}
          {editableLimits ? (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
              <Field
                label="Context window"
                onChange={setContextDraft}
                placeholder="128000"
                value={contextDraft}
              />
              <Field
                label="Max output tokens"
                onChange={setMaxTokensDraft}
                placeholder="16384"
                value={maxTokensDraft}
              />
              <button
                className="flex h-10 items-center justify-center rounded-md bg-fg px-3 text-sm text-canvas transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy}
                onClick={saveLimits}
                type="button"
              >
                Save
              </button>
            </div>
          ) : null}
        </div>
      </CollapsibleMotion>
    </m.div>
  );
}

function SegmentedFilter({
  enabledCount,
  thinkingCount,
  value,
  onChange,
}: {
  enabledCount: number;
  thinkingCount: number;
  value: ModelFilter;
  onChange(value: ModelFilter): void;
}) {
  const options: Array<{ value: ModelFilter; label: string; count?: number }> = [
    { value: "all", label: "All" },
    { value: "enabled", label: "Enabled", count: enabledCount },
    { value: "thinking", label: "Thinking", count: thinkingCount },
  ];

  return (
    <fieldset className="flex shrink-0 items-center gap-1 rounded-lg border border-hairline bg-canvas p-1">
      <legend className="sr-only">Filter models</legend>
      <IconFilter className="ml-1 text-fg-faint" size={14} stroke={1.7} />
      {options.map((option) => (
        <button
          className={cn(
            "flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors",
            value === option.value
              ? "bg-active text-fg"
              : "text-fg-subtle hover:bg-hover hover:text-fg",
          )}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
          {option.count !== undefined ? (
            <span className="font-mono text-2xs text-fg-faint">{option.count}</span>
          ) : null}
        </button>
      ))}
    </fieldset>
  );
}

function ProviderDetailLoading() {
  return (
    <m.section
      animate={{ opacity: 1, y: 0 }}
      className="flex min-h-[320px] min-w-0 items-center justify-center px-5 py-10"
      exit={{ opacity: 0, y: 8 }}
      initial={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
    >
      <ShinyText className="text-sm">Loading provider</ShinyText>
    </m.section>
  );
}

function SearchField({
  ariaLabel,
  placeholder,
  value,
  onChange,
}: {
  ariaLabel: string;
  placeholder: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label className="relative block min-w-0 flex-1">
      <span className="sr-only">{ariaLabel}</span>
      <IconSearch
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint"
        size={15}
        stroke={1.7}
      />
      <input
        aria-label={ariaLabel}
        className="h-9 w-full rounded-md border border-hairline bg-canvas pr-8 pl-8 text-sm text-fg outline-none placeholder:text-fg-faint transition-colors focus:border-hairline-strong"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
      {value ? (
        <button
          aria-label={`Clear ${ariaLabel.toLowerCase()}`}
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg"
          onClick={() => onChange("")}
          type="button"
        >
          <IconX size={13} stroke={1.8} />
        </button>
      ) : null}
    </label>
  );
}

function ProviderStatusPill({ status }: { status: ProviderStatus }) {
  if (status === "error") {
    return (
      <span className="rounded-md bg-danger/10 px-2 py-1 text-xs text-danger">Needs review</span>
    );
  }

  if (status === "connected") {
    return (
      <span className="flex items-center gap-1 rounded-md bg-success/10 px-2 py-1 text-xs text-success">
        <IconCheck size={12} stroke={2} />
        Connected
      </span>
    );
  }

  return <span className="rounded-md bg-chip px-2 py-1 text-xs text-fg-muted">Setup</span>;
}

function ModelKindBadge({ model }: { model: ProviderModelConfig }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs",
        model.reasoning ? "bg-chip-strong text-fg-muted" : "bg-chip text-fg-faint",
      )}
    >
      {model.reasoning ? <IconBrain size={11} stroke={1.8} /> : null}
      {model.reasoning ? "thinking" : "standard"}
    </span>
  );
}

function TinyBadge({ children }: { children: string }) {
  return <span className="rounded bg-chip px-1.5 py-0.5 text-2xs text-fg-faint">{children}</span>;
}

type ProviderStatus = "available" | "connected" | "error";
type ModelFilter = "all" | "enabled" | "thinking";

function providerStatus(provider: ModelProviderInfo): ProviderStatus {
  if (provider.error) {
    return "error";
  }
  if (provider.configured || provider.enabledModelCount > 0) {
    return "connected";
  }
  return "available";
}

function providerSummary(provider: ModelProviderInfo): string {
  if (provider.enabledModelCount > 0) {
    return `${provider.enabledModelCount} enabled · ${provider.modelCount} models`;
  }
  if (provider.configured) {
    return `${provider.modelCount} models · key configured`;
  }
  return `${provider.modelCount} models`;
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase();
}

function providerMatchesQuery(provider: ModelProviderInfo, query: string): boolean {
  if (!query) {
    return true;
  }
  const haystack = [
    provider.name,
    provider.id,
    provider.source,
    provider.baseUrl,
    provider.authSource,
    provider.authLabel,
    provider.modelCount.toString(),
    provider.enabledModelCount.toString(),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function compareModelConfig(a: ProviderModelConfig, b: ProviderModelConfig): number {
  if (a.enabled !== b.enabled) {
    return a.enabled ? -1 : 1;
  }
  if (a.reasoning !== b.reasoning) {
    return a.reasoning ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function modelMatchesFilter(model: ProviderModelConfig, filter: ModelFilter): boolean {
  if (filter === "enabled") {
    return model.enabled;
  }
  if (filter === "thinking") {
    return model.reasoning;
  }
  return true;
}

function modelMatchesQuery(model: ProviderModelConfig, query: string): boolean {
  if (!query) {
    return true;
  }
  const haystack = [
    model.name,
    model.id,
    model.contextWindow?.toString(),
    model.maxTokens?.toString(),
    model.thinkingLevel,
    model.thinkingVariant,
    selectedThinkingLabel(model),
    ...(model.thinkingOptions?.flatMap((option) => [option.value, option.label]) ?? []),
    model.reasoning ? "thinking reasoning" : "standard",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}
