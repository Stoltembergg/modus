import { IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FailureBlacklistEntry } from "../../../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../../../shared/contracts";
import { SettingsPageHeader } from "../settings-layout";

export function failureBlacklistAvailable(workspaceId: string | undefined): boolean {
  return Boolean(workspaceId && workspaceId !== CHATS_WORKSPACE_ID);
}

/** Count active entries that share a strategy_code (clear scope). */
export function countEntriesForStrategy(
  entries: readonly FailureBlacklistEntry[],
  strategyCode: string,
): number {
  return entries.filter((entry) => entry.strategyCode === strategyCode).length;
}

/** Button label making multi-entry clear scope explicit. */
export function formatClearStrategyLabel(count: number): string {
  return count === 1 ? "Clear strategy (1 entry)" : `Clear strategy (${count} entries)`;
}

/** Confirm copy naming strategy + number of entries that will be cleared. */
export function buildClearStrategyConfirmMessage(strategyCode: string, count: number): string {
  const entryWord = count === 1 ? "entry" : "entries";
  return `Clear strategy "${strategyCode}"? This will clear ${count} active ${entryWord} with that strategy code.`;
}

/** Human-readable remaining TTL for an active soft-blacklist entry. */
export function formatBlacklistTtlRemaining(expiresAt: string, now: Date = new Date()): string {
  const remainingMs = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(remainingMs)) return "Expiry unknown";
  if (remainingMs <= 0) return "Expired";
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days >= 1) {
    return hours > 0 ? `${days}d ${hours}h remaining` : `${days}d remaining`;
  }
  if (hours >= 1) {
    return minutes > 0 ? `${hours}h ${minutes}m remaining` : `${hours}h remaining`;
  }
  return `${Math.max(1, minutes)}m remaining`;
}

export function formatBlacklistExpiryDate(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatBlacklistSeenDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export type FailureBlacklistViewState =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; entries: FailureBlacklistEntry[] };

export function FailureBlacklistView({
  onRefresh,
  onClearAll,
  onClearStrategy,
  state,
  clearing = false,
  clearError = null,
}: {
  onRefresh(): void;
  onClearAll?(): void;
  onClearStrategy?(strategyCode: string): void;
  state: FailureBlacklistViewState;
  clearing?: boolean;
  clearError?: string | null;
}) {
  const actionsDisabled = clearing || state.status === "loading";

  return (
    <>
      <SettingsPageHeader
        actions={
          state.status !== "unavailable" ? (
            <>
              {state.status === "loaded" && state.entries.length > 0 && onClearAll ? (
                <button
                  className="flex h-8 items-center gap-1.5 rounded-md border border-hairline-soft px-2.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-wait disabled:opacity-50"
                  disabled={actionsDisabled}
                  onClick={onClearAll}
                  type="button"
                >
                  Clear all
                </button>
              ) : null}
              <button
                aria-label="Refresh failure blacklist"
                className="flex h-8 items-center gap-1.5 rounded-md border border-hairline-soft px-2.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-wait disabled:opacity-50"
                disabled={actionsDisabled}
                onClick={onRefresh}
                type="button"
              >
                <IconRefresh
                  aria-hidden
                  className={
                    state.status === "loading" || clearing
                      ? "animate-spin motion-reduce:animate-none"
                      : ""
                  }
                  size={14}
                />
                Refresh
              </button>
            </>
          ) : undefined
        }
        description="Soft-discouraged strategies for this workspace. Entries expire automatically and never permanently block a changed revision."
        title="Failure blacklist"
      />
      {clearError ? (
        <div
          className="mb-4 flex flex-col items-start gap-2 rounded-xl border border-danger/20 bg-danger/5 p-4"
          role="alert"
        >
          <p className="text-sm text-fg">{clearError}</p>
        </div>
      ) : null}
      {state.status === "unavailable" ? (
        <div className="rounded-xl border border-hairline-soft bg-panel p-5 text-sm text-fg-muted">
          Choose a workspace to manage the failure blacklist.
        </div>
      ) : state.status === "loading" ? (
        <div
          aria-live="polite"
          className="flex min-h-28 items-center justify-center gap-2 rounded-xl border border-hairline-soft bg-panel text-sm text-fg-muted"
          role="status"
        >
          <IconRefresh aria-hidden className="animate-spin motion-reduce:animate-none" size={16} />
          Loading failure blacklist…
        </div>
      ) : state.status === "error" ? (
        <div
          className="flex flex-col items-start gap-3 rounded-xl border border-danger/20 bg-danger/5 p-5"
          role="alert"
        >
          <p className="text-sm text-fg">Failure blacklist could not be loaded.</p>
          <button
            className="h-8 rounded-md border border-hairline-soft px-3 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-wait disabled:opacity-50"
            disabled={clearing}
            onClick={onRefresh}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : (
        <FailureBlacklistResults
          clearing={clearing}
          entries={state.entries}
          onClearStrategy={(strategyCode) => void onClearStrategy?.(strategyCode)}
        />
      )}
    </>
  );
}

function FailureBlacklistResults({
  entries,
  onClearStrategy,
  clearing,
}: {
  entries: FailureBlacklistEntry[];
  onClearStrategy?(strategyCode: string): void;
  clearing: boolean;
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-hairline-soft bg-panel p-4">
        <p className="font-medium text-fg text-sm">Soft discourage only</p>
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
          Active entries bias Meta Controller away from repeating a failed strategy signature. They
          are not a hard permanent block — TTL expiry, clear, or a changed project revision allows
          reevaluation.
        </p>
        <p className="mt-2 text-xs text-fg-faint">
          {entries.length} active {entries.length === 1 ? "entry" : "entries"}
        </p>
      </section>

      {entries.length === 0 ? (
        <section className="rounded-xl border border-hairline-soft bg-panel p-5" role="status">
          <h3 className="font-medium text-fg text-sm">No active soft-blacklist entries</h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            Repeated failure signatures are discouraged here when Failure Intelligence records them.
            Cleared and expired entries do not appear.
          </p>
        </section>
      ) : (
        <div className="grid min-w-0 gap-3">
          {entries.map((entry) => (
            <FailureBlacklistRow
              clearing={clearing}
              entry={entry}
              key={entry.id}
              strategyEntryCount={countEntriesForStrategy(entries, entry.strategyCode)}
              {...(onClearStrategy ? { onClearStrategy } : {})}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FailureBlacklistRow({
  entry,
  onClearStrategy,
  strategyEntryCount,
  clearing,
}: {
  entry: FailureBlacklistEntry;
  onClearStrategy?(strategyCode: string): void;
  strategyEntryCount: number;
  clearing: boolean;
}) {
  const clearLabel = formatClearStrategyLabel(strategyEntryCount);
  return (
    <article className="min-w-0 rounded-xl border border-hairline-soft bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-sm text-fg">{entry.strategyCode}</h3>
            <span className="rounded-full border border-hairline-soft px-2 py-0.5 text-2xs text-fg-faint">
              Soft
            </span>
          </div>
          {entry.hypothesisCode ? (
            <p className="mt-1 font-mono text-xs text-fg-muted">
              Hypothesis · {entry.hypothesisCode}
            </p>
          ) : null}
        </div>
        {onClearStrategy ? (
          <button
            aria-label={`${clearLabel} ${entry.strategyCode}`}
            className="h-7 shrink-0 rounded-md border border-hairline-soft px-2.5 text-2xs text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-wait disabled:opacity-50"
            disabled={clearing}
            onClick={() => onClearStrategy(entry.strategyCode)}
            type="button"
          >
            {clearLabel}
          </button>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-2xs text-fg-faint">
        <span>
          {entry.hitCount} {entry.hitCount === 1 ? "hit" : "hits"}
        </span>
        <span title={formatBlacklistExpiryDate(entry.expiresAt)}>
          TTL · {formatBlacklistTtlRemaining(entry.expiresAt)}
        </span>
        <span>Expires · {formatBlacklistExpiryDate(entry.expiresAt)}</span>
        <span>Last seen · {formatBlacklistSeenDate(entry.lastSeenAt)}</span>
        {entry.sourceRunId ? <span>Source run · {entry.sourceRunId}</span> : null}
      </div>
    </article>
  );
}

export function FailureBlacklistSettingsPanel({
  workspaceId,
}: {
  workspaceId?: string | undefined;
}) {
  const [state, setState] = useState<FailureBlacklistViewState>(() =>
    failureBlacklistAvailable(workspaceId) ? { status: "loading" } : { status: "unavailable" },
  );
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const requestId = useRef(0);
  const entriesRef = useRef<FailureBlacklistEntry[]>([]);

  const load = useCallback(async (): Promise<void> => {
    const currentRequestId = ++requestId.current;
    if (!failureBlacklistAvailable(workspaceId) || !workspaceId) {
      setState({ status: "unavailable" });
      entriesRef.current = [];
      return;
    }
    setState({ status: "loading" });
    try {
      const entries = await window.modus.harnessInsights.listFailureBlacklist({ workspaceId });
      if (currentRequestId === requestId.current) {
        entriesRef.current = entries;
        setState({ status: "loaded", entries });
      }
    } catch {
      if (currentRequestId === requestId.current) {
        entriesRef.current = [];
        setState({ status: "error" });
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  const runClear = useCallback(
    async (action: () => Promise<unknown>, failureMessage: string): Promise<void> => {
      setClearing(true);
      setClearError(null);
      try {
        await action();
        await load();
      } catch {
        setClearError(failureMessage);
      } finally {
        setClearing(false);
      }
    },
    [load],
  );

  return (
    <FailureBlacklistView
      clearError={clearError}
      clearing={clearing}
      onClearAll={async () => {
        if (!workspaceId || clearing) return;
        const confirmed = window.confirm(
          "Clear all soft-blacklist entries for this workspace? Strategies will no longer be discouraged until new failures are recorded.",
        );
        if (!confirmed) return;
        await runClear(
          () =>
            window.modus.harnessInsights.clearFailureBlacklist({
              workspaceId,
              clearAll: true,
            }),
          "Could not clear the failure blacklist. Try again.",
        );
      }}
      onClearStrategy={async (strategyCode) => {
        if (!workspaceId || clearing) return;
        const count = countEntriesForStrategy(entriesRef.current, strategyCode);
        if (count < 1) return;
        const confirmed = window.confirm(buildClearStrategyConfirmMessage(strategyCode, count));
        if (!confirmed) return;
        await runClear(
          () =>
            window.modus.harnessInsights.clearFailureBlacklist({
              workspaceId,
              strategyCode,
            }),
          `Could not clear strategy "${strategyCode}". Try again.`,
        );
      }}
      onRefresh={() => {
        if (clearing) return;
        setClearError(null);
        void load();
      }}
      state={state}
    />
  );
}
