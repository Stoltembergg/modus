export type HarnessFeatureFlags = {
  MODUS_USE_KERNEL: boolean;
  MODUS_PROMPT_REGISTRY: boolean;
  MODUS_TOOL_RESULT_SPILL: boolean;
  MODUS_COMPACTION_PRUNING: boolean;
  MODUS_REPEAT_GUARDS: boolean;
  MODUS_GROUPS_MAILBOX: boolean;
  MODUS_RESPONSE_POLICY: boolean;
  MODUS_OBSERVABILITY: boolean;
  MODUS_CAPABILITY_REGISTRY: boolean;
  MODUS_PLUGINS: boolean;
  MODUS_PLUGIN_LIFECYCLE: boolean;
  MODUS_PLUGIN_TRACING: boolean;
  MODUS_PLUGIN_ISOLATION: boolean;
  MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE: boolean;
  MODUS_PLUGIN_ROLLBACK_SAFE_MODE: boolean;
  MODUS_PLUGIN_WASM_SANDBOX: boolean;
};

let overrides: Partial<HarnessFeatureFlags> = {};

const FEATURE_FLAG_ENVIRONMENT_KEYS: readonly (keyof HarnessFeatureFlags)[] = [
  "MODUS_USE_KERNEL",
  "MODUS_PROMPT_REGISTRY",
  "MODUS_TOOL_RESULT_SPILL",
  "MODUS_COMPACTION_PRUNING",
  "MODUS_REPEAT_GUARDS",
  "MODUS_GROUPS_MAILBOX",
  "MODUS_RESPONSE_POLICY",
  "MODUS_OBSERVABILITY",
  "MODUS_CAPABILITY_REGISTRY",
  "MODUS_PLUGINS",
  "MODUS_PLUGIN_LIFECYCLE",
  "MODUS_PLUGIN_TRACING",
  "MODUS_PLUGIN_ISOLATION",
  "MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE",
  "MODUS_PLUGIN_ROLLBACK_SAFE_MODE",
  "MODUS_PLUGIN_WASM_SANDBOX",
];

const FEATURE_FLAG_DEPENDENCIES: Partial<
  Record<keyof HarnessFeatureFlags, readonly (keyof HarnessFeatureFlags)[]>
> = {
  MODUS_PROMPT_REGISTRY: ["MODUS_USE_KERNEL"],
  MODUS_TOOL_RESULT_SPILL: ["MODUS_USE_KERNEL"],
  MODUS_COMPACTION_PRUNING: ["MODUS_USE_KERNEL"],
  MODUS_REPEAT_GUARDS: ["MODUS_USE_KERNEL"],
  MODUS_GROUPS_MAILBOX: ["MODUS_USE_KERNEL"],
  MODUS_RESPONSE_POLICY: ["MODUS_USE_KERNEL"],
  MODUS_OBSERVABILITY: ["MODUS_USE_KERNEL"],
  MODUS_CAPABILITY_REGISTRY: ["MODUS_USE_KERNEL"],
  // Plugin activation always depends on durable startup reconciliation. The
  // legacy direct-bootstrap path could revive a persisted disabled/tombstoned
  // built-in when lifecycle support was switched off.
  MODUS_PLUGINS: ["MODUS_USE_KERNEL", "MODUS_CAPABILITY_REGISTRY", "MODUS_PLUGIN_LIFECYCLE"],
  MODUS_PLUGIN_LIFECYCLE: ["MODUS_USE_KERNEL", "MODUS_PLUGINS"],
  MODUS_PLUGIN_TRACING: ["MODUS_USE_KERNEL", "MODUS_PLUGINS"],
  MODUS_PLUGIN_ISOLATION: ["MODUS_USE_KERNEL", "MODUS_PLUGINS"],
  MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE: ["MODUS_USE_KERNEL", "MODUS_PLUGINS"],
  MODUS_PLUGIN_ROLLBACK_SAFE_MODE: ["MODUS_USE_KERNEL", "MODUS_PLUGINS"],
  MODUS_PLUGIN_WASM_SANDBOX: ["MODUS_USE_KERNEL", "MODUS_PLUGINS"],
};

function parseEnvBool(val: string | undefined, defaultValue: boolean): boolean {
  if (val === undefined || val.trim() === "") return defaultValue;
  const normalized = val.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/**
 * Gets the configured feature flags, combining process.env with any testing overrides.
 * Invalid values fail closed in parseEnvBool and are reported by validateFeatureFlags.
 */
function getConfiguredFeatureFlags(): HarnessFeatureFlags {
  return {
    MODUS_USE_KERNEL:
      overrides.MODUS_USE_KERNEL ?? parseEnvBool(process.env.MODUS_USE_KERNEL, true), // Enabled by default for Fase 1
    MODUS_PROMPT_REGISTRY:
      overrides.MODUS_PROMPT_REGISTRY ?? parseEnvBool(process.env.MODUS_PROMPT_REGISTRY, false),
    MODUS_TOOL_RESULT_SPILL:
      overrides.MODUS_TOOL_RESULT_SPILL ?? parseEnvBool(process.env.MODUS_TOOL_RESULT_SPILL, false),
    MODUS_COMPACTION_PRUNING:
      overrides.MODUS_COMPACTION_PRUNING ??
      parseEnvBool(process.env.MODUS_COMPACTION_PRUNING, false),
    MODUS_REPEAT_GUARDS:
      overrides.MODUS_REPEAT_GUARDS ?? parseEnvBool(process.env.MODUS_REPEAT_GUARDS, false),
    MODUS_GROUPS_MAILBOX:
      overrides.MODUS_GROUPS_MAILBOX ?? parseEnvBool(process.env.MODUS_GROUPS_MAILBOX, false),
    MODUS_RESPONSE_POLICY:
      overrides.MODUS_RESPONSE_POLICY ?? parseEnvBool(process.env.MODUS_RESPONSE_POLICY, false),
    MODUS_OBSERVABILITY:
      overrides.MODUS_OBSERVABILITY ?? parseEnvBool(process.env.MODUS_OBSERVABILITY, false),
    MODUS_CAPABILITY_REGISTRY:
      overrides.MODUS_CAPABILITY_REGISTRY ??
      parseEnvBool(process.env.MODUS_CAPABILITY_REGISTRY, false),
    MODUS_PLUGINS: overrides.MODUS_PLUGINS ?? parseEnvBool(process.env.MODUS_PLUGINS, false),
    MODUS_PLUGIN_LIFECYCLE:
      overrides.MODUS_PLUGIN_LIFECYCLE ?? parseEnvBool(process.env.MODUS_PLUGIN_LIFECYCLE, false),
    MODUS_PLUGIN_TRACING:
      overrides.MODUS_PLUGIN_TRACING ?? parseEnvBool(process.env.MODUS_PLUGIN_TRACING, false),
    MODUS_PLUGIN_ISOLATION:
      overrides.MODUS_PLUGIN_ISOLATION ?? parseEnvBool(process.env.MODUS_PLUGIN_ISOLATION, false),
    MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE:
      overrides.MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE ??
      parseEnvBool(process.env.MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE, false),
    MODUS_PLUGIN_ROLLBACK_SAFE_MODE:
      overrides.MODUS_PLUGIN_ROLLBACK_SAFE_MODE ??
      parseEnvBool(process.env.MODUS_PLUGIN_ROLLBACK_SAFE_MODE, false),
    MODUS_PLUGIN_WASM_SANDBOX:
      overrides.MODUS_PLUGIN_WASM_SANDBOX ??
      parseEnvBool(process.env.MODUS_PLUGIN_WASM_SANDBOX, false),
  };
}

/**
 * Gets the effective feature flags. Features whose declared prerequisites are
 * disabled are themselves disabled; this never turns a prerequisite on.
 */
export function getFeatureFlags(): HarnessFeatureFlags {
  const effective = getConfiguredFeatureFlags();
  let changed = true;

  while (changed) {
    changed = false;
    for (const flag of FEATURE_FLAG_ENVIRONMENT_KEYS) {
      const dependencies = FEATURE_FLAG_DEPENDENCIES[flag];
      if (effective[flag] && dependencies?.some((dependency) => !effective[dependency])) {
        effective[flag] = false;
        changed = true;
      }
    }
  }

  return effective;
}

/**
 * Checks whether a specific feature flag is currently enabled.
 */
export function isFeatureFlagEnabled(flag: keyof HarnessFeatureFlags): boolean {
  return getFeatureFlags()[flag] ?? false;
}

/**
 * Validates dependencies between feature flags.
 * Returns configuration errors for malformed values and unmet
 * dependencies.
 */
export function validateFeatureFlags(flags?: Partial<HarnessFeatureFlags>): string[] {
  const configured = flags ?? getConfiguredFeatureFlags();
  const errors: string[] = flags ? [] : getInvalidEnvironmentValues();

  for (const flag of FEATURE_FLAG_ENVIRONMENT_KEYS) {
    const dependencies = FEATURE_FLAG_DEPENDENCIES[flag];
    for (const dependency of dependencies ?? []) {
      if (configured[flag] && !configured[dependency]) {
        errors.push(`${flag} requires ${dependency} to be enabled`);
      }
    }
  }

  return errors;
}

function getInvalidEnvironmentValues(): string[] {
  const validValues = new Set(["true", "false", "1", "0"]);
  const errors: string[] = [];

  for (const flag of FEATURE_FLAG_ENVIRONMENT_KEYS) {
    if (overrides[flag] !== undefined) continue;
    const value = process.env[flag];
    if (value === undefined || value.trim() === "") continue;
    if (!validValues.has(value.trim().toLowerCase())) {
      errors.push(
        `${flag} has invalid value ${JSON.stringify(value)}; expected true, false, 1, or 0`,
      );
    }
  }

  return errors;
}

/**
 * Sets overrides for testing feature flag conditions.
 */
export function setFeatureFlagOverrides(newOverrides: Partial<HarnessFeatureFlags>): void {
  overrides = { ...overrides, ...newOverrides };
}
export const setFeatureFlagsOverride = setFeatureFlagOverrides;

/**
 * Resets all overrides.
 */
export function resetFeatureFlagOverrides(): void {
  overrides = {};
}
export const resetFeatureFlagsOverride = resetFeatureFlagOverrides;
