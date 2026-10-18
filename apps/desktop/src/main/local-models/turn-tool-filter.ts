import type { LocalModelFailure } from "./errors";
import { emitLocalModelsLine } from "./local-models-log-file";
import type { TurnToolFilter } from "./tool-filter-controller";

/**
 * What the request path needs from the local tool filter, without importing
 * the controller (and so nothing heavy) into the agent runtime. Policy frozen
 * by the RERANK-03 gate (criterion_r3.json): core tools are always exposed,
 * the pool is ranked on doc_short, and the top 8 are added on the session's
 * first turn. `tools_expand` is always exposed while the filter is on.
 */
export const CORE_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const TOOL_FILTER_TOP_K = 8;

/** doc_short of the gate (build_catalog.py): "name: first sentence" (<= 200 chars). */
export function toolDocShort(name: string, description: string | undefined): string {
  const text = (description ?? "").split(/\s+/).filter(Boolean).join(" ");
  const end = text.indexOf(". ");
  return `${name}: ${end > 0 && end < 200 ? text.slice(0, end + 1) : text.slice(0, 200)}`;
}

let current: TurnToolFilter | null = null;

export function setTurnToolFilter(filter: TurnToolFilter | null): void {
  current = filter;
}

/** The app's filter, or null (tests, or before startup): null means off. */
export function getTurnToolFilter(): TurnToolFilter | null {
  return current;
}

export function turnToolFilterEnabled(): boolean {
  return current?.enabled() === true;
}

/**
 * Per-turn log line (one per top-level session's first-turn decision while the
 * filter is on). Debbie's rule: only the mode, counts, duration and a fixed
 * reason word. Never the message, tool names or docs, ids, paths or user data.
 */
export type TurnToolFilterLogReason = "off" | "loading" | "busy" | "timeout" | "error";

/**
 * Raw cause of a fallback: a ranker failure, an exception in the request path, or
 * "unknown" when a non-filtered selection carries no reason (the ranker always sets one).
 */
export type TurnToolFilterFallbackCause = LocalModelFailure | "exception" | "unknown";

/** Maps a fallback cause to the reason word in the log line. */
export function turnToolFilterLogReason(
  cause: TurnToolFilterFallbackCause,
): TurnToolFilterLogReason {
  switch (cause) {
    case "disabled":
      return "off";
    case "not-ready":
      return "loading";
    case "busy":
      return "busy";
    case "timeout":
      return "timeout";
    case "unsupported-platform":
    case "missing":
    case "hash-mismatch":
    case "download-failed":
    case "load-failed":
    case "inference-failed":
    case "crashed":
    case "hung":
    case "cancelled":
    case "exception":
    case "unknown":
      return "error";
  }
}

export type TurnToolFilterLogEntry =
  | { mode: "filtered"; sent: number; of: number; core: number; ms: number }
  | {
      mode: "fallback";
      cause: TurnToolFilterFallbackCause;
      sent: number;
      of: number;
      core: number;
      ms: number;
    };

/**
 * `sent`/`of`: ranked (non-core) tools sent / the non-core pool. `core`: core tools +
 * tools_expand sent alongside. `cause` is added when it says more than `reason`.
 */
export function formatTurnToolFilterLog(entry: TurnToolFilterLogEntry): string {
  const counts = `sent=${entry.sent} of=${entry.of} core=${entry.core} ms=${Math.max(0, Math.round(entry.ms))}`;
  if (entry.mode === "filtered") return `[local-models] tool filter: filtered ${counts}`;
  const reason = turnToolFilterLogReason(entry.cause);
  const cause = entry.cause === reason ? "" : ` cause=${entry.cause}`;
  return `[local-models] tool filter: fallback reason=${reason} ${counts}${cause}`;
}

let clock: () => number = () => performance.now();

/** Main-side clock for the `ms` field (tests pin it). */
export function turnToolFilterNow(): number {
  return clock();
}

export function setTurnToolFilterClock(now: (() => number) | null): void {
  clock = now ?? (() => performance.now());
}

export function logTurnToolFilter(entry: TurnToolFilterLogEntry): void {
  emitLocalModelsLine(formatTurnToolFilterLog(entry));
}

/**
 * tools_expand line: the session's turn (1 = the turn the filter decided, counted in
 * this app run), how many tools the call added (0 = everything was already exposed)
 * and that session's first-turn decision (`filtered` or `fallback`). Counts only.
 */
export type ToolsExpandLogEntry = {
  turn: number;
  added: number;
  after: TurnToolFilterLogEntry["mode"];
};

export function formatToolsExpandLog(entry: ToolsExpandLogEntry): string {
  const turn = Math.max(0, Math.trunc(entry.turn));
  const added = Math.max(0, Math.trunc(entry.added));
  return `[local-models] tool filter: expand turn=${turn} added=${added} after=${entry.after}`;
}

export function logToolsExpand(entry: ToolsExpandLogEntry): void {
  emitLocalModelsLine(formatToolsExpandLog(entry));
}
