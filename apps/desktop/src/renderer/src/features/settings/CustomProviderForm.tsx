import {
  IconCheck,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconPlugConnected,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { AnimatePresence, m } from "motion/react";
import { type FormEvent, type ReactNode, useState } from "react";
import type { CustomProviderConfig, TestCustomProviderResult } from "../../../../shared/contracts";
import { CollapsibleMotion } from "../../components/ui/CollapsibleMotion";
import { WorkingText } from "../../components/ui/WorkingText";
import { cn } from "../../lib/cn";
import { tween } from "../../lib/motion";
import { type SettingsTextFn, settingsTextFor, useSettingsText } from "../../lib/settingsText";
import { formatUiNumber, uiIntlLocale } from "../../lib/uiIntl";
import {
  Disclosure,
  Field,
  KeyValueEditor,
  SelectField,
  SwitchControl,
  ToggleField,
} from "./form-controls";
import {
  type CustomModelRow,
  createCustomModelRow,
  createKeyValueRow,
  type KeyValueRow,
  keyValueRowsToRecord,
  MODEL_API_OPTIONS,
  type ModelThinkingFormat,
  modelConfigToRow,
  PROTOCOLS,
  type ProtocolValue,
  protocolFor,
  recordToKeyValueRows,
  rowProtocol,
  rowToModelInput,
  slugifyProviderId,
  THINKING_FORMAT_OPTIONS,
  THINKING_PRESET_OPTIONS,
  type ThinkingPreset,
} from "./provider-form-mapping";

/**
 * Custom provider editor — protocol-first, flat, single column.
 *
 * The protocol choice (OpenAI / Responses / Anthropic / Gemini) is the primary
 * decision: it drives endpoint placeholders, key semantics (bearer vs
 * x-api-key), and which thinking controls each model exposes. Models are
 * compact rows whose advanced options stay folded until needed, and the footer
 * carries a live "Test connection" probe that runs the exact pi-ai driver a
 * chat would use — endpoint, key, protocol and thinking config are validated
 * before anything is saved.
 */

const DEFAULT_URL_PLACEHOLDER = "https://api.example.com/v1";
const API_KEY_PLACEHOLDER = "sk-...";

function getApiKeyDescription(editing: boolean, api: string, t: SettingsTextFn): string {
  const base = editing
    ? t("settings.customProvider.apiKeyEditingHint")
    : t("settings.customProvider.apiKeyNewHint");
  const keyHintKey = protocolFor(api)?.keyHintKey;
  return keyHintKey ? `${base} ${t(keyHintKey)}` : base;
}

/* ── Component ──────────────────────────────────────────────────────────── */

export function CustomProviderForm({
  initial,
  onCancel,
  onComplete,
  onError,
}: {
  initial?: CustomProviderConfig | undefined;
  onCancel(): void;
  onComplete(provider: string): void;
  onError(message: string | undefined): void;
}) {
  const t = useSettingsText();
  const editing = Boolean(initial);
  const initialCompat = (initial?.compat ?? {}) as Record<string, unknown>;
  const [rows, setRows] = useState<CustomModelRow[]>(() =>
    initial && initial.models.length > 0
      ? initial.models.map(modelConfigToRow)
      : [createCustomModelRow()],
  );
  const [provider, setProvider] = useState(initial?.provider ?? "");
  const [providerTouched, setProviderTouched] = useState(editing);
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [api, setApi] = useState(initial?.api ?? "openai-completions");
  const [authHeader, setAuthHeader] = useState(initial?.authHeader ?? true);
  const [authHeaderTouched, setAuthHeaderTouched] = useState(editing);
  const [providerHeaders, setProviderHeaders] = useState<KeyValueRow[]>(() =>
    recordToKeyValueRows(initial?.headers),
  );
  const [supportsDeveloperRole, setSupportsDeveloperRole] = useState(
    Boolean(initialCompat.supportsDeveloperRole),
  );
  const [supportsReasoningEffort, setSupportsReasoningEffort] = useState(
    Boolean(initialCompat.supportsReasoningEffort),
  );
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    (TestCustomProviderResult & { snapshot: string }) | undefined
  >();

  const protocol = protocolFor(api);
  const isOpenAiFamily = api === "openai-completions" || api === "openai-responses";
  const testTarget = rows.find((row) => row.id.trim());
  // Anything that changes the request invalidates a previous probe result.
  const testSnapshot = JSON.stringify([
    api,
    baseUrl,
    apiKey,
    authHeader,
    keyValueRowsToRecord(providerHeaders) ?? {},
    testTarget
      ? [
          testTarget.id,
          testTarget.api,
          testTarget.baseUrl,
          testTarget.reasoning,
          testTarget.thinkingPreset,
          testTarget.adaptiveThinking,
          testTarget.allowEmptySignature,
          testTarget.thinkingFormat,
        ]
      : [],
  ]);
  const visibleTestResult = testResult?.snapshot === testSnapshot ? testResult : undefined;

  function changeName(next: string): void {
    setName(next);
    if (!providerTouched && !editing) {
      setProvider(slugifyProviderId(next));
    }
  }

  function changeProtocol(next: ProtocolValue): void {
    setApi(next);
    if (!authHeaderTouched) {
      setAuthHeader(protocolFor(next)?.bearerByDefault ?? true);
    }
  }

  function updateRow(rowId: string, patch: Partial<CustomModelRow>): void {
    setRows((current) => current.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)));
  }

  function removeRow(rowId: string): void {
    setRows((current) =>
      current.length === 1 ? current : current.filter((row) => row.rowId !== rowId),
    );
  }

  function updateProviderHeader(rowId: string, patch: Partial<KeyValueRow>): void {
    setProviderHeaders((current) =>
      current.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)),
    );
  }

  function reportError(message: string | undefined): void {
    setFormError(message);
    onError(message);
  }

  async function runConnectionTest(): Promise<void> {
    if (!testTarget || testing) {
      return;
    }
    setTesting(true);
    setTestResult(undefined);
    reportError(undefined);
    try {
      const model = rowToModelInput(testTarget, api);
      const result = await window.modus.model.testCustomProvider({
        ...(editing && initial ? { provider: initial.provider } : {}),
        baseUrl,
        api,
        apiKey,
        authHeader,
        ...(keyValueRowsToRecord(providerHeaders)
          ? { headers: keyValueRowsToRecord(providerHeaders) }
          : {}),
        model: {
          id: model.id,
          ...(model.api !== undefined ? { api: model.api } : {}),
          ...(model.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
          ...(model.headers !== undefined ? { headers: model.headers } : {}),
          ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
          ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
          ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
          ...(model.compatibility !== undefined ? { compatibility: model.compatibility } : {}),
          ...(model.thinkingLevelMap !== undefined
            ? { thinkingLevelMap: model.thinkingLevelMap }
            : {}),
        },
      });
      setTestResult({ ...result, snapshot: testSnapshot });
    } catch (error) {
      setTestResult({
        ok: false,
        latencyMs: 0,
        message: error instanceof Error ? error.message : String(error),
        sawThinking: false,
        snapshot: testSnapshot,
      });
    } finally {
      setTesting(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    reportError(undefined);
    try {
      const modelInputs = rows.map((row) => rowToModelInput(row, api, t));
      await window.modus.model.upsertCustomProvider({
        provider,
        name,
        baseUrl,
        apiKey,
        api,
        authHeader,
        headers: keyValueRowsToRecord(providerHeaders),
        compatibility: isOpenAiFamily ? { supportsDeveloperRole, supportsReasoningEffort } : {},
        models: modelInputs,
      });
      onComplete(provider.trim().toLowerCase());
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const missingReason = !name.trim()
    ? t("settings.customProvider.missingName")
    : !baseUrl.trim()
      ? t("settings.customProvider.missingBaseUrl")
      : !rows.some((row) => row.id.trim())
        ? t("settings.customProvider.missingModelId")
        : undefined;

  return (
    <form
      className="mx-auto flex w-full max-w-[640px] flex-col gap-8 pt-1"
      onSubmit={(event) => void submit(event)}
    >
      <header>
        <h2 className="text-md text-fg">
          {editing
            ? t("settings.customProvider.editTitle", {
                name: initial?.name || initial?.provider || "",
              })
            : t("settings.customProvider.connectTitle")}
        </h2>
        <p className="mt-1 text-xs leading-5 text-fg-muted">
          {/* One endpoint, any protocol */}
          {t("settings.customProvider.description")}
        </p>
      </header>

      <FormSection title={t("settings.customProvider.protocol")}>
        <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <legend className="sr-only">{t("settings.customProvider.protocolLegend")}</legend>
          {PROTOCOLS.map((option) => {
            const selected = api === option.value;
            return (
              <button
                aria-pressed={selected}
                className={cn(
                  "flex h-9 items-center justify-center gap-1.5 rounded-md border text-sm transition-colors",
                  selected
                    ? "border-fg-subtle bg-active text-fg"
                    : "border-hairline text-fg-subtle hover:bg-hover hover:text-fg",
                )}
                key={option.value}
                onClick={() => changeProtocol(option.value)}
                type="button"
              >
                {selected ? <IconCheck size={13} stroke={2.2} /> : null}
                {option.label}
              </button>
            );
          })}
        </fieldset>
        <p className="text-xs leading-5 text-fg-muted">
          {protocol
            ? t(protocol.hintKey)
            : t("settings.customProvider.protocolHintCustom", { api })}
        </p>
      </FormSection>

      <FormSection title={t("settings.customProvider.connection")}>
        <Field
          description={t("settings.customProvider.displayNameDescription")}
          label={t("settings.customProvider.displayName")}
          onChange={changeName}
          placeholder={t("settings.customProvider.displayNamePlaceholder")}
          value={name}
        />
        <Field
          description={
            protocol ? t(protocol.urlHintKey) : t("settings.customProvider.urlHintDefault")
          }
          label={t("settings.customProvider.baseUrl")}
          mono
          onChange={setBaseUrl}
          placeholder={protocol?.urlPlaceholder ?? DEFAULT_URL_PLACEHOLDER}
          type="url"
          value={baseUrl}
        />
        <Field
          autoComplete="off"
          description={getApiKeyDescription(editing, api, t)}
          label={t("settings.customProvider.apiKey")}
          onChange={setApiKey}
          placeholder={
            editing ? t("settings.customProvider.apiKeyPlaceholderUnchanged") : API_KEY_PLACEHOLDER
          }
          type="password"
          value={apiKey}
        />

        <Disclosure label={t("settings.customProvider.advancedConnection")}>
          <Field
            description={
              editing
                ? t("settings.customProvider.providerIdEditingDescription")
                : t("settings.customProvider.providerIdDescription")
            }
            label={t("settings.customProvider.providerId")}
            mono
            onChange={(value) => {
              setProviderTouched(true);
              setProvider(value);
            }}
            placeholder={t("settings.customProvider.providerIdPlaceholder")}
            value={provider}
          />
          <ToggleField
            checked={authHeader}
            label={t("settings.customProvider.authHeader")}
            onChange={(value) => {
              setAuthHeaderTouched(true);
              setAuthHeader(value);
            }}
          />
          {isOpenAiFamily ? (
            <>
              <ToggleField
                checked={supportsDeveloperRole}
                label={t("settings.customProvider.developerRole")}
                onChange={setSupportsDeveloperRole}
              />
              <ToggleField
                checked={supportsReasoningEffort}
                label={t("settings.customProvider.reasoningEffort")}
                onChange={setSupportsReasoningEffort}
              />
            </>
          ) : null}
          <KeyValueEditor
            addLabel={t("settings.customProvider.addHeader")}
            emptyLabel={t("settings.customProvider.providerHeadersEmpty")}
            keyPlaceholder={t("settings.customProvider.headerKeyPlaceholder")}
            onAdd={() => setProviderHeaders((current) => [...current, createKeyValueRow()])}
            onChange={updateProviderHeader}
            onRemove={(rowId) =>
              setProviderHeaders((current) => current.filter((row) => row.rowId !== rowId))
            }
            rows={providerHeaders}
            title={t("settings.customProvider.providerHeadersTitle")}
            valuePlaceholder={t("settings.customProvider.headerValuePlaceholder")}
          />
        </Disclosure>
      </FormSection>

      <FormSection
        action={
          <button
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
            onClick={() => setRows((current) => [...current, createCustomModelRow()])}
            type="button"
          >
            <IconPlus size={13} stroke={1.8} />
            {t("settings.customProvider.addModel")}
          </button>
        }
        title={t("settings.customProvider.modelsSection")}
      >
        <div className="grid gap-2.5">
          <AnimatePresence initial={false}>
            {rows.map((row) => (
              <ModelRowEditor
                key={row.rowId}
                onChange={(patch) => updateRow(row.rowId, patch)}
                onRemove={() => removeRow(row.rowId)}
                protocol={rowProtocol(row, api)}
                removable={rows.length > 1}
                row={row}
              />
            ))}
          </AnimatePresence>
        </div>
      </FormSection>

      <div className="sticky bottom-0 z-10 bg-canvas pt-3 pb-1">
        {formError ? (
          <p className="mb-2 text-xs leading-5 text-danger" title={formError}>
            {formError}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <button
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-hairline px-3 text-sm text-fg-subtle transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            disabled={testing || !testTarget || !baseUrl.trim()}
            onClick={() => void runConnectionTest()}
            title={
              testTarget
                ? t("settings.customProvider.testButtonTitleReady")
                : t("settings.customProvider.testButtonTitleMissingModel")
            }
            type="button"
          >
            <IconPlugConnected size={13} stroke={1.8} />
            {testing ? (
              <WorkingText>{t("settings.customProvider.testing")}</WorkingText>
            ) : (
              t("settings.customProvider.testConnection")
            )}
          </button>
          <ConnectionTestStatus result={visibleTestResult} testing={testing} />
          <div className="flex-1" />
          <button
            className="h-9 shrink-0 rounded-md px-3 text-sm text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
            onClick={onCancel}
            type="button"
          >
            {t("settings.customProvider.cancel")}
          </button>
          <button
            className="flex h-9 shrink-0 items-center gap-2 rounded-md bg-accent px-3.5 text-sm text-on-accent transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || Boolean(missingReason)}
            title={missingReason}
            type="submit"
          >
            {busy ? (
              <WorkingText className="text-on-accent">
                {t("settings.customProvider.saving")}
              </WorkingText>
            ) : (
              t("settings.customProvider.saveProvider")
            )}
          </button>
        </div>
      </div>
    </form>
  );
}

function ConnectionTestStatus({
  result,
  testing,
}: {
  result: TestCustomProviderResult | undefined;
  testing: boolean;
}) {
  const t = useSettingsText();
  if (testing) {
    return (
      <span className="text-xs text-fg-muted">{t("settings.customProvider.testContacting")}</span>
    );
  }
  if (!result) {
    return null;
  }
  if (!result.ok) {
    return (
      <span
        className="flex min-w-0 items-center gap-1.5 text-xs text-danger"
        title={result.message}
      >
        <IconCircleX className="shrink-0" size={14} stroke={1.8} />
        <span className="min-w-0 truncate">{result.message}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-success" title={result.message}>
      <IconCircleCheck className="shrink-0" size={14} stroke={1.8} />
      <span className="min-w-0 truncate">
        {result.sawThinking
          ? t("settings.customProvider.testConnectedThinking", {
              latency: formatUiNumber(result.latencyMs, undefined, uiIntlLocale(t.locale)),
            })
          : t("settings.customProvider.testConnected", {
              latency: formatUiNumber(result.latencyMs, undefined, uiIntlLocale(t.locale)),
            })}
      </span>
    </span>
  );
}

function FormSection({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="grid gap-4 pt-6 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs text-fg-subtle">{title}</h3>
        {action ?? null}
      </div>
      {children}
    </section>
  );
}

/* ── Model row ──────────────────────────────────────────────────────────── */

function ModelRowEditor({
  row,
  protocol,
  removable,
  onChange,
  onRemove,
}: {
  row: CustomModelRow;
  /** Effective wire protocol for this model (row override beats provider). */
  protocol: string;
  removable: boolean;
  onChange(patch: Partial<CustomModelRow>): void;
  onRemove(): void;
}) {
  const t = useSettingsText();
  const [open, setOpen] = useState(false);
  const isAnthropic = protocol === "anthropic-messages";
  const isOpenAiCompletions = protocol === "openai-completions";

  function updateHeader(rowId: string, patch: Partial<KeyValueRow>): void {
    onChange({
      headers: row.headers.map((header) =>
        header.rowId === rowId ? { ...header, ...patch } : header,
      ),
    });
  }

  const summary = [
    row.reasoning
      ? t("settings.customProvider.summaryThinking", {
          summary: optionSummary(row.thinkingPreset, isAnthropic, t),
        })
      : t("settings.customProvider.summaryNoThinking"),
    row.imageInput ? t("settings.customProvider.summaryImageInput") : undefined,
    row.api.trim() ? row.api.trim() : undefined,
  ]
    .filter(Boolean)
    .join("  ·  ");

  return (
    <m.div
      animate={{ opacity: 1, y: 0 }}
      className="settings-group"
      exit={{ opacity: 0, y: -6 }}
      initial={{ opacity: 0, y: 6 }}
      layout
      transition={tween("base")}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-2 px-3 py-2.5">
        <input
          aria-label={t("settings.customProvider.modelId")}
          className="h-9 min-w-0 rounded-md border border-hairline bg-canvas px-3 font-mono text-xs text-fg outline-none placeholder:text-fg-faint transition-colors hover:border-hairline-strong focus:border-focus-ring/60 focus:ring-2 focus:ring-focus-ring"
          onChange={(event) => onChange({ id: event.target.value })}
          placeholder={t("settings.customProvider.modelIdPlaceholder")}
          value={row.id}
        />
        <input
          aria-label={t("settings.customProvider.modelDisplayName")}
          className="h-9 min-w-0 rounded-md border border-hairline bg-canvas px-3 text-sm text-fg outline-none placeholder:text-fg-faint transition-colors hover:border-hairline-strong focus:border-focus-ring/60 focus:ring-2 focus:ring-focus-ring"
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder={t("settings.customProvider.modelDisplayNamePlaceholder")}
          value={row.name}
        />
        <span className="flex shrink-0 items-center gap-2 pl-1 text-xs text-fg-subtle">
          {t("settings.customProvider.modelThinking")}
          <SwitchControl
            ariaLabel={t("settings.customProvider.modelSupportsThinking", {
              name: row.id.trim() || t("settings.customProvider.modelDefaultName"),
            })}
            checked={row.reasoning}
            onCheckedChange={(value) => onChange({ reasoning: value })}
          />
        </span>
        <button
          aria-label={t("settings.customProvider.removeModel")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-35"
          disabled={!removable}
          onClick={onRemove}
          type="button"
        >
          <IconTrash size={14} stroke={1.7} />
        </button>
      </div>

      <button
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-fg-faint transition-colors hover:text-fg-subtle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <IconChevronRight
          className="disclosure-chevron shrink-0 duration-(--motion-duration-base)"
          data-open={open ? "" : undefined}
          size={12}
          stroke={1.8}
        />
        {t("settings.customProvider.options")}
        <span className="min-w-0 truncate">{summary ? `— ${summary}` : ""}</span>
      </button>

      <CollapsibleMotion open={open} preset="default">
        <div className="grid gap-6 px-3.5 pt-4 pb-4">
          {row.reasoning ? (
            <OptionGroup
              hint={
                isAnthropic
                  ? t("settings.customProvider.thinkingHintAnthropic")
                  : t("settings.customProvider.thinkingHintOther")
              }
              title={t("settings.customProvider.thinkingSection")}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField
                  label={t("settings.customProvider.thinkingLevels")}
                  onChange={(value) => onChange({ thinkingPreset: value as ThinkingPreset })}
                  options={THINKING_PRESET_OPTIONS.map((option) => ({
                    label: t(option.label),
                    value: option.value,
                  }))}
                  value={row.thinkingPreset}
                />
                {isOpenAiCompletions ? (
                  <SelectField
                    label={t("settings.customProvider.requestFormat")}
                    onChange={(value) => onChange({ thinkingFormat: value as ModelThinkingFormat })}
                    options={[
                      { label: t("settings.customProvider.formatOpenaiDefault"), value: "none" },
                      ...THINKING_FORMAT_OPTIONS.map((option) => ({
                        label: t(option.label),
                        value: option.value,
                      })),
                    ]}
                    value={row.thinkingFormat}
                  />
                ) : null}
              </div>
              {row.thinkingPreset === "custom" ? (
                <div className="grid gap-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field
                      label={t("settings.customProvider.thinkingLevelOff")}
                      mono
                      onChange={(value) => onChange({ thinkingOff: value })}
                      placeholder={t("settings.customProvider.placeholderDefault")}
                      value={row.thinkingOff}
                    />
                    <Field
                      label={t("settings.customProvider.thinkingLevelMinimal")}
                      mono
                      onChange={(value) => onChange({ thinkingMinimal: value })}
                      placeholder={t("settings.customProvider.placeholderHidden")}
                      value={row.thinkingMinimal}
                    />
                    <Field
                      label={t("settings.customProvider.thinkingLevelLow")}
                      mono
                      onChange={(value) => onChange({ thinkingLow: value })}
                      placeholder={t("settings.customProvider.placeholderHidden")}
                      value={row.thinkingLow}
                    />
                    <Field
                      label={t("settings.customProvider.thinkingLevelMedium")}
                      mono
                      onChange={(value) => onChange({ thinkingMedium: value })}
                      placeholder={t("settings.customProvider.placeholderHidden")}
                      value={row.thinkingMedium}
                    />
                    <Field
                      label={t("settings.customProvider.thinkingLevelHigh")}
                      mono
                      onChange={(value) => onChange({ thinkingHigh: value })}
                      placeholder={t("settings.customProvider.placeholderHidden")}
                      value={row.thinkingHigh}
                    />
                    <Field
                      label={t("settings.customProvider.thinkingLevelExtraHigh")}
                      mono
                      onChange={(value) => onChange({ thinkingXHigh: value })}
                      placeholder={t("settings.customProvider.placeholderHidden")}
                      value={row.thinkingXHigh}
                    />
                  </div>
                  <p className="text-xs leading-5 text-fg-muted">
                    {/* The value in each box is sent to the provider */}
                    {t("settings.customProvider.customLevelsHint")}
                  </p>
                </div>
              ) : null}
              {isAnthropic ? (
                <div className="grid gap-1">
                  <ToggleField
                    checked={row.adaptiveThinking}
                    label={t("settings.customProvider.adaptiveThinking")}
                    onChange={(value) => onChange({ adaptiveThinking: value })}
                  />
                  <ToggleField
                    checked={row.allowEmptySignature}
                    label={t("settings.customProvider.allowUnsignedThinking")}
                    onChange={(value) => onChange({ allowEmptySignature: value })}
                  />
                </div>
              ) : null}
              {isOpenAiCompletions ? (
                <ToggleField
                  checked={row.supportsUsageInStreaming}
                  label={t("settings.customProvider.streamingUsage")}
                  onChange={(value) => onChange({ supportsUsageInStreaming: value })}
                />
              ) : null}
            </OptionGroup>
          ) : null}

          <OptionGroup
            hint={t("settings.customProvider.capabilitiesLimitsHint")}
            title={t("settings.customProvider.capabilitiesLimits")}
          >
            <ToggleField
              checked={row.imageInput}
              label={t("settings.customProvider.imageInput")}
              onChange={(value) => onChange({ imageInput: value })}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t("settings.customProvider.contextWindow")}
                onChange={(value) => onChange({ contextWindow: value })}
                placeholder="128000"
                value={row.contextWindow}
              />
              <Field
                label={t("settings.customProvider.maxOutputTokens")}
                onChange={(value) => onChange({ maxTokens: value })}
                placeholder="16384"
                value={row.maxTokens}
              />
            </div>
          </OptionGroup>

          <OptionGroup
            hint={t("settings.customProvider.endpointOverrideHint")}
            title={t("settings.customProvider.endpointOverride")}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label={t("settings.customProvider.protocol")}
                onChange={(value) => onChange({ api: value })}
                options={MODEL_API_OPTIONS.map((option) => ({
                  label: t(option.label),
                  value: option.value,
                }))}
                value={
                  (MODEL_API_OPTIONS.some((option) => option.value === row.api)
                    ? row.api
                    : "") as (typeof MODEL_API_OPTIONS)[number]["value"]
                }
              />
              <Field
                label={t("settings.customProvider.baseUrl")}
                mono
                onChange={(value) => onChange({ baseUrl: value })}
                placeholder={t("settings.customProvider.placeholderProviderDefault")}
                type="url"
                value={row.baseUrl}
              />
            </div>
          </OptionGroup>

          <OptionGroup
            hint={t("settings.customProvider.pricingHint")}
            title={t("settings.customProvider.pricing")}
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field
                label={t("settings.customProvider.costInput")}
                onChange={(value) => onChange({ costInput: value })}
                placeholder="0"
                value={row.costInput}
              />
              <Field
                label={t("settings.customProvider.costOutput")}
                onChange={(value) => onChange({ costOutput: value })}
                placeholder="0"
                value={row.costOutput}
              />
              <Field
                label={t("settings.customProvider.costCacheRead")}
                onChange={(value) => onChange({ costCacheRead: value })}
                placeholder="0"
                value={row.costCacheRead}
              />
              <Field
                label={t("settings.customProvider.costCacheWrite")}
                onChange={(value) => onChange({ costCacheWrite: value })}
                placeholder="0"
                value={row.costCacheWrite}
              />
            </div>
          </OptionGroup>

          <KeyValueEditor
            addLabel={t("settings.customProvider.addHeader")}
            emptyLabel={t("settings.customProvider.modelHeadersEmpty")}
            keyPlaceholder={t("settings.customProvider.headerKeyPlaceholder")}
            onAdd={() => onChange({ headers: [...row.headers, createKeyValueRow()] })}
            onChange={updateHeader}
            onRemove={(rowId) =>
              onChange({ headers: row.headers.filter((header) => header.rowId !== rowId) })
            }
            rows={row.headers}
            title={t("settings.customProvider.modelHeadersTitle")}
            valuePlaceholder={t("settings.customProvider.headerValuePlaceholder")}
          />
        </div>
      </CollapsibleMotion>
    </m.div>
  );
}

function optionSummary(
  preset: ThinkingPreset,
  isAnthropic: boolean,
  t: SettingsTextFn = settingsTextFor(),
): string {
  if (preset === "default") {
    return isAnthropic
      ? t("settings.customProvider.summaryProviderDefault")
      : t("settings.customProvider.summaryProviderDefault");
  }
  if (preset === "claude") {
    return t("settings.customProvider.summaryClaudeEffort");
  }
  if (preset === "openai") {
    return t("settings.customProvider.summaryOpenaiEffort");
  }
  return t("settings.customProvider.summaryCustomLevels");
}

function OptionGroup({
  children,
  hint,
  title,
}: {
  children: ReactNode;
  hint: string;
  title: string;
}) {
  return (
    <section className="grid gap-3">
      <div>
        <h4 className="text-xs text-fg-muted">{title}</h4>
        <p className="mt-0.5 text-xs leading-5 text-fg-muted">{hint}</p>
      </div>
      {children}
    </section>
  );
}
