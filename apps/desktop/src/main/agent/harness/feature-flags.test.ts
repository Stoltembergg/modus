import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFeatureFlags,
  isFeatureFlagEnabled,
  resetFeatureFlagOverrides,
  setFeatureFlagOverrides,
  validateFeatureFlags,
} from "./feature-flags";

const FLAG_ENVIRONMENT_KEYS = [
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
] as const;

describe("Harness feature flag validation", () => {
  beforeEach(() => {
    resetFeatureFlagOverrides();
    for (const key of FLAG_ENVIRONMENT_KEYS) vi.stubEnv(key, "");
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    vi.unstubAllEnvs();
  });

  it("preserves the established defaults", () => {
    expect(getFeatureFlags()).toMatchObject({
      MODUS_USE_KERNEL: true,
      MODUS_REPEAT_GUARDS: false,
      MODUS_OBSERVABILITY: false,
      MODUS_PLUGINS: false,
    });
  });

  it("reports malformed environment values without enabling the affected feature", () => {
    vi.stubEnv("MODUS_REPEAT_GUARDS", "enabled");

    expect(validateFeatureFlags()).toContain(
      'MODUS_REPEAT_GUARDS has invalid value "enabled"; expected true, false, 1, or 0',
    );
    expect(isFeatureFlagEnabled("MODUS_REPEAT_GUARDS")).toBe(false);
  });

  it("disables only features whose dependencies are invalid", () => {
    setFeatureFlagOverrides({
      MODUS_USE_KERNEL: false,
      MODUS_REPEAT_GUARDS: true,
      MODUS_OBSERVABILITY: true,
    });

    expect(validateFeatureFlags()).toEqual(
      expect.arrayContaining([
        "MODUS_REPEAT_GUARDS requires MODUS_USE_KERNEL to be enabled",
        "MODUS_OBSERVABILITY requires MODUS_USE_KERNEL to be enabled",
      ]),
    );
    expect(isFeatureFlagEnabled("MODUS_USE_KERNEL")).toBe(false);
    expect(isFeatureFlagEnabled("MODUS_REPEAT_GUARDS")).toBe(false);
    expect(isFeatureFlagEnabled("MODUS_OBSERVABILITY")).toBe(false);
  });

  it("does not enable dependencies or plugins when their prerequisites are absent", () => {
    setFeatureFlagOverrides({
      MODUS_USE_KERNEL: true,
      MODUS_CAPABILITY_REGISTRY: false,
      MODUS_PLUGINS: true,
    });

    expect(validateFeatureFlags()).toContain(
      "MODUS_PLUGINS requires MODUS_CAPABILITY_REGISTRY to be enabled",
    );
    expect(isFeatureFlagEnabled("MODUS_PLUGINS")).toBe(false);
    expect(isFeatureFlagEnabled("MODUS_CAPABILITY_REGISTRY")).toBe(false);
  });

  it("requires durable lifecycle reconciliation before plugin activation", () => {
    const flags = {
      MODUS_USE_KERNEL: true,
      MODUS_CAPABILITY_REGISTRY: true,
      MODUS_PLUGINS: true,
      MODUS_PLUGIN_LIFECYCLE: false,
    } as const;
    setFeatureFlagOverrides(flags);

    expect(validateFeatureFlags()).toContain(
      "MODUS_PLUGINS requires MODUS_PLUGIN_LIFECYCLE to be enabled",
    );
    expect(isFeatureFlagEnabled("MODUS_PLUGINS")).toBe(false);
  });

  it("keeps valid, explicitly enabled features active", () => {
    setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_REPEAT_GUARDS: true });

    expect(validateFeatureFlags()).toEqual([]);
    expect(isFeatureFlagEnabled("MODUS_REPEAT_GUARDS")).toBe(true);
  });
});
