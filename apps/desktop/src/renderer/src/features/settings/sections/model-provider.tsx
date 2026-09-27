import { Dialog } from "@base-ui/react/dialog";
import {
  IconArrowLeft,
  IconChevronRight,
  IconCopy,
  IconKey,
  IconPlugConnected,
  IconPlus,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { AnimatePresence, m } from "motion/react";
import { type ReactNode, useMemo, useState } from "react";
import type {
  CustomProviderConfig,
  ModelProviderDetail,
  ModelProviderInfo,
  ProviderAuthOperationState,
  ProviderConnectionMethod,
  ProviderModelConfig,
} from "../../../../../shared/contracts";
import { EmptyState } from "../../../components/ui/Panel";
import { ShinyText } from "../../../components/ui/ShinyText";
import { Tooltip } from "../../../components/ui/Tooltip";
import { CustomProviderForm } from "../CustomProviderForm";
import { ProviderLogo } from "../ProviderLogo";
import { ReadOnlyPill, SettingsPageHeader } from "../settings-layout";
import {
  normalizeSearchValue,
  ProviderCatalogRow,
  ProviderDetail,
  ProviderDetailLoading,
  ProviderGroup,
  providerMatchesQuery,
  SearchField,
} from "../settings-provider-ui";
import { UnofficialProviderRiskInterstitial } from "../UnofficialProviderNotice";

type ModelConfigPatch = {
  thinkingVariant?: string;
  contextWindow?: number;
  maxTokens?: number;
};

export function ModelProviderSettingsPanel({
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

/**
 * Risk acknowledgement interstitial that lives inside the provider dialog
 * shell. Unchecked by default; cancellation closes without invoking auth or
 * persisting credentials. Confirm calls the parent, which forwards
 * `riskAcknowledged: true` to preload.
 */
export function UnofficialProviderInterstitialDialog({
  busy,
  provider,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  provider: ModelProviderInfo | undefined;
  onCancel(): void;
  onConfirm(): void;
}) {
  const [checked, setChecked] = useState(false);
  // The dialog owner stays mounted across cancel/reopen, so the local
  // `checked` state would otherwise survive a dismissal and re-expose a
  // stale, enabled primary action. Reset synchronously during render
  // whenever the provider identity changes (including the undefined →
  // defined transition that represents a fresh open). The setState-during-
  // render pattern avoids any frame where the user could see the stale
  // checked state, because React discards the in-flight render and commits
  // the reset value before paint.
  const [previousProviderId, setPreviousProviderId] = useState<string | undefined>(
    provider?.id,
  );
  if (provider?.id !== previousProviderId) {
    setPreviousProviderId(provider?.id);
    setChecked(false);
  }
  if (!provider) {
    return null;
  }
  // Reset the checkbox every time the dialog re-opens for a different provider
  // so the user must always explicitly opt in.
  return (
    <ProviderConfigDialogShell
      closeLabel="Cancel Antigravity sign-in"
      description="Acknowledge the unofficial-endpoints risk before Antigravity OAuth begins."
      open
      title={`Acknowledge ${provider.name} risk`}
      onClose={onCancel}
    >
      <div className="pt-5">
        <div className="flex items-center gap-3">
          <ProviderLogo framed={false} name={provider.name} provider={provider.id} size="lg" />
          <div>
            <h3 className="text-md font-normal text-fg">{provider.name}</h3>
            <p className="mt-1 text-xs text-fg-faint">
              Unofficial provider — acknowledgement required before OAuth.
            </p>
          </div>
        </div>
        <div className="mt-7">
          <UnofficialProviderRiskInterstitial
            busy={busy}
            checked={checked}
            onChange={setChecked}
            onCancel={onCancel}
            onConfirm={onConfirm}
          />
        </div>
      </div>
    </ProviderConfigDialogShell>
  );
}
