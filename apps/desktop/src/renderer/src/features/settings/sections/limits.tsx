import { IconRefresh } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import type {
  ModelInfo,
  ProviderAccountUsage,
  ProviderLimitsState,
  ProviderUsageMessage,
  ProviderUsageMetric,
  ProviderUsageStatus,
} from "../../../../../shared/contracts";
import { EmptyState } from "../../../components/ui/Panel";
import { cn } from "../../../lib/cn";
import { formatClock } from "../../../lib/formatClock";
import { SwitchControl } from "../form-controls";
import { SettingsPageHeader, SettingsRow, SettingsSection } from "../settings-layout";

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

export function LimitsSettingsPanel({ models }: { models: ModelInfo[] }) {
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
