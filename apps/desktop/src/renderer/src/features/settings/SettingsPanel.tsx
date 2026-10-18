import { m, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CustomProviderConfig,
  ModelProviderDetail,
  ModelProviderInfo,
  ModelSettingsState,
  ProviderAuthOperationState,
  ProviderConnectionMethod,
  ProviderModelConfig,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import { ContentTransition } from "../../components/ui/ContentTransition";
import { cn } from "../../lib/cn";
import { motionOffset, motionTransition, tween } from "../../lib/motion";
import { useSettingsText } from "../../lib/settingsText";
import { AccountSettingsPanel } from "./sections/account";
import { AppearanceSettingsPanel } from "./sections/appearance";
import { GeneralSettingsPanel } from "./sections/general";
import { McpSettingsPanel } from "./sections/mcp";
import {
  ModelProviderSettingsPanel,
  UnofficialProviderInterstitialDialog,
} from "./sections/model-provider";
import { PersonalizationSettingsPanel } from "./sections/personalization";
import { RulesSettingsPanel } from "./sections/rules";
import { SettingsSidebar } from "./sections/SettingsSidebar";
import { SkillsSettingsPanel } from "./sections/skills";
import type { ModelConfigPatch, SettingsSectionId } from "./settings-types";

export type { HarnessInsightsViewState } from "./sections/harness-insights";
export {
  HarnessInsightsView,
  harnessInsightConfidenceLabel,
  harnessInsightsQueryForWorkspace,
} from "./sections/harness-insights";
export {
  accountMetricLabel,
  accountStatusLabel,
  configuredModelLimits,
  groupConfiguredModelLimits,
  usageMetricText,
} from "./sections/limits";
export {
  canSaveReadOnlyMcpAllowlist,
  confirmedReadOnlyMcpAllowlist,
  type McpFormState,
  McpServerForm,
  normalizeReadOnlyMcpAllowlist,
  toggleReadOnlyMcpTool,
} from "./sections/mcp";
export {
  confirmProjectMemoryRemoval,
  groupProjectMemories,
  ProjectMemoryRow,
  projectMemoryProvisionalExplanation,
  projectMemoryStatusLabel,
  projectMemoryVerificationLabel,
  projectMemoryVerifyVisible,
  safeExternalReferenceUrl,
  setProjectMemoryScopeEnabled,
} from "./sections/project-memory";
export { SettingsSidebar } from "./sections/SettingsSidebar";

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
  /** App sidebar slot: when set, the settings nav renders there instead of its own column. */
  navContainer?: HTMLElement | null | undefined;
};

export function SettingsPanel({
  state,
  onClose,
  onRefresh,
  onRefreshCatalog,
  workspaceCwd,
  workspaces = [],
  initialSection = "model-provider",
  navContainer,
}: SettingsPanelProps) {
  const t = useSettingsText();
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
  const contentScrollRef = useRef<HTMLElement>(null);
  // Provider id awaiting risk acknowledgement before OAuth may begin. Anything
  // other than "antigravity" should never land here in practice — it is the
  // caller's job to gate the user path with the same rule.
  const [riskInterstitialProvider, setRiskInterstitialProvider] = useState<
    ModelProviderInfo | undefined
  >();

  const providers = state?.providers ?? [];
  const connected = providers.filter(
    (provider) => provider.configured || provider.enabledModelCount > 0,
  );
  const popular = providers.filter(
    (provider) => !connected.some((item) => item.id === provider.id),
  );
  const currentProvider = providers.find((provider) => provider.id === selectedProvider);

  const changeSection = (section: SettingsSectionId): void => {
    if (contentScrollRef.current) contentScrollRef.current.scrollTop = 0;
    setActiveSection(section);
  };

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
      changeSection("model-provider");
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
      t("settings.window.removeProviderConfirm", { name: provider.name }),
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
    const confirmed = window.confirm(
      provider.source === "custom"
        ? t("settings.window.disconnectProviderConfirmCustom", { name: provider.name })
        : t("settings.window.disconnectProviderConfirmStandard", { name: provider.name }),
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
      if (methods[0]?.kind === "oauth") {
        void startProviderAuth(provider);
        return;
      }
      setCredentialEditorProvider(provider.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startProviderAuth(
    provider: ModelProviderInfo,
    options: { riskAcknowledged?: true } = {},
  ): Promise<void> {
    // Renderer-side gate: Antigravity must complete the risk acknowledgement
    // interstitial before the preload layer is invoked. The main process
    // enforces the same rule independently.
    if (provider.id === "antigravity" && options.riskAcknowledged !== true) {
      setRiskInterstitialProvider(provider);
      setConnectionProvider(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const operation = await window.modus.model.startProviderAuth({
        provider: provider.id,
        ...(options.riskAcknowledged ? { riskAcknowledged: true } : {}),
      });
      setRiskInterstitialProvider(undefined);
      setConnectionProvider(undefined);
      setAuthOperation(operation);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function acknowledgeRiskAndStartProviderAuth(): void {
    const provider = riskInterstitialProvider;
    if (!provider) {
      return;
    }
    void startProviderAuth(provider, { riskAcknowledged: true });
  }

  function cancelRiskInterstitial(): void {
    // Cancellation MUST NOT touch preload or persist any credential state.
    setRiskInterstitialProvider(undefined);
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
            setError(next.message ?? t("settings.window.providerSignInFailed"));
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
  }, [authOperation?.id, onRefresh, t]);

  return (
    <m.div
      animate={isClosing ? { opacity: 0, y: motionOffset(-3, reduceMotion) } : { opacity: 1, y: 0 }}
      className={cn(
        "flex min-h-0 flex-1 overflow-hidden",
        navContainer === undefined && "surface-app",
      )}
      initial={{ opacity: 0, y: motionOffset(4, reduceMotion) }}
      aria-hidden={isClosing}
      inert={isClosing}
      onAnimationComplete={() => {
        if (isClosing) {
          onClose();
        }
      }}
      style={{ pointerEvents: isClosing ? "none" : "auto" }}
      transition={motionTransition(tween("base"), reduceMotion)}
    >
      {navContainer
        ? createPortal(
            <SettingsSidebar
              activeSection={activeSection}
              embedded
              onBack={closeSettings}
              onQueryChange={setSettingsQuery}
              onSectionChange={changeSection}
              query={settingsQuery}
            />,
            navContainer,
          )
        : null}
      {navContainer === undefined ? (
        <SettingsSidebar
          activeSection={activeSection}
          onBack={closeSettings}
          onQueryChange={setSettingsQuery}
          onSectionChange={changeSection}
          query={settingsQuery}
        />
      ) : null}

      <main
        className="settings-content surface-main scroll-thin min-h-0 min-w-0 flex-1 overflow-y-auto"
        ref={contentScrollRef}
      >
        <ContentTransition
          className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-5 py-6 sm:px-8 sm:py-8"
          transitionKey={activeSection}
        >
          {activeSection === "general" ? (
            <GeneralSettingsPanel cwd={workspaceCwd} workspaces={workspaces} />
          ) : null}
          {activeSection === "account" ? (
            <AccountSettingsPanel modusPlan={state?.modusPlan} modusStatus={state?.modus} />
          ) : null}
          {activeSection === "appearance" ? <AppearanceSettingsPanel /> : null}
          {activeSection === "personalization" ? <PersonalizationSettingsPanel /> : null}
          {activeSection === "skills" ? <SkillsSettingsPanel cwd={workspaceCwd} /> : null}
          {activeSection === "mcp" ? (
            <McpSettingsPanel cwd={workspaceCwd} workspaces={workspaces} />
          ) : null}
          {activeSection === "rules" ? <RulesSettingsPanel cwd={workspaceCwd} /> : null}
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
                changeSection("model-provider");
                onRefresh();
              }}
              onCustomOpen={() => {
                setCustomInitial(undefined);
                setProviderDetailOpen(false);
                setCustomOpen(true);
                changeSection("model-provider");
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
              models={state?.models}
              defaultModel={state?.defaultModel}
              onSetDefaultModel={(modelId) => {
                setError(undefined);
                void window.modus.model
                  .setDefault(modelId)
                  .then(() => onRefresh())
                  .catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : String(err)),
                  );
              }}
              popular={popular}
            />
          ) : null}
        </ContentTransition>
      </main>

      <UnofficialProviderInterstitialDialog
        busy={busy}
        provider={riskInterstitialProvider}
        onCancel={cancelRiskInterstitial}
        onConfirm={acknowledgeRiskAndStartProviderAuth}
      />
    </m.div>
  );
}
