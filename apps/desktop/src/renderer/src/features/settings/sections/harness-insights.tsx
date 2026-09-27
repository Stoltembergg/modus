import { IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  HarnessInsight,
  HarnessInsightConfidence,
  HarnessInsightsQuery,
  HarnessInsightsResult,
} from "../../../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../../../shared/contracts";
import { SettingsPageHeader } from "../settings-layout";

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

export function HarnessInsightsSettingsPanel({
  workspaceId,
}: {
  workspaceId?: string | undefined;
}) {
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
