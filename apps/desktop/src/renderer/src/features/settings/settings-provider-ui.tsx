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
