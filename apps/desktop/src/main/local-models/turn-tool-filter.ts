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
