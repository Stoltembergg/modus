import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiSdkRuntime } from "../../pi-sdk-runtime";
import { HOST_CAPABILITY_REGISTRATION_AUTHORITY } from "../capability/capability-registration-authority";
import { CapabilityRegistry, resetCapabilityRegistry } from "../capability/capability-registry";
import {
  CapabilityConflictError,
  CapabilityUnavailableError,
} from "../capability/capability-types";
import { registerCoreCapabilities } from "../capability/core-capabilities";
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "../feature-flags";
import { bootstrapModusPlugins } from "./bootstrap";
import type { PluginManifestCatalog } from "./plugin-catalog";
import { BUILT_IN_PLUGIN_ENTRIES, createPluginManifestDescriptor } from "./plugin-catalog";
import { PluginLoader } from "./plugin-loader";
import { PluginStateStore } from "./plugin-state-store";
import { TestPluginCatalog } from "./plugin-test-catalog";
import type { PluginManifest } from "./plugin-types";
import { PluginDependencyError, PluginLifecycleError, PluginValidationError } from "./plugin-types";
import { type ContextItem, contextEnginePluginManifest } from "./plugins/context-engine-plugin";
import { failureIntelPluginManifest } from "./plugins/failure-intel-plugin";
import { groupsPluginManifest } from "./plugins/groups-plugin";
import { memoryPluginManifest, memoryStore } from "./plugins/memory-plugin";
import { modelRouterPluginManifest } from "./plugins/model-router-plugin";
import { verifierPluginManifest } from "./plugins/verifier-plugin";

const runtimeElectronState = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => runtimeElectronState.userData } }));

describe("Fase 10 — Modus Internal Plugins", () => {
  let registry: CapabilityRegistry;
  let loader: PluginLoader;
  let catalog: TestPluginCatalog;

  beforeEach(() => {
    resetCapabilityRegistry();
    memoryStore.clear();
    registry = new CapabilityRegistry();
    catalog = new TestPluginCatalog();
    for (const manifest of [
      memoryPluginManifest,
      modelRouterPluginManifest,
      contextEnginePluginManifest,
      verifierPluginManifest,
      failureIntelPluginManifest,
      groupsPluginManifest,
    ]) {
      catalog.add(manifest, "core");
    }
    loader = new PluginLoader(registry, catalog);
    registerCoreCapabilities(registry);
    resetFeatureFlagOverrides();
  });

  describe("10.1 — Plugin Manifest & Descriptor Validation", () => {
    it("rejects executable manifests from catalogs without host-registered provenance", async () => {
      const onLoad = vi.fn();
      const manifest: PluginManifest = {
        id: "@test/unregistered-trust-catalog",
        name: "Unregistered trust catalog fixture",
        version: "1.0.0",
        author: "test",
        description: "The catalog's self-declared trust must not authorize execution",
        trustLevel: "core",
        provides: [
          {
            capability: "test.unregistered-trust",
            apiVersion: "1.0",
            implementation: { execute: () => "must not execute" },
          },
        ],
        requires: { modus: "*" },
        permissions: { required: {} },
        lifecycle: { onLoad },
      };
      const unregisteredCatalog: PluginManifestCatalog = {
        authorize(input) {
          return input.id === manifest.id && input.version === manifest.version
            ? { manifest: createPluginManifestDescriptor(manifest), trustLevel: "core" }
            : undefined;
        },
        resolve: () => undefined,
      };
      const untrustedLoader = new PluginLoader(registry, unregisteredCatalog);

      const loadError = await untrustedLoader.load(manifest).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect({
        rejected: loadError instanceof PluginValidationError,
        lifecycleHookCalled: onLoad.mock.calls.length > 0,
        activeProviderId: registry.getActiveProvider("test.unregistered-trust")?.providerId,
      }).toEqual({ rejected: true, lifecycleHookCalled: false, activeProviderId: undefined });
    });

    it("does not expose executable references in loader results or host manifests", async () => {
      const manifest: PluginManifest = {
        id: "@test/no-executable-escape",
        name: "No executable escape fixture",
        version: "1.0.0",
        author: "test",
        description: "Exercises the loader metadata boundary",
        trustLevel: "official",
        provides: [
          {
            capability: "memory.retrieve",
            apiVersion: "1.0",
            implementation: { execute: () => "through dispatcher" },
            config: { visible: true, hiddenFunction: () => "must not escape" },
          },
        ],
        requires: { modus: ">=0.8.0" },
        permissions: { required: {} },
        lifecycle: { onLoad: () => undefined },
      };
      catalog.add(manifest);

      const loaded = await loader.load(manifest);
      const fromGetter = loader.getPlugin(manifest.id);
      const fromList = loader.listPlugins().find((plugin) => plugin.manifest.id === manifest.id);
      const fromCatalog = loader.resolveHostManifest(manifest.id, manifest.version);
      if (!fromCatalog) throw new Error("Expected the host catalog manifest descriptor.");

      for (const result of [loaded, fromGetter, fromList]) {
        expect(result).toBeDefined();
        expect(result).not.toHaveProperty("implementations");
        expect(result?.manifest).not.toHaveProperty("lifecycle");
        expect(result?.manifest.provides[0]).not.toHaveProperty("implementation");
      }
      expect(fromCatalog?.provides[0]?.config).toEqual({ visible: true });
      expect(fromCatalog).not.toHaveProperty("lifecycle");
      expect(fromCatalog?.provides[0]).not.toHaveProperty("implementation");
      expect(loader.authorizeManifest(manifest).manifest).toBe(fromCatalog);
      const forgedDescriptor = { ...fromCatalog, name: "forged descriptor" };
      expect(() => loader.authorizeManifest(forgedDescriptor)).toThrow(PluginValidationError);
      await expect(registry.execute("memory.retrieve", {})).resolves.toBe("through dispatcher");
    });

    it("does not request unused permissions or dependencies from built-in adapters", () => {
      for (const manifest of [
        memoryPluginManifest,
        modelRouterPluginManifest,
        verifierPluginManifest,
        contextEnginePluginManifest,
      ]) {
        expect(manifest.permissions.required, manifest.id).toEqual({});
      }

      for (const manifest of [
        contextEnginePluginManifest,
        failureIntelPluginManifest,
        groupsPluginManifest,
        verifierPluginManifest,
      ]) {
        expect(manifest.requires.capabilities ?? [], manifest.id).toEqual([]);
      }
    });

    it("validates a correct manifest without error", () => {
      expect(() => loader.validateManifest(memoryPluginManifest)).not.toThrow();
    });

    it("rejects manifest without valid id", () => {
      const invalid = { ...memoryPluginManifest, id: "" };
      expect(() => loader.validateManifest(invalid)).toThrow(PluginValidationError);
    });

    it("rejects manifest with invalid trustLevel", () => {
      const invalid = { ...memoryPluginManifest, trustLevel: "untrusted" as any };
      expect(() => loader.validateManifest(invalid)).toThrow(PluginValidationError);
    });

    it("rejects manifest with empty provides", () => {
      const invalid = { ...memoryPluginManifest, provides: [] };
      expect(() => loader.validateManifest(invalid)).toThrow(PluginValidationError);
    });

    it("rejects manifest with missing provision implementation", () => {
      const invalid: any = {
        ...memoryPluginManifest,
        provides: [
          {
            capability: "memory.retrieve",
            apiVersion: "1.0",
            implementation: undefined,
          },
        ],
      };
      expect(() => loader.validateManifest(invalid)).toThrow(PluginValidationError);
    });
  });

  it("rejects a self-declared core clone before provider registration or hooks", async () => {
    const onLoad = vi.fn();
    const execute = vi.fn();
    const providersBefore = registry.listProviders("memory.retrieve");
    const forged = {
      ...memoryPluginManifest,
      trustLevel: "core" as const,
      lifecycle: { onLoad },
      provides: memoryPluginManifest.provides.map((item) => ({
        ...item,
        implementation: { execute },
      })),
    };

    await expect(loader.load(forged)).rejects.toThrow(PluginValidationError);
    expect(onLoad).not.toHaveBeenCalled();
    expect(registry.listProviders("memory.retrieve")).toEqual(providersBefore);
    expect(registry.listProviders("memory.retrieve")[0]).not.toHaveProperty("implementation");
  });

  describe("10.2 — Dependency Checking & Resolution", () => {
    it("succeeds when a plugin has no capability dependencies", () => {
      expect(() => loader.checkDependencies(verifierPluginManifest)).not.toThrow();
    });

    it("throws PluginDependencyError if a required capability is missing from the registry", () => {
      const emptyRegistry = new CapabilityRegistry();
      const emptyLoader = new PluginLoader(emptyRegistry);
      const dependentPlugin: PluginManifest = {
        ...verifierPluginManifest,
        requires: {
          ...verifierPluginManifest.requires,
          capabilities: [{ capability: "missing.capability", version: "^1.0" }],
        },
      };

      expect(() => emptyLoader.checkDependencies(dependentPlugin)).toThrow(PluginDependencyError);
    });

    it("throws PluginDependencyError if a required plugin is missing or inactive", () => {
      const pluginWithReq: PluginManifest = {
        id: "@test/dependent",
        name: "Dependent Plugin",
        version: "1.0.0",
        author: "Test",
        description: "Test",
        trustLevel: "local",
        provides: [
          {
            capability: "memory.retrieve",
            apiVersion: "1.0",
            implementation: { execute: () => [] },
          },
        ],
        requires: {
          modus: ">=0.8.0",
          plugins: ["@test/nonexistent-plugin"],
        },
        permissions: { required: {} },
      };

      expect(() => loader.checkDependencies(pluginWithReq)).toThrow(PluginDependencyError);
    });
  });

  describe("10.3 — Phase 10A Piloto 1: @modus/memory (Unavailable synthetic provider)", () => {
    it("does not present an in-memory map as durable project memory", async () => {
      await loader.load(memoryPluginManifest);
      const loaded = loader.getPlugin("@modus/memory");
      expect(loaded).toBeDefined();
      expect(loaded?.status).toBe("loaded");

      await expect(registry.execute("memory.store", {})).rejects.toThrow(
        CapabilityUnavailableError,
      );
      await expect(registry.execute("memory.retrieve", {})).rejects.toThrow(
        CapabilityUnavailableError,
      );
      await expect(registry.execute("memory.compact", {})).rejects.toThrow(
        CapabilityUnavailableError,
      );
    });
  });

  describe("10.4 — Phase 10A Piloto 2: @modus/model-router (Stateless Capability)", () => {
    it("loads @modus/model-router and routes tasks dynamically", async () => {
      await loader.load(modelRouterPluginManifest);

      // 1. Complexity never selects a replacement model for the session.
      const complexSelect = await registry.execute<any, any>("model.select", {
        task: "Refactor entire distributed messaging layer",
        complexity: "complex",
      });
      expect(complexSelect.selectedModel).toBeUndefined();
      expect(complexSelect.fallbackModel).toBeUndefined();

      // 2. A simple task also leaves selection to the session default.
      const simpleSelect = await registry.execute<any, any>("model.select", {
        task: "Print hello world",
        complexity: "simple",
      });
      expect(simpleSelect.selectedModel).toBeUndefined();
      expect(simpleSelect.fallbackModel).toBeUndefined();

      // 3. Explicit preference respected
      const customSelect = await registry.execute<any, any>("model.select", {
        task: "General coding",
        preferredModel: "deepseek-v3",
      });
      expect(customSelect.selectedModel).toBe("deepseek-v3");
      expect(customSelect.fallbackModel).toBe("deepseek-v3");

      // Routing targets are not wired to the user's session/provider selection.
      await expect(
        registry.execute("model.route", {
          task: "Build plan and spec verification",
          complexity: "complex",
        }),
      ).rejects.toThrow(CapabilityUnavailableError);
    });
  });

  describe("10.5 — Phase 10A Piloto 3: @modus/verifier (Complex Orchestration)", () => {
    it("loads @modus/verifier and assesses verification criteria", async () => {
      await loader.load(verifierPluginManifest);

      // Caller-supplied status claims do not carry execution evidence.
      const verifiedRes = await registry.execute<any, any>("verification.assess", {
        sessionId: "sess-1",
        runId: "run-1",
        required: true,
        checks: [
          { id: "1", name: "unit-tests", status: "passed" },
          { id: "2", name: "typecheck", status: "passed" },
        ],
      });
      expect(verifiedRes.status).toBe("unknown");
      expect(verifiedRes.passedCount).toBe(0);
      expect(verifiedRes.missingCount).toBe(2);

      // 2. Any failed -> failed
      const failedRes = await registry.execute<any, any>("verification.assess", {
        sessionId: "sess-1",
        runId: "run-1",
        required: true,
        checks: [
          { id: "1", name: "unit-tests", status: "passed" },
          { id: "2", name: "typecheck", status: "failed" },
        ],
      });
      expect(failedRes.status).toBe("unknown");
      expect(failedRes.failedCount).toBe(0);
      expect(failedRes.missingCount).toBe(2);

      // 3. Run checks
      const checks = await registry.execute<any, any>("verification.run", {
        checks: [{ name: "vitest", command: "npm test" }],
      });
      expect(checks.length).toBe(1);
      expect(checks[0]).not.toHaveProperty("id");
      expect(checks[0].status).toBe("unavailable");

      const noQa = await registry.execute<any, any>("verification.assess", {
        sessionId: "sess-1",
        runId: "run-1",
        required: false,
        checks: [],
      });
      expect(noQa.status).toBe("not_required");
    });
  });

  describe("10.6 — Phase 10B: Additional Internal Plugins (@modus/context-engine, @modus/failure-intel, @modus/groups)", () => {
    it("loads and executes @modus/context-engine", async () => {
      await loader.load(contextEnginePluginManifest);

      await expect(
        registry.execute("context.resolve", {
          query: "authentication security flow",
        }),
      ).rejects.toThrow(CapabilityUnavailableError);

      const filtered = await registry.execute<
        { items: ContextItem[]; maxTokens: number },
        { filtered: ContextItem[]; droppedCount: number }
      >("context.filter", {
        items: [
          {
            key: "fixture",
            source: "test",
            content: "small synthetic fixture",
            tokenCount: 150,
            priority: 1,
          },
        ],
        maxTokens: 50,
      });
      expect(filtered.droppedCount).toBe(1);
      expect(filtered.filtered.length).toBe(0);
    });

    it("does not present heuristic failure examples as runtime intelligence", async () => {
      await loader.load(failureIntelPluginManifest);

      await expect(
        registry.execute("failure.classify", {
          error: "SyntaxError: Unexpected token in JSON at position 42",
        }),
      ).rejects.toThrow(CapabilityUnavailableError);
      await expect(
        registry.execute("failure.recover", {
          error: "SyntaxError",
          attempts: 1,
        }),
      ).rejects.toThrow(CapabilityUnavailableError);
    });

    it("does not return success from the in-memory group mailbox or coordinator", async () => {
      await loader.load(groupsPluginManifest);

      await expect(
        registry.execute("groups.mailbox", {
          action: "post",
          sender: "architect",
          recipient: "coder",
          body: "Implement auth module",
        }),
      ).rejects.toThrow(CapabilityUnavailableError);
      await expect(
        registry.execute("groups.coordinate", {
          groupId: "fixture",
          members: ["agent-a", "agent-b"],
        }),
      ).rejects.toThrow(CapabilityUnavailableError);
    });
  });

  describe("10.7 — Plugin Lifecycle Management (Enable/Disable/Unload)", () => {
    it("toggles plugin lifecycle states cleanly", async () => {
      let loadCount = 0;
      let enableCount = 0;
      let disableCount = 0;
      let unloadCount = 0;

      const lifecyclePlugin: PluginManifest = {
        id: "@test/lifecycle",
        name: "Lifecycle Tester",
        version: "1.0.0",
        author: "Test",
        description: "Test",
        trustLevel: "local",
        provides: [
          {
            capability: "memory.retrieve",
            apiVersion: "1.0",
            implementation: { execute: () => ["lifecycle-res"] },
          },
        ],
        requires: { modus: ">=0.8.0" },
        permissions: { required: {} },
        lifecycle: {
          onLoad: () => {
            loadCount++;
          },
          onEnable: () => {
            enableCount++;
          },
          onDisable: () => {
            disableCount++;
          },
          onUnload: () => {
            unloadCount++;
          },
        },
      };

      catalog.add(lifecyclePlugin);
      await loader.load(lifecyclePlugin);
      expect(loadCount).toBe(1);

      await loader.enable("@test/lifecycle");
      expect(enableCount).toBe(1);
      expect(loader.getPlugin("@test/lifecycle")?.status).toBe("enabled");

      await loader.disable("@test/lifecycle");
      expect(disableCount).toBe(1);
      expect(loader.getPlugin("@test/lifecycle")?.status).toBe("disabled");

      await loader.unload("@test/lifecycle");
      expect(unloadCount).toBe(1);
      expect(loader.getPlugin("@test/lifecycle")).toBeUndefined();
    });
  });

  describe("10.8 — Built-in Bootstrap Sequence", () => {
    it("loads all 6 Modus internal plugins in catalog order", async () => {
      const freshRegistry = new CapabilityRegistry();
      const result = await bootstrapModusPlugins(freshRegistry);

      expect(result.loadedPlugins).toEqual([
        "@modus/memory",
        "@modus/model-router",
        "@modus/context-engine",
        "@modus/verifier",
        "@modus/failure-intelligence",
        "@modus/groups",
      ]);

      expect(result.loader.listPlugins().length).toBe(6);

      // Verify all active providers point to our loaded internal plugins
      expect(freshRegistry.getActiveProvider("memory.retrieve")?.providerId).toBe("@modus/memory");
      expect(freshRegistry.getActiveProvider("model.select")?.providerId).toBe(
        "@modus/model-router",
      );
      expect(freshRegistry.getActiveProvider("context.resolve")?.providerId).toBe(
        "@modus/context-engine",
      );
      expect(freshRegistry.getActiveProvider("verification.assess")?.providerId).toBe(
        "@modus/verifier",
      );
      expect(freshRegistry.getActiveProvider("failure.classify")?.providerId).toBe(
        "@modus/failure-intelligence",
      );
      expect(freshRegistry.getActiveProvider("groups.mailbox")?.providerId).toBe("@modus/groups");
    });
  });

  describe("10.9 — PiSdkRuntime Integration & Feature Flags", () => {
    it("bootstraps built-in plugins after opening durable state", async () => {
      setFeatureFlagOverrides({
        MODUS_CAPABILITY_REGISTRY: true,
        MODUS_PLUGINS: true,
        MODUS_PLUGIN_LIFECYCLE: true,
      });

      const userData = mkdtempSync(join(tmpdir(), "modus-plugin-capabilities-"));
      runtimeElectronState.userData = userData;
      const loadPlugin = vi.spyOn(PluginLoader.prototype, "load");
      const runtime = new PiSdkRuntime();
      let store: PluginStateStore | undefined;
      try {
        await runtime.waitForPlugins();
        const loaded = await Promise.all(loadPlugin.mock.results.map(({ value }) => value));
        expect(loaded.map((plugin) => plugin.manifest.id).sort()).toEqual(
          BUILT_IN_PLUGIN_ENTRIES.map(({ manifest }) => manifest.id).sort(),
        );

        // Read the durable host state through a separately owned store. The runtime
        // deliberately exposes no mutable loader, registry, or store accessor.
        store = new PluginStateStore(join(userData, "plugins.db"));
        const plugins = store.listPlugins();
        expect(plugins).toHaveLength(6);
        expect(plugins.every((plugin) => plugin.state === "enabled")).toBe(true);
      } finally {
        loadPlugin.mockRestore();
        store?.close();
        await runtime.closePluginLifecycleStore();
        rmSync(userData, { recursive: true, force: true });
      }
    });
  });

  describe("10.10 — Fase 10 review regressions: truthful lifecycle & version checks", () => {
    const echoPlugin: PluginManifest = {
      id: "@test/echo",
      name: "Echo",
      version: "1.0.0",
      author: "Test",
      description: "Test",
      trustLevel: "local",
      provides: [
        {
          capability: "memory.retrieve",
          apiVersion: "1.0",
          implementation: { execute: async () => ["echo-result"] },
        },
      ],
      requires: { modus: ">=0.8.0" },
      permissions: { required: {} },
    };

    it("unload removes providers and falls back to an explicit unavailable provider", async () => {
      catalog.add(echoPlugin);
      await loader.load(echoPlugin);
      await loader.enable("@test/echo");
      expect(registry.getActiveProvider("memory.retrieve")?.providerId).toBe("@test/echo");

      await loader.unload("@test/echo");

      expect(registry.listProviders("memory.retrieve").length).toBe(1);
      expect(registry.getActiveProvider("memory.retrieve")?.providerId).toBe("@modus/memory");
      // The core placeholder must not turn the missing implementation into success.
      await expect(registry.execute("memory.retrieve", { query: "x" })).rejects.toThrow(
        CapabilityUnavailableError,
      );
    });

    it("disable steps the provider down and enable reactivates it", async () => {
      catalog.add(echoPlugin);
      await loader.load(echoPlugin);
      await loader.enable("@test/echo");
      expect(registry.getActiveProvider("memory.retrieve")?.providerId).toBe("@test/echo");

      await loader.disable("@test/echo");
      expect(loader.getPlugin("@test/echo")?.status).toBe("disabled");
      expect(registry.getActiveProvider("memory.retrieve")?.providerId).toBe("@modus/memory");

      await loader.enable("@test/echo");
      expect(registry.getActiveProvider("memory.retrieve")?.providerId).toBe("@test/echo");
    });

    it("rolls back all registrations when onLoad fails without clearing quarantine", async () => {
      const failing: PluginManifest = {
        ...echoPlugin,
        id: "@test/load-failure",
        provides: [
          {
            capability: "test.transaction.created",
            apiVersion: "1.0",
            implementation: { execute: () => "partial" },
          },
        ],
        lifecycle: {
          onLoad: () => {
            throw new Error("load failed");
          },
        },
      };
      catalog.add(failing, "official");
      registry.quarantineProvider(failing.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      await expect(loader.load(failing)).rejects.toThrow("onLoad lifecycle hook failed");

      expect(registry.getCapability("test.transaction.created")).toBeUndefined();
      expect(registry.listProviders("test.transaction.created")).toEqual([]);
      expect(registry.isProviderQuarantined(failing.id)).toBe(true);
    });

    it("restores a pre-existing same-ID provider when its replacement load fails", async () => {
      registry.registerProvider(
        {
          providerId: "@test/preexisting",
          providerVersion: "0.9.0",
          capabilityId: "memory.retrieve",
          capabilityApiVersion: "1.0",
          trustLevel: "official",
          permissions: {},
          implementation: { execute: () => ["original"] },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );
      registry.activateProvider("memory.retrieve", "@test/preexisting");
      const failing: PluginManifest = {
        ...echoPlugin,
        id: "@test/preexisting",
        lifecycle: {
          onLoad: () => {
            throw new Error("load failed");
          },
        },
      };
      catalog.add(failing, "official");

      await expect(loader.load(failing)).rejects.toThrow("onLoad lifecycle hook failed");

      expect(await registry.execute("memory.retrieve", {})).toEqual(["original"]);
    });

    it("rejects a concurrent load for the same plugin ID and releases the reservation after failure", async () => {
      const pluginId = "@test/concurrent-load";
      let enterHook!: () => void;
      let rejectHook!: (error: Error) => void;
      const hookEntered = new Promise<void>((resolve) => {
        enterHook = resolve;
      });
      const hookGate = new Promise<void>((_resolve, reject) => {
        rejectHook = reject;
      });
      let hookCalls = 0;
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [
          {
            capability: "test.transaction.concurrent",
            apiVersion: "1.0",
            implementation: { execute: () => "loaded" },
          },
        ],
        lifecycle: {
          onLoad: () => {
            hookCalls += 1;
            if (hookCalls === 1) {
              enterHook();
              return hookGate;
            }
            return undefined;
          },
        },
      };
      catalog.add(manifest, "official");

      const firstLoad = loader.load(manifest);
      await hookEntered;
      await expect(loader.load(manifest)).rejects.toThrow("already loading");
      rejectHook(new Error("first load failed"));
      await expect(firstLoad).rejects.toThrow("onLoad lifecycle hook failed");

      await expect(loader.load(manifest)).resolves.toMatchObject({ status: "loaded" });
      expect(await registry.execute("test.transaction.concurrent", {})).toBe("loaded");
    });

    it("shares the in-flight plugin ID reservation across loaders for one registry", async () => {
      const pluginId = "@test/cross-loader-concurrent-load";
      const capability = "test.transaction.cross-loader";
      let enterHook!: () => void;
      let rejectHook!: (error: Error) => void;
      const hookEntered = new Promise<void>((resolve) => {
        enterHook = resolve;
      });
      const hookGate = new Promise<void>((_resolve, reject) => {
        rejectHook = reject;
      });
      let hookCalls = 0;
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [{ capability, apiVersion: "1.0", implementation: { execute: () => "loaded" } }],
        lifecycle: {
          onLoad: () => {
            hookCalls += 1;
            if (hookCalls === 1) {
              enterHook();
              return hookGate;
            }
            return undefined;
          },
        },
      };
      catalog.add(manifest, "official");
      const secondLoader = new PluginLoader(registry, catalog);

      const firstLoad = loader.load(manifest);
      await hookEntered;
      await expect(secondLoader.load(manifest)).rejects.toThrow("already loading");
      rejectHook(new Error("first load failed"));
      await expect(firstLoad).rejects.toThrow("onLoad lifecycle hook failed");

      await expect(secondLoader.load(manifest)).resolves.toMatchObject({ status: "loaded" });
      expect(await registry.execute(capability, {})).toBe("loaded");
    });

    it("shares loaded plugin ownership across loaders for one registry", async () => {
      const pluginId = "@test/cross-loader-loaded-owner";
      const capability = "test.transaction.cross-loader-loaded";
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [
          { capability, apiVersion: "1.0", implementation: { execute: () => "original" } },
        ],
      };
      catalog.add(manifest, "official");
      const secondLoader = new PluginLoader(registry, catalog);

      const loaded = await loader.load(manifest);

      await expect(secondLoader.load(manifest)).rejects.toThrow("already loaded");
      expect(secondLoader.getPlugin(pluginId)).toBe(loaded);
      expect(secondLoader.listPlugins()).toContain(loaded);
      expect(await registry.execute(capability, {})).toBe("original");
    });

    it("refuses to clear shared ownership while a loaded provider is live", async () => {
      const pluginId = "@test/clear-live-plugin";
      const capability = "test.transaction.clear-live";
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [
          { capability, apiVersion: "1.0", implementation: { execute: () => "still serving" } },
        ],
      };
      catalog.add(manifest, "official");
      const secondLoader = new PluginLoader(registry, catalog);
      const loaded = await loader.load(manifest);

      expect(() => secondLoader.clear()).toThrow(PluginLifecycleError);

      expect(loader.getPlugin(pluginId)).toBe(loaded);
      expect(secondLoader.getPlugin(pluginId)).toBe(loaded);
      expect(await registry.execute(capability, {})).toBe("still serving");
    });

    it("serializes cross-loader unloads and blocks reload until unload hooks finish", async () => {
      const pluginId = "@test/cross-loader-unload";
      const capability = "test.transaction.cross-loader-unload";
      let enterHook!: () => void;
      let releaseHook!: () => void;
      const hookEntered = new Promise<void>((resolve) => {
        enterHook = resolve;
      });
      const hookGate = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      let unloadCalls = 0;
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [{ capability, apiVersion: "1.0", implementation: { execute: () => "loaded" } }],
        lifecycle: {
          onUnload: () => {
            unloadCalls += 1;
            if (unloadCalls === 1) {
              enterHook();
              return hookGate;
            }
            return undefined;
          },
        },
      };
      catalog.add(manifest, "official");
      const secondLoader = new PluginLoader(registry, catalog);
      await loader.load(manifest);

      const firstUnload = loader.unload(pluginId);
      await hookEntered;
      await expect(secondLoader.unload(pluginId)).rejects.toThrow("already unloading");
      await expect(secondLoader.load(manifest)).rejects.toThrow("already loaded");

      releaseHook();
      await firstUnload;
      await expect(secondLoader.load(manifest)).resolves.toMatchObject({ status: "loaded" });
    });

    it("blocks unload and clear across loaders while onEnable is pending", async () => {
      const pluginId = "@test/pending-enable";
      const capability = "test.transaction.pending-enable";
      let enterHook!: () => void;
      let releaseHook!: () => void;
      const hookEntered = new Promise<void>((resolve) => {
        enterHook = resolve;
      });
      const hookGate = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [
          { capability, apiVersion: "1.0", implementation: { execute: () => "still owned" } },
        ],
        lifecycle: {
          onEnable: () => {
            enterHook();
            return hookGate;
          },
        },
      };
      catalog.add(manifest, "official");
      const secondLoader = new PluginLoader(registry, catalog);
      const loaded = await loader.load(manifest);

      const enable = loader.enable(pluginId);
      await hookEntered;
      await expect(secondLoader.unload(pluginId)).rejects.toThrow("already enabling");
      expect(() => secondLoader.clear()).toThrow(PluginLifecycleError);
      expect(secondLoader.getPlugin(pluginId)).toBe(loaded);
      expect(await registry.execute(capability, {})).toBe("still owned");

      releaseHook();
      await enable;
      expect(secondLoader.getPlugin(pluginId)?.status).toBe("enabled");
      expect(await registry.execute(capability, {})).toBe("still owned");
    });

    it("rolls back by the authorized ID when the manifest ID changes during onLoad", async () => {
      const authorizedId = "@test/mutated-manifest-id";
      const capability = "test.transaction.mutable-id";
      let enterHook!: () => void;
      let releaseHook!: () => void;
      const hookEntered = new Promise<void>((resolve) => {
        enterHook = resolve;
      });
      const hookGate = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      let hookCalls = 0;
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: authorizedId,
        provides: [{ capability, apiVersion: "1.0", implementation: { execute: () => "loaded" } }],
        lifecycle: {
          onLoad: () => {
            hookCalls += 1;
            if (hookCalls === 1) {
              enterHook();
              return hookGate;
            }
            return undefined;
          },
        },
      };
      catalog.add(manifest, "official");

      const firstLoad = loader.load(manifest);
      await hookEntered;
      manifest.id = "@test/mutated-manifest-id-during-hook";
      releaseHook();

      await expect(firstLoad).rejects.toThrow("manifest identity changed during load");
      expect(registry.getCapability(capability)).toBeUndefined();
      expect(registry.listProviders(capability)).toEqual([]);

      manifest.id = authorizedId;
      await expect(loader.load(manifest)).resolves.toMatchObject({ status: "loaded" });
      expect(await registry.execute(capability, {})).toBe("loaded");
    });

    it("restores the captured executor when a pre-existing implementation is mutated during onLoad", async () => {
      const capability = "test.transaction.executor-snapshot";
      const pluginId = "@test/mutated-executor";
      const originalImplementation = { execute: () => "original" };
      registry.registerCapability({
        id: capability,
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: {},
      });
      registry.registerProvider(
        {
          providerId: pluginId,
          providerVersion: "1",
          capabilityId: capability,
          capabilityApiVersion: "1.0",
          trustLevel: "official",
          permissions: {},
          implementation: originalImplementation,
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );
      registry.activateProvider(capability, pluginId);

      let enterHook!: () => void;
      let rejectHook!: (error: Error) => void;
      const hookEntered = new Promise<void>((resolve) => {
        enterHook = resolve;
      });
      const hookGate = new Promise<void>((_resolve, reject) => {
        rejectHook = reject;
      });
      const failing: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [
          { capability, apiVersion: "1.0", implementation: { execute: () => "replacement" } },
        ],
        lifecycle: {
          onLoad: () => {
            enterHook();
            return hookGate;
          },
        },
      };
      catalog.add(failing, "official");

      const load = loader.load(failing);
      await hookEntered;
      originalImplementation.execute = () => "mutated";
      rejectHook(new Error("load failed"));
      await expect(load).rejects.toThrow("onLoad lifecycle hook failed");

      expect(await registry.execute(capability, {})).toBe("original");
    });

    it("rolls back earlier providers when a later non-replaceable registration fails", async () => {
      const lockedCapability = "test.transaction.locked";
      registry.registerCapability({
        id: lockedCapability,
        apiVersion: "1.0",
        replaceable: false,
        dependencies: [],
        metadata: {},
      });
      registry.registerProvider(
        {
          providerId: "@test/locked-owner",
          providerVersion: "1",
          capabilityId: lockedCapability,
          capabilityApiVersion: "1.0",
          trustLevel: "core",
          permissions: {},
          implementation: { execute: () => "owner" },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );
      const failing: PluginManifest = {
        ...echoPlugin,
        id: "@test/registration-failure",
        provides: [
          {
            capability: "test.transaction.created",
            apiVersion: "1.0",
            implementation: { execute: () => "partial" },
          },
          {
            capability: lockedCapability,
            apiVersion: "1.0",
            implementation: { execute: () => "blocked" },
          },
        ],
      };
      catalog.add(failing, "official");
      registry.quarantineProvider(failing.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      await expect(loader.load(failing)).rejects.toThrow(CapabilityConflictError);

      expect(registry.getCapability("test.transaction.created")).toBeUndefined();
      expect(registry.listProviders("test.transaction.created")).toEqual([]);
      expect(registry.getActiveProvider(lockedCapability)?.providerId).toBe("@test/locked-owner");
      expect(registry.isProviderQuarantined(failing.id)).toBe(true);
    });

    it("preserves the registration error and fully rolls back a mixed same-ID transaction", async () => {
      const replaceableCapability = "test.transaction.replaceable";
      const lockedCapability = "test.transaction.same-id-locked";
      const pluginId = "@test/mixed-registration-failure";
      registry.registerCapability({
        id: replaceableCapability,
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: {},
      });
      registry.registerCapability({
        id: lockedCapability,
        apiVersion: "1.0",
        replaceable: false,
        dependencies: [],
        metadata: {},
      });
      registry.registerProvider(
        {
          providerId: pluginId,
          providerVersion: "1",
          capabilityId: replaceableCapability,
          capabilityApiVersion: "1.0",
          trustLevel: "official",
          permissions: {},
          implementation: { execute: () => "original" },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );
      registry.registerProvider(
        {
          providerId: pluginId,
          providerVersion: "1",
          capabilityId: lockedCapability,
          capabilityApiVersion: "1.0",
          trustLevel: "official",
          permissions: {},
          implementation: { execute: () => "locked owner" },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );
      registry.activateProvider(replaceableCapability, pluginId);
      registry.quarantineProvider("@test/keep-quarantine", HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      const failing: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [
          {
            capability: "test.transaction.created",
            apiVersion: "1.0",
            implementation: { execute: () => "partial" },
          },
          {
            capability: replaceableCapability,
            apiVersion: "1.0",
            implementation: { execute: () => "replacement" },
          },
          {
            capability: lockedCapability,
            apiVersion: "1.0",
            implementation: { execute: () => "different implementation" },
          },
        ],
      };
      catalog.add(failing, "official");

      let thrown: unknown;
      try {
        await loader.load(failing);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CapabilityConflictError);
      expect((thrown as Error).message).toContain("marked non-replaceable");
      expect(registry.getCapability("test.transaction.created")).toBeUndefined();
      expect(registry.listProviders("test.transaction.created")).toEqual([]);
      expect(await registry.execute(replaceableCapability, {})).toBe("original");
      expect(registry.getActiveProvider(lockedCapability)).not.toHaveProperty("implementation");
      expect(await registry.execute(lockedCapability, {})).toBe("locked owner");
      expect(registry.isProviderQuarantined("@test/keep-quarantine")).toBe(true);
      expect(registry.isProviderQuarantined(pluginId)).toBe(false);
    });

    it("rejects capability requirements with incompatible major versions", () => {
      const mismatch: PluginManifest = {
        ...echoPlugin,
        id: "@test/mismatch",
        requires: {
          modus: ">=0.8.0",
          capabilities: [{ capability: "memory.retrieve", version: "^2.0" }],
        },
      };
      expect(() => loader.checkDependencies(mismatch)).toThrow(PluginDependencyError);

      const match: PluginManifest = {
        ...echoPlugin,
        id: "@test/match",
        requires: {
          modus: ">=0.8.0",
          capabilities: [{ capability: "memory.retrieve", version: "^1.0" }],
        },
      };
      expect(() => loader.checkDependencies(match)).not.toThrow();
    });

    it("refuses to remove the last provider of a non-replaceable capability", () => {
      const solo = new CapabilityRegistry();
      solo.registerCapability({
        id: "agent.loop",
        apiVersion: "1.0",
        replaceable: false,
        dependencies: [],
        metadata: {},
      });
      solo.registerProvider(
        {
          providerId: "@modus/core-loop",
          providerVersion: "1.0.0",
          capabilityId: "agent.loop",
          capabilityApiVersion: "1.0",
          trustLevel: "core",
          permissions: {},
          implementation: { execute: () => "loop" },
          registeredAt: new Date(),
          metadata: {},
        },
        HOST_CAPABILITY_REGISTRATION_AUTHORITY,
      );

      expect(() => solo.unregisterProvider("agent.loop", "@modus/core-loop")).toThrow(
        CapabilityConflictError,
      );
      expect(solo.getActiveProvider("agent.loop")?.providerId).toBe("@modus/core-loop");
    });
  });
});
