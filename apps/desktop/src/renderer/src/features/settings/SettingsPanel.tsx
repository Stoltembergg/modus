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
