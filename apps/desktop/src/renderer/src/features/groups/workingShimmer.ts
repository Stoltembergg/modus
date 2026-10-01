/**
 * Visibility + naming for the Prompt Kit working shimmer above the group composer.
 * Hide when idle or when streamed writing already makes progress obvious.
 * Label uses concrete phases (queued age / waiting on model / running tests).
 */

import {
  formatGroupProgressLabel,
  groupAgentProgressShimmerLabel,
} from "../../../../shared/group-progress-label";

export type GroupWorkingShimmerRow = {
  sessionId: string;
  mode: "running" | "queued";
  live: {
    streamText: string;
    collapsed: boolean;
    phase?: string;
    presence?: {
      state?: string;
      activity?: string;
      waitingFor?: string;
      startedAt?: number;
    };
  };
};

/** Rows that still need a working indicator (no obvious streamed text yet). */
export function groupWorkingShimmerCandidates(
  rows: readonly GroupWorkingShimmerRow[],
): GroupWorkingShimmerRow[] {
  return rows.filter((row) => !row.live.collapsed && !row.live.streamText.trim());
}

/** True when the shimmer strip should render above the composer. */
export function shouldShowGroupWorkingShimmer(rows: readonly GroupWorkingShimmerRow[]): boolean {
  return groupWorkingShimmerCandidates(rows).length > 0;
}

/**
 * Display names for the shimmer label. Prefer running agents; fall back to queued.
 */
export function groupWorkingShimmerNames(
  rows: readonly GroupWorkingShimmerRow[],
  labels: ReadonlyMap<string, { title: string }>,
): string[] {
  const candidates = groupWorkingShimmerCandidates(rows);
  const running = candidates.filter((row) => row.mode === "running");
  const source = running.length > 0 ? running : candidates;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of source) {
    const title = (labels.get(row.sessionId)?.title ?? row.sessionId).trim();
    if (!title || seen.has(title.toLocaleLowerCase())) continue;
    seen.add(title.toLocaleLowerCase());
    names.push(title);
  }
  return names;
}

/** Primary candidate row for the shimmer phase (running first). */
export function groupWorkingShimmerPrimary(
  rows: readonly GroupWorkingShimmerRow[],
): GroupWorkingShimmerRow | undefined {
  const candidates = groupWorkingShimmerCandidates(rows);
  return candidates.find((row) => row.mode === "running") ?? candidates[0];
}

/** Concrete shimmer text: "Builder · Waiting on model…" / "Planner · Queued · 12s". */
export function groupWorkingShimmerText(
  rows: readonly GroupWorkingShimmerRow[],
  labels: ReadonlyMap<string, { title: string }>,
  locale?: string | null,
  nowMs = Date.now(),
): string {
  const primary = groupWorkingShimmerPrimary(rows);
  const names = groupWorkingShimmerNames(rows, labels);
  const phaseLabel = primary
    ? formatGroupProgressLabel({
        phase: String(primary.live.phase ?? (primary.mode === "queued" ? "Queued" : "Thinking")),
        presenceState: primary.live.presence?.state,
        activity: primary.live.presence?.activity,
        waitingFor: primary.live.presence?.waitingFor,
        startedAt: primary.live.presence?.startedAt,
        nowMs,
        locale,
      })
    : formatGroupProgressLabel({ phase: "Thinking", presenceState: "thinking", locale });
  return groupAgentProgressShimmerLabel({ names, phaseLabel, locale });
}
