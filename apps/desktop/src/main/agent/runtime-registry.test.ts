import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeRegistryMocks = vi.hoisted(() => ({
  constructionFlags: [] as Array<{
    kernel: boolean;
    repeatGuards: boolean;
    plugins: boolean;
    warningsBeforeConstruction: number;
  }>,
}));

vi.mock("./harness/adaptive-oracle-bridge", () => ({
  installAdaptiveOracleBridge: vi.fn(),
}));

vi.mock("./pi-sdk-runtime", async () => {
  const featureFlags = await vi.importActual<typeof import("./harness/feature-flags")>(
    "./harness/feature-flags"
  );
  return {
    PiSdkRuntime: class {
      constructor() {
        runtimeRegistryMocks.constructionFlags.push({
          kernel: featureFlags.isFeatureFlagEnabled("MODUS_USE_KERNEL"),
          repeatGuards: featureFlags.isFeatureFlagEnabled("MODUS_REPEAT_GUARDS"),
          plugins: featureFlags.isFeatureFlagEnabled("MODUS_PLUGINS"),
          warningsBeforeConstruction:
            (console.warn as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0,
        });
      }
    },
  };
});

describe("runtime registry feature flag startup validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    runtimeRegistryMocks.constructionFlags = [];
  });

  it("validates valid flags before constructing the singleton", async () => {
    vi.resetModules();
    const flags = await import("./harness/feature-flags");
    flags.setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_REPEAT_GUARDS: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getAgentRuntime } = await import("./runtime-registry");

    expect(runtimeRegistryMocks.constructionFlags).toEqual([
      { kernel: true, repeatGuards: true, plugins: false, warningsBeforeConstruction: 0 },
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(getAgentRuntime()).toBe(getAgentRuntime());
  });

  it("diagnoses invalid dependencies and disables them before constructing the singleton", async () => {
    vi.resetModules();
    const flags = await import("./harness/feature-flags");
    flags.setFeatureFlagOverrides({
      MODUS_USE_KERNEL: false,
      MODUS_REPEAT_GUARDS: true,
      MODUS_PLUGINS: true,
      MODUS_CAPABILITY_REGISTRY: false,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("./runtime-registry");

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("MODUS_REPEAT_GUARDS requires MODUS_USE_KERNEL to be enabled"),
    );
    expect(runtimeRegistryMocks.constructionFlags).toEqual([
      { kernel: false, repeatGuards: false, plugins: false, warningsBeforeConstruction: 1 },
    ]);
  });
});
