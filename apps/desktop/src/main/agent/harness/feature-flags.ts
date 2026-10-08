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

function parseEnvBool(val: string | undefined, defaultValue: boolean): boolean {
  if (val === undefined || val === '') return defaultValue;
  return val === '1' || val.toLowerCase() === 'true';
}

/**
 * Gets the active feature flags, combining process.env with any testing overrides.
 */
export function getFeatureFlags(): HarnessFeatureFlags {
  return {
    MODUS_USE_KERNEL:
      overrides.MODUS_USE_KERNEL ??
      parseEnvBool(process.env.MODUS_USE_KERNEL, true), // Enabled by default for Fase 1
    MODUS_PROMPT_REGISTRY:
      overrides.MODUS_PROMPT_REGISTRY ??
      parseEnvBool(process.env.MODUS_PROMPT_REGISTRY, false),
    MODUS_TOOL_RESULT_SPILL:
      overrides.MODUS_TOOL_RESULT_SPILL ??
      parseEnvBool(process.env.MODUS_TOOL_RESULT_SPILL, false),
    MODUS_COMPACTION_PRUNING:
      overrides.MODUS_COMPACTION_PRUNING ??
      parseEnvBool(process.env.MODUS_COMPACTION_PRUNING, false),
    MODUS_REPEAT_GUARDS:
      overrides.MODUS_REPEAT_GUARDS ??
      parseEnvBool(process.env.MODUS_REPEAT_GUARDS, false),
    MODUS_GROUPS_MAILBOX:
      overrides.MODUS_GROUPS_MAILBOX ??
      parseEnvBool(process.env.MODUS_GROUPS_MAILBOX, false),
    MODUS_RESPONSE_POLICY:
      overrides.MODUS_RESPONSE_POLICY ??
      parseEnvBool(process.env.MODUS_RESPONSE_POLICY, false),
    MODUS_OBSERVABILITY:
      overrides.MODUS_OBSERVABILITY ??
      parseEnvBool(process.env.MODUS_OBSERVABILITY, false),
    MODUS_CAPABILITY_REGISTRY:
      overrides.MODUS_CAPABILITY_REGISTRY ??
      parseEnvBool(process.env.MODUS_CAPABILITY_REGISTRY, false),
    MODUS_PLUGINS:
      overrides.MODUS_PLUGINS ??
      parseEnvBool(process.env.MODUS_PLUGINS, false),
    MODUS_PLUGIN_LIFECYCLE:
      overrides.MODUS_PLUGIN_LIFECYCLE ??
      parseEnvBool(process.env.MODUS_PLUGIN_LIFECYCLE, false),
    MODUS_PLUGIN_TRACING:
      overrides.MODUS_PLUGIN_TRACING ??
      parseEnvBool(process.env.MODUS_PLUGIN_TRACING, false),
    MODUS_PLUGIN_ISOLATION:
      overrides.MODUS_PLUGIN_ISOLATION ??
      parseEnvBool(process.env.MODUS_PLUGIN_ISOLATION, false),
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
 * Checks whether a specific feature flag is currently enabled.
 */
export function isFeatureFlagEnabled(flag: keyof HarnessFeatureFlags): boolean {
  return getFeatureFlags()[flag] ?? false;
}

/**
 * Validates dependencies between feature flags.
 * Throws or returns an array of validation errors if dependent flags are enabled without their prerequisites.
 */
export function validateFeatureFlags(flags: Partial<HarnessFeatureFlags> = getFeatureFlags()): string[] {
  const errors: string[] = [];

  if (!flags.MODUS_USE_KERNEL) {
    if (flags.MODUS_PROMPT_REGISTRY) {
      errors.push('MODUS_PROMPT_REGISTRY requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_TOOL_RESULT_SPILL) {
      errors.push('MODUS_TOOL_RESULT_SPILL requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_COMPACTION_PRUNING) {
      errors.push('MODUS_COMPACTION_PRUNING requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_REPEAT_GUARDS) {
      errors.push('MODUS_REPEAT_GUARDS requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_GROUPS_MAILBOX) {
      errors.push('MODUS_GROUPS_MAILBOX requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_RESPONSE_POLICY) {
      errors.push('MODUS_RESPONSE_POLICY requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_OBSERVABILITY) {
      errors.push('MODUS_OBSERVABILITY requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_CAPABILITY_REGISTRY) {
      errors.push('MODUS_CAPABILITY_REGISTRY requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_PLUGINS) {
      errors.push('MODUS_PLUGINS requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_PLUGIN_LIFECYCLE) {
      errors.push('MODUS_PLUGIN_LIFECYCLE requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_PLUGIN_TRACING) {
      errors.push('MODUS_PLUGIN_TRACING requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_PLUGIN_ISOLATION) {
      errors.push('MODUS_PLUGIN_ISOLATION requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE) {
      errors.push('MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_PLUGIN_ROLLBACK_SAFE_MODE) {
      errors.push('MODUS_PLUGIN_ROLLBACK_SAFE_MODE requires MODUS_USE_KERNEL to be enabled');
    }
    if (flags.MODUS_PLUGIN_WASM_SANDBOX) {
      errors.push('MODUS_PLUGIN_WASM_SANDBOX requires MODUS_USE_KERNEL to be enabled');
    }
  }

  if (flags.MODUS_PLUGINS && !flags.MODUS_CAPABILITY_REGISTRY) {
    errors.push('MODUS_PLUGINS requires MODUS_CAPABILITY_REGISTRY to be enabled');
  }

  if (flags.MODUS_PLUGIN_LIFECYCLE && !flags.MODUS_PLUGINS) {
    errors.push('MODUS_PLUGIN_LIFECYCLE requires MODUS_PLUGINS to be enabled');
  }

  if (flags.MODUS_PLUGIN_TRACING && !flags.MODUS_PLUGINS) {
    errors.push('MODUS_PLUGIN_TRACING requires MODUS_PLUGINS to be enabled');
  }

  if (flags.MODUS_PLUGIN_ISOLATION && !flags.MODUS_PLUGINS) {
    errors.push('MODUS_PLUGIN_ISOLATION requires MODUS_PLUGINS to be enabled');
  }

  if (flags.MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE && !flags.MODUS_PLUGINS) {
    errors.push('MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE requires MODUS_PLUGINS to be enabled');
  }

  if (flags.MODUS_PLUGIN_ROLLBACK_SAFE_MODE && !flags.MODUS_PLUGINS) {
    errors.push('MODUS_PLUGIN_ROLLBACK_SAFE_MODE requires MODUS_PLUGINS to be enabled');
  }

  if (flags.MODUS_PLUGIN_WASM_SANDBOX && !flags.MODUS_PLUGINS) {
    errors.push('MODUS_PLUGIN_WASM_SANDBOX requires MODUS_PLUGINS to be enabled');
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
