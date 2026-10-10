import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiSdkRuntime } from "../../pi-sdk-runtime";
import { HOST_CAPABILITY_REGISTRATION_AUTHORITY } from "../capability/capability-registration-authority";
import { CapabilityRegistry } from "../capability/capability-registry";
import type { Capability, CapabilityProvider } from "../capability/capability-types";
import {
  getFeatureFlags,
  resetFeatureFlagOverrides,
  setFeatureFlagOverrides,
  validateFeatureFlags,
} from "../feature-flags";
import { HarnessObserver } from "../observability/harness-observer";
import { PluginFailureCorrelation } from "./plugin-failure-correlation";
import { PluginHealthMonitor } from "./plugin-health-monitor";
import { PluginInstrumentation } from "./plugin-instrumentation";
import { PluginStateStore } from "./plugin-state-store";
import type { PluginTrace } from "./plugin-tracing-types";
import type { PluginManifest } from "./plugin-types";

describe("Fase 12 — Plugin Tracing & Observability", () => {
  beforeEach(() => {
    resetFeatureFlagOverrides();
    HarnessObserver.getInstance().clear();
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    HarnessObserver.getInstance().clear();
  });

  describe("12.1 — Plugin Instrumentation & Execution Traces", () => {
    it("instruments successful execution and records duration, status, and metadata", async () => {
      const instrumentation = new PluginInstrumentation();
      let ran = false;

      const result = await instrumentation.trace(
        "@modus/test-plugin",
        "context.resolve",
        async () => {
          ran = true;
          return { resolved: true };
        },
        {
          version: "1.2.0",
          metadata: { inputSize: 42 },
        },
      );

      expect(ran).toBe(true);
      expect(result).toEqual({ resolved: true });

      const traces = instrumentation.getRecentTraces("@modus/test-plugin");
      expect(traces.length).toBe(1);
      const trace = traces[0]!;
      expect(trace.pluginId).toBe("@modus/test-plugin");
      expect(trace.capability).toBe("context.resolve");
      expect(trace.version).toBe("1.2.0");
      expect(trace.status).toBe("success");
      expect(trace.durationMs).toBeGreaterThanOrEqual(0);
      expect(trace.metadata).toEqual({ inputSize: 42 });
    });

    it("instruments failure, captures error details without swallowing the exception", async () => {
      const instrumentation = new PluginInstrumentation();

      await expect(
        instrumentation.trace(
          "@modus/faulty-plugin",
          "memory.store",
          async () => {
            throw new Error("Database connection failed");
          },
          { version: "0.9.1" },
        ),
      ).rejects.toThrow("Database connection failed");

      const traces = instrumentation.getRecentTraces("@modus/faulty-plugin");
      expect(traces.length).toBe(1);
      const trace = traces[0]!;
      expect(trace.pluginId).toBe("@modus/faulty-plugin");
      expect(trace.status).toBe("error");
      expect(trace.error).toContain("Database connection failed");
    });

    it("enforces execution timeout and classifies trace status as timeout", async () => {
      const instrumentation = new PluginInstrumentation();

      await expect(
        instrumentation.trace(
          "@modus/slow-plugin",
          "vector.search",
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return "done";
          },
          { timeoutMs: 10 },
        ),
      ).rejects.toThrow(/timed out after 10ms/);

      const traces = instrumentation.getRecentTraces("@modus/slow-plugin");
      expect(traces.length).toBe(1);
      const trace = traces[0]!;
      expect(trace.status).toBe("timeout");
      expect(trace.error).toContain("timed out after 10ms");
    });

    it("aborts and drains cooperative work before returning a timeout", async () => {
      const instrumentation = new PluginInstrumentation();
      let signal: AbortSignal | undefined;
      let workSettled = false;

      const trace = instrumentation.trace(
        "@modus/cancellable-plugin",
        "vector.search",
        async (executionSignal?: AbortSignal) => {
          signal = executionSignal;
          await new Promise<void>((resolve) => {
            executionSignal?.addEventListener("abort", () => setTimeout(resolve, 5), {
              once: true,
            });
          });
          workSettled = true;
          return "done";
        },
        { timeoutMs: 10 },
      );

      await expect(trace).rejects.toThrow(/timed out after 10ms/);
      expect(signal?.aborted).toBe(true);
      expect(workSettled).toBe(true);
    });

    it("records user cancellation separately from plugin failure", async () => {
      setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_OBSERVABILITY: true });
      const observer = HarnessObserver.getInstance();
      const instrumentation = new PluginInstrumentation();
      const controller = new AbortController();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });

      const execution = instrumentation.trace(
        "@modus/cancelled-plugin",
        "vector.search",
        async (signal) => {
          markStarted();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return "unreachable";
        },
        { sessionId: "cancelled-plugin-session", signal: controller.signal },
      );

      await started;
      const cancellation = new Error("cancelled by user");
      controller.abort(cancellation);
      await expect(execution).rejects.toBe(cancellation);

      expect(instrumentation.getRecentTraces("@modus/cancelled-plugin")[0]).toMatchObject({
        status: "cancelled",
        error: "cancelled by user",
      });
      expect(observer.getRecentEvents(10)).toContainEqual(
        expect.objectContaining({
          type: "harness.plugin.cancelled",
          sessionId: "cancelled-plugin-session",
          data: expect.objectContaining({ status: "cancelled" }),
        }),
      );
      expect(observer.snapshot().plugins).toMatchObject({ failureCount: 0, cancellationCount: 1 });
    });

    it("dispatches trace events to unified HarnessObserver", async () => {
      setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_OBSERVABILITY: true });
      const observer = HarnessObserver.getInstance();
      const instrumentation = new PluginInstrumentation();

      await instrumentation.trace(
        "@modus/observer-plugin",
        "prompt.enrich",
        async () => "enriched",
        { version: "2.0.0", sessionId: "sess-obs-1" },
      );

      const events = observer.getRecentEvents(10);
      const pluginEvent = events.find((e) => e.type === "harness.plugin.executed");
      expect(pluginEvent).toBeDefined();
      expect(pluginEvent?.data.pluginId).toBe("@modus/observer-plugin");
      expect(pluginEvent?.sessionId).toBe("sess-obs-1");

      const snap = observer.snapshot();
      expect(snap.plugins).toBeDefined();
      expect(snap.plugins?.totalExecutions).toBe(1);
      expect(snap.plugins?.failureCount).toBe(0);
      expect(snap.plugins?.activePluginCount).toBe(1);
    });

    it("keeps Observer plugin metrics disabled without disabling plugin tracing", async () => {
      setFeatureFlagOverrides({ MODUS_USE_KERNEL: true, MODUS_OBSERVABILITY: false });
      const observer = HarnessObserver.getInstance();
      const instrumentation = new PluginInstrumentation();

      await instrumentation.trace(
        "@modus/observer-disabled-plugin",
        "prompt.enrich",
        async () => "enriched",
      );

      expect(instrumentation.getRecentTraces()).toHaveLength(1);
      expect(observer.snapshot().plugins?.totalExecutions).toBe(0);
      expect(observer.getRecentEvents(10)).toHaveLength(0);
    });

    it("supports custom collector callback and respects max trace buffer", async () => {
      const collected: PluginTrace[] = [];
      const instrumentation = new PluginInstrumentation({
        maxTraces: 3,
        collector: (t) => collected.push(t),
      });

      for (let i = 0; i < 5; i++) {
        await instrumentation.trace("p1", "cap", async () => i);
      }

      expect(collected.length).toBe(5);
      expect(instrumentation.getRecentTraces().length).toBe(3);
    });
  });

  describe("12.2 — Plugin Health Monitoring", () => {
    it("returns healthy status for plugins with zero executions or low error rate", () => {
      const instrumentation = new PluginInstrumentation();
      const monitor = new PluginHealthMonitor(instrumentation);

      const health = monitor.getHealth("@modus/unused");
      expect(health.status).toBe("healthy");
      expect(health.totalCalls).toBe(0);
      expect(health.errorRate).toBe(0);
    });

    it("classifies health correctly according to error rate thresholds", async () => {
      const instrumentation = new PluginInstrumentation();
      const monitor = new PluginHealthMonitor(instrumentation);

      // 100 calls total
      // 94 successes, 6 errors -> 6% error rate -> 'degraded' (> 5%)
      for (let i = 0; i < 94; i++) {
        await instrumentation.trace("@modus/test", "c1", async () => "ok");
      }
      for (let i = 0; i < 6; i++) {
        try {
          await instrumentation.trace("@modus/test", "c1", async () => {
            throw new Error("fail");
          });
        } catch {}
      }

      let health = monitor.getHealth("@modus/test");
      expect(health.totalCalls).toBe(100);
      expect(health.errorCount).toBe(6);
      expect(health.errorRate).toBe(0.06);
      expect(health.status).toBe("degraded");
      expect(monitor.isDegraded("@modus/test")).toBe(true);

      // Add 6 more errors -> 12 errors / 106 calls = ~11.3% -> 'failing' (> 10%)
      for (let i = 0; i < 6; i++) {
        try {
          await instrumentation.trace("@modus/test", "c1", async () => {
            throw new Error("fail");
          });
        } catch {}
      }

      health = monitor.getHealth("@modus/test");
      expect(health.status).toBe("failing");
      expect(health.errorRate).toBeGreaterThan(0.1);
    });

    it("classifies health according to P95 latency thresholds", () => {
      const instrumentation = new PluginInstrumentation();
      const monitor = new PluginHealthMonitor(instrumentation);

      // Direct check of determineStatus
      expect(monitor.determineStatus(0.01, 100)).toBe("healthy");
      expect(monitor.determineStatus(0.01, 2500)).toBe("degraded");
      expect(monitor.determineStatus(0.01, 5500)).toBe("failing");
    });

    it("aggregates health across all active plugins via getAllHealth", async () => {
      const instrumentation = new PluginInstrumentation();
      const monitor = new PluginHealthMonitor(instrumentation);

      await instrumentation.trace("plugin-a", "c1", async () => "a");
      await instrumentation.trace("plugin-b", "c2", async () => "b");

      const all = monitor.getAllHealth();
      expect(all.size).toBe(2);
      expect(all.has("plugin-a")).toBe(true);
      expect(all.has("plugin-b")).toBe(true);
    });
  });

  describe("12.3 — Failure Intelligence Correlation", () => {
    it("correlates failure directly when error mentions plugin ID with high confidence", async () => {
      const instrumentation = new PluginInstrumentation();
      const correlator = new PluginFailureCorrelation(instrumentation);

      // Register trace for plugin
      await instrumentation.trace("@modus/memory-store", "memory.fetch", async () => "data");

      const correlation = correlator.analyze({
        error: new Error("Critical failure inside @modus/memory-store connection pool"),
        timestamp: Date.now(),
      });

      expect(correlation).not.toBeNull();
      expect(correlation?.suspect).toBe("@modus/memory-store");
      expect(correlation?.confidence).toBeGreaterThanOrEqual(0.85);
      expect(correlation?.evidence.pattern).toBe("error_or_stack_contains_plugin_id");
    });

    it("correlates failure using capability provider execution history", async () => {
      const instrumentation = new PluginInstrumentation();
      const correlator = new PluginFailureCorrelation(instrumentation);

      // Plugin ran the capability and threw an error
      try {
        await instrumentation.trace("@modus/router", "model.route", async () => {
          throw new Error("Routing table corrupted");
        });
      } catch {}

      const correlation = correlator.analyze({
        error: new Error("Unable to route completion request"),
        capability: "model.route",
      });

      expect(correlation).not.toBeNull();
      expect(correlation?.suspect).toBe("@modus/router");
      expect(correlation?.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("correlates failure with recent upgrade using PluginStateStore lifecycle events", async () => {
      const instrumentation = new PluginInstrumentation();
      const store = new PluginStateStore(":memory:");
      const correlator = new PluginFailureCorrelation(instrumentation, store);

      // Install and upgrade plugin in store
      store.savePlugin({
        id: "@modus/custom-plugin",
        version: "1.0.0",
        state: "enabled",
        trust_level: "official",
        installed_at: new Date().toISOString(),
        last_enabled: null,
        config: null,
      });

      const upgradeTime = new Date();
      const manifest: PluginManifest = {
        id: "@modus/custom-plugin",
        name: "Custom",
        version: "2.0.0",
        author: "Modus",
        description: "Test",
        trustLevel: "official",
        provides: [{ capability: "custom.execute", apiVersion: "1.0.0" }],
        requires: { modus: ">=0.1.0" },
        permissions: { required: {} },
      };
      store.saveVersion("@modus/custom-plugin", "2.0.0", manifest, "hash2");
      store.recordEvent("@modus/custom-plugin", "upgraded", { version: "2.0.0" });

      // Plugin fails right after upgrade
      try {
        await instrumentation.trace("@modus/custom-plugin", "custom.execute", async () => {
          throw new Error("Crash after v2 update");
        });
      } catch {}

      const correlation = correlator.analyze({
        error: new Error("Unexpected crash"),
        timestamp: upgradeTime.getTime() + 1000,
      });

      expect(correlation).not.toBeNull();
      expect(correlation?.suspect).toBe("@modus/custom-plugin");
      expect(correlation?.confidence).toBeGreaterThanOrEqual(0.8);
      expect(correlation?.evidence.pattern).toBe("failures_started_after_update");

      store.close();
    });

    it("returns null when no plugin correlates with the failure", () => {
      const instrumentation = new PluginInstrumentation();
      const correlator = new PluginFailureCorrelation(instrumentation);

      const correlation = correlator.analyze({
        error: new Error("Unrelated network timeout on external API"),
      });

      expect(correlation).toBeNull();
    });
  });

  describe("12.4 — CapabilityRegistry End-to-End Tracing Integration", () => {
    it("automatically generates plugin execution traces and updates observer on execute", async () => {
      const registry = new CapabilityRegistry();
      const instrumentation = new PluginInstrumentation();
      registry.setInstrumentation(instrumentation);

      const cap: Capability = {
        id: "math.compute",
        apiVersion: "1.0.0",
        replaceable: true,
        dependencies: [],
        metadata: {
          description: "Math capability",
        },
      };
      registry.registerCapability(cap);

      const provider: CapabilityProvider = {
        providerId: "@plugins/math-pack",
        capabilityId: "math.compute",
        capabilityApiVersion: "1.0.0",
        providerVersion: "1.0.0",
        trustLevel: "official",
        permissions: {},
        implementation: {
          execute: async ({ a, b }: { a: number; b: number }) => a + b,
        },
        registeredAt: new Date(),
        metadata: {},
      };
      registry.registerProvider(provider, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      const result = await registry.execute("math.compute", { a: 10, b: 32 });
      expect(result).toBe(42);

      const traces = instrumentation.getRecentTraces("@plugins/math-pack");
      expect(traces.length).toBe(1);
      expect(traces[0]?.capability).toBe("math.compute");
      expect(traces[0]?.status).toBe("success");

      // Provenance is also recorded
      const prov = registry.getProvenance("math.compute");
      expect(prov.usageCount).toBe(1);
    });
  });

  describe("12.5 — PiSdkRuntime Integration & Feature Flags", () => {
    it("validates feature flag hierarchy for MODUS_PLUGIN_TRACING", () => {
      // MODUS_PLUGIN_TRACING requires MODUS_PLUGINS
      const errors = validateFeatureFlags({
        MODUS_USE_KERNEL: true,
        MODUS_PLUGIN_TRACING: true,
        MODUS_PLUGINS: false,
      });
      expect(errors).toContain("MODUS_PLUGIN_TRACING requires MODUS_PLUGINS to be enabled");

      // Without MODUS_USE_KERNEL
      const kernelErrors = validateFeatureFlags({
        MODUS_USE_KERNEL: false,
        MODUS_PLUGIN_TRACING: true,
      });
      expect(kernelErrors).toContain(
        "MODUS_PLUGIN_TRACING requires MODUS_USE_KERNEL to be enabled",
      );
    });

    it("initializes tracing, health monitor, and failure correlation in PiSdkRuntime when flag enabled", () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_CAPABILITY_REGISTRY: true,
        MODUS_PLUGINS: true,
        MODUS_PLUGIN_TRACING: true,
      });

      const runtime = new PiSdkRuntime();
      expect(runtime.getPluginInstrumentation()).toBeDefined();
      expect(runtime.getPluginHealthMonitor()).toBeDefined();
      expect(runtime.getPluginFailureCorrelation()).toBeDefined();
    });
  });

  describe("12.6 — Fase 12 review regressions", () => {
    it("records error trace and rethrows intact when fn throws synchronously", async () => {
      const instrumentation = new PluginInstrumentation();
      const boom = new Error("sync explode");

      await expect(
        instrumentation.trace("@p/sync", "c", () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      const traces = instrumentation.getRecentTraces("@p/sync");
      expect(traces.length).toBe(1);
      expect(traces[0]?.status).toBe("error");
      expect(traces[0]?.error).toContain("sync explode");
    });
  });
});
