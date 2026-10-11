/**
 * Configuration and calibration parameters for Repeat Guards and Circuit Breakers.
 * Implements GAP 7 and RISCO 3 from 2026-10-05-deepseek-harness-evolution-REVIEW.md.
 */

export type RepeatGuardConfig = {
  /** Time window in milliseconds to consider for tool invocation repetition (default: 5 min). */
  toolRepeatWindowMs: number;
  /** Number of consecutive or repeated invocations required to trigger a repeat alert (default: 3). */
  toolRepeatThreshold: number;
  /** Ratio threshold of unique failure attempt signatures below which hypothesis repetition triggers (default: 0.5). */
  hypothesisRepeatRatio: number;
  /** Maximum consecutive failed attempts allowed before circuit breaker opens (default: 5). */
  maxFailureAttempts: number;
  /** Maximum total tool invocations tracked per session before LRU pruning (default: 200). */
  maxTrackedInvocations: number;
  /** Tools that are exempt from identical repeat checks unless excessive (e.g. read-only inspections). */
  whitelistedTools: string[];
};

export const DEFAULT_REPEAT_GUARD_CONFIG: RepeatGuardConfig = {
  toolRepeatWindowMs: 300_000, // 5 minutes
  toolRepeatThreshold: 3,
  hypothesisRepeatRatio: 0.5, // 50%
  maxFailureAttempts: 5,
  maxTrackedInvocations: 200,
  whitelistedTools: [
    // Read-only tools that often require multiple re-reads or pagination
    "view_file",
    "client_view_file",
    "retrieve_spilled_tool_result",
    "search_files",
    "grep_search",
    "list_dir",
    "find_by_name",
    "read_url_content",
  ],
};

let customConfig: Partial<RepeatGuardConfig> = {};

/**
 * Returns the effective RepeatGuardConfig combining defaults and overrides.
 */
export function getRepeatGuardConfig(): RepeatGuardConfig {
  return {
    ...DEFAULT_REPEAT_GUARD_CONFIG,
    ...customConfig,
  };
}

/**
 * Overrides repeat guard config for testing or workspace-specific customization.
 */
export function setRepeatGuardConfig(config: Partial<RepeatGuardConfig>): void {
  customConfig = { ...config };
}

/**
 * Resets repeat guard configuration to defaults.
 */
export function resetRepeatGuardConfig(): void {
  customConfig = {};
}
