import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeRegistryMocks = vi.hoisted(() => ({
  warningsBeforeConstruction: [] as number[],
}));

vi.mock("./harness/adaptive-oracle-bridge", () => ({
  installAdaptiveOracleBridge: vi.fn(),
}));

vi.mock("./pi-sdk-runtime", async () => {
  return {
    PiSdkRuntime: class {
      constructor() {
        runtimeRegistryMocks.warningsBeforeConstruction.push(
          (console.warn as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0,
        );
      }
    },
  };
});

describe("runtime registry feature flag startup validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    runtimeRegistryMocks.warningsBeforeConstruction = [];
  });

  it("validates valid flags before constructing the singleton", async () => {
    vi.resetModules();
    const flags = await import("./harness/feature-flags");
    flags.setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_REPEAT_GUARDS: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getAgentRuntime } = await import("./runtime-registry");

    expect(runtimeRegistryMocks.warningsBeforeConstruction).toEqual([0]);
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
    expect(flags.isFeatureFlagEnabled("MODUS_USE_KERNEL")).toBe(false);
    expect(flags.isFeatureFlagEnabled("MODUS_REPEAT_GUARDS")).toBe(false);
    expect(flags.isFeatureFlagEnabled("MODUS_PLUGINS")).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("./runtime-registry");

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("MODUS_REPEAT_GUARDS requires MODUS_USE_KERNEL to be enabled"),
    );
    expect(runtimeRegistryMocks.warningsBeforeConstruction).toEqual([1]);
  });
});
