import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiSdkRuntime } from "../../pi-sdk-runtime";
import { CapabilityRegistry } from "../capability/capability-registry";
import {
  resetFeatureFlagOverrides,
  setFeatureFlagOverrides,
  validateFeatureFlags,
} from "../feature-flags";
import { DependencyGraph } from "./dependency-graph";
import { executePluginCli } from "./plugin-cli";
import { CircularDependencyError, type PluginUpdate } from "./plugin-dependency-types";
import { PluginLifecycleService } from "./plugin-lifecycle-service";
import { PluginLoader } from "./plugin-loader";
import { PluginStateStore } from "./plugin-state-store";
import { TestPluginCatalog } from "./plugin-test-catalog";
import { PluginDependencyError, PluginLifecycleError, type PluginManifest } from "./plugin-types";
import { UpdatePlanner } from "./update-planner";

const runtimeElectronState = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => runtimeElectronState.userData } }));

describe("Fase 14 — Dependency Intelligence", () => {
  let db: DatabaseSync;
  let store: PluginStateStore;
  let registry: CapabilityRegistry;
  let loader: PluginLoader;
  let service: PluginLifecycleService;
  let catalog: TestPluginCatalog;

  const mockImpl = { execute: () => ({ success: true }) };
  const mockPerms = { required: {} };

  const baseMemoryPlugin: PluginManifest = {
    id: "@modus/memory",
    name: "Memory Plugin",
    version: "1.0.0",
    author: "Modus Team",
    description: "Provides memory capabilities",
    trustLevel: "core",
    provides: [{ capability: "memory.query", apiVersion: "1.0", implementation: mockImpl }],
    requires: { modus: ">=0.8.0" },
    permissions: mockPerms,
  };

  const modelRouterPlugin: PluginManifest = {
    id: "@modus/model-router",
    name: "Model Router",
    version: "1.0.0",
    author: "Modus Team",
    description: "Routes models",
    trustLevel: "core",
    provides: [{ capability: "model.route", apiVersion: "1.0", implementation: mockImpl }],
    requires: { modus: ">=0.8.0" },
    permissions: mockPerms,
  };

  const contextEnginePlugin: PluginManifest = {
    id: "@modus/context-engine",
    name: "Context Engine",
    version: "1.0.0",
    author: "Modus Team",
    description: "Builds context",
    trustLevel: "core",
    provides: [{ capability: "context.build", apiVersion: "1.0", implementation: mockImpl }],
    requires: {
      modus: ">=0.8.0",
      capabilities: [{ capability: "memory.query", version: "^1.0" }],
      plugins: ["@modus/model-router"],
    },
    permissions: mockPerms,
  };

  const verifierPlugin: PluginManifest = {
    id: "@modus/verifier",
    name: "Verifier Plugin",
    version: "1.0.0",
    author: "Modus Team",
    description: "Verifies steps",
    trustLevel: "core",
    provides: [{ capability: "verification.check", apiVersion: "1.0", implementation: mockImpl }],
    requires: {
      modus: ">=0.8.0",
      capabilities: [{ capability: "context.build", version: "^1.0" }],
    },
    permissions: mockPerms,
  };

  const hyperplanPlugin: PluginManifest = {
    id: "@modus/hyperplan",
    name: "Hyperplan Plugin",
    version: "1.0.0",
    author: "Modus Team",
    description: "Creates execution plans",
    trustLevel: "core",
    provides: [{ capability: "plan.generate", apiVersion: "1.0", implementation: mockImpl }],
    requires: {
      modus: ">=0.8.0",
      capabilities: [{ capability: "context.build", version: "^1.0" }],
    },
    permissions: mockPerms,
  };

  beforeEach(() => {
    resetFeatureFlagOverrides();
    db = new DatabaseSync(":memory:");
    store = new PluginStateStore(db);
    registry = new CapabilityRegistry();
    catalog = new TestPluginCatalog();
    for (const manifest of [
      baseMemoryPlugin,
      modelRouterPlugin,
      contextEnginePlugin,
      verifierPlugin,
      hyperplanPlugin,
    ]) {
      catalog.add(manifest);
    }
    loader = new PluginLoader(registry, catalog);
    service = new PluginLifecycleService(store, loader, registry);
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    try {
      store.close();
    } catch {
      // Ignored if already closed
    }
  });

  describe("14.1 — Dependency Graph Construction & Links", () => {
    it("correctly maps capability provisions and requirements to plugin dependencies", () => {
      const graph = new DependencyGraph();
      graph.addPlugin(baseMemoryPlugin);
      graph.addPlugin(modelRouterPlugin);
      graph.addPlugin(contextEnginePlugin);

      const memNode = graph.getPlugin("@modus/memory");
      const routerNode = graph.getPlugin("@modus/model-router");
      const ctxNode = graph.getPlugin("@modus/context-engine");

      expect(memNode).toBeDefined();
      expect(routerNode).toBeDefined();
      expect(ctxNode).toBeDefined();

      // context-engine depends on memory (via capability memory.query) and model-router (via plugin requirement)
      expect(ctxNode?.dependencies).toContain("@modus/memory");
      expect(ctxNode?.dependencies).toContain("@modus/model-router");

      // memory and model-router have context-engine as dependent
      expect(memNode?.dependents).toContain("@modus/context-engine");
      expect(routerNode?.dependents).toContain("@modus/context-engine");
    });

    it("updates links when plugins are removed or rebuilt", () => {
      const graph = new DependencyGraph();
      graph.rebuild([baseMemoryPlugin, modelRouterPlugin, contextEnginePlugin]);

      expect(graph.getPlugin("@modus/memory")?.dependents).toContain("@modus/context-engine");

      graph.removePlugin("@modus/context-engine");
      expect(graph.getPlugin("@modus/memory")?.dependents).toHaveLength(0);
      expect(graph.getPlugin("@modus/context-engine")).toBeUndefined();
    });
  });

  describe("14.2 — Blast Radius Calculation", () => {
    it("computes direct and transitive blast radius accurately", () => {
      const graph = new DependencyGraph();
      graph.rebuild([
        baseMemoryPlugin,
        modelRouterPlugin,
        contextEnginePlugin,
        verifierPlugin,
        hyperplanPlugin,
      ]);

      const blast = graph.calculateBlastRadius("@modus/memory");

      expect(blast.targetPluginId).toBe("@modus/memory");
      // Direct dependent: @modus/context-engine
      expect(blast.directDependents).toEqual(["@modus/context-engine"]);

      // Transitive dependents: @modus/verifier and @modus/hyperplan (both depend on context-engine)
      const transitiveIds = blast.transitiveDependents.map((t) => t.pluginId);
      expect(transitiveIds).toContain("@modus/verifier");
      expect(transitiveIds).toContain("@modus/hyperplan");

      expect(blast.totalAffected).toBe(3);
      expect(blast.severity).toBe("medium");
      expect(blast.critical).toBe(true);
    });

    it("returns none severity for standalone leaf plugin with no dependents", () => {
      const graph = new DependencyGraph();
      graph.rebuild([baseMemoryPlugin, modelRouterPlugin, contextEnginePlugin, verifierPlugin]);

      const blast = graph.calculateBlastRadius("@modus/verifier");
      expect(blast.totalAffected).toBe(0);
      expect(blast.severity).toBe("none");
      expect(blast.critical).toBe(false);
      expect(blast.directDependents).toHaveLength(0);
      expect(blast.transitiveDependents).toHaveLength(0);
    });
  });

  describe("14.3 — Circular Dependency Detection & Topological Sort", () => {
    it("detects direct circular dependency and identifies the cycle", () => {
      const graph = new DependencyGraph();

      const pluginA: PluginManifest = {
        id: "plugin-a",
        name: "A",
        version: "1.0.0",
        author: "T",
        description: "A",
        trustLevel: "community",
        provides: [{ capability: "cap.a", apiVersion: "1.0", implementation: mockImpl }],
        requires: { modus: ">=0.8.0", plugins: ["plugin-b"] },
        permissions: mockPerms,
      };

      const pluginB: PluginManifest = {
        id: "plugin-b",
        name: "B",
        version: "1.0.0",
        author: "T",
        description: "B",
        trustLevel: "community",
        provides: [{ capability: "cap.b", apiVersion: "1.0", implementation: mockImpl }],
        requires: { modus: ">=0.8.0", plugins: ["plugin-a"] },
        permissions: mockPerms,
      };

      graph.rebuild([pluginA, pluginB]);
      expect(graph.hasCycles()).toBe(true);

      const cycles = graph.findCycles();
      expect(cycles.length).toBeGreaterThan(0);
      expect(cycles[0]).toContain("plugin-a");
      expect(cycles[0]).toContain("plugin-b");

      expect(() => graph.topologicalSort()).toThrow(CircularDependencyError);
    });

    it("produces valid topological sort order when graph is acyclic", () => {
      const graph = new DependencyGraph();
      graph.rebuild([baseMemoryPlugin, modelRouterPlugin, contextEnginePlugin, verifierPlugin]);

      expect(graph.hasCycles()).toBe(false);
      const sorted = graph.topologicalSort();

      // Dependencies must appear before dependents
      const memIndex = sorted.indexOf("@modus/memory");
      const ctxIndex = sorted.indexOf("@modus/context-engine");
      const verIndex = sorted.indexOf("@modus/verifier");

      expect(memIndex).toBeLessThan(ctxIndex);
      expect(ctxIndex).toBeLessThan(verIndex);
    });

    it("sorts unrelated dependency chains while excluding quarantined cycles", () => {
      const cycleA: PluginManifest = {
        ...baseMemoryPlugin,
        id: "@test/quarantined-cycle-a",
        requires: { modus: ">=0.8.0", plugins: ["@test/quarantined-cycle-b"] },
      };
      const cycleB: PluginManifest = {
        ...modelRouterPlugin,
        id: "@test/quarantined-cycle-b",
        requires: { modus: ">=0.8.0", plugins: [cycleA.id] },
      };
      const provider: PluginManifest = {
        ...baseMemoryPlugin,
        id: "@test/unrelated-provider",
        requires: { modus: ">=0.8.0" },
      };
      const dependent: PluginManifest = {
        ...contextEnginePlugin,
        id: "@test/unrelated-dependent",
        requires: { modus: ">=0.8.0", plugins: [provider.id] },
      };
      const graph = new DependencyGraph();
      graph.rebuild([dependent, cycleA, cycleB, provider]);
      const cyclicIds = new Set(graph.findCycles().flat());

      const order = graph.topologicalSortExcluding(cyclicIds);

      expect(order).not.toContain(cycleA.id);
      expect(order).not.toContain(cycleB.id);
      expect(order.indexOf(provider.id)).toBeLessThan(order.indexOf(dependent.id));
    });

    it("rejects lifecycle installation that would introduce a dependency cycle", async () => {
      const pluginA: PluginManifest = {
        id: "@test/lifecycle-cycle-a",
        name: "Cycle A",
        version: "1.0.0",
        author: "Tests",
        description: "Synthetic lifecycle graph fixture",
        trustLevel: "core",
        provides: [{ capability: "cycle.a", apiVersion: "1.0", implementation: mockImpl }],
        requires: { modus: ">=0.8.0", plugins: ["@test/lifecycle-cycle-b"] },
        permissions: mockPerms,
      };
      const pluginB: PluginManifest = {
        ...pluginA,
        id: "@test/lifecycle-cycle-b",
        name: "Cycle B",
        provides: [{ capability: "cycle.b", apiVersion: "1.0", implementation: mockImpl }],
        requires: { modus: ">=0.8.0", plugins: ["@test/lifecycle-cycle-a"] },
      };
      catalog.add(pluginA);
      catalog.add(pluginB);

      await service.install(pluginA);
      await expect(service.install(pluginB)).rejects.toThrow(CircularDependencyError);

      expect(store.getPlugin(pluginB.id)).toBeNull();
      expect(service.getDependencyGraph().hasCycles()).toBe(false);
    });

    it("allows forced removal of a quarantined participant from a persisted dependency cycle", async () => {
      const cycleA: PluginManifest = {
        id: "@test/persisted-cycle-a",
        name: "Persisted Cycle A",
        version: "1.0.0",
        author: "Tests",
        description: "Synthetic persisted cycle recovery fixture",
        trustLevel: "core",
        provides: [
          { capability: "persisted-cycle.a", apiVersion: "1.0", implementation: mockImpl },
        ],
        requires: { modus: ">=0.8.0", plugins: ["@test/persisted-cycle-b"] },
        permissions: mockPerms,
      };
      const cycleB: PluginManifest = {
        ...cycleA,
        id: "@test/persisted-cycle-b",
        name: "Persisted Cycle B",
        provides: [
          { capability: "persisted-cycle.b", apiVersion: "1.0", implementation: mockImpl },
        ],
        requires: { modus: ">=0.8.0", plugins: [cycleA.id] },
      };
      catalog.add(cycleA);
      catalog.add(cycleB);
      const now = new Date().toISOString();
      for (const manifest of [cycleA, cycleB]) {
        store.savePlugin({
          id: manifest.id,
          version: manifest.version,
          state: "enabled",
          trust_level: "core",
          installed_at: now,
          last_enabled: now,
          config: null,
        });
      }

      await service.syncOnStartup();
      expect(store.getPlugin(cycleA.id)?.state).toBe("error");
      expect(store.getPlugin(cycleB.id)?.state).toBe("error");
      expect(loader.getPlugin(cycleA.id)).toBeUndefined();

      await service.uninstall(cycleA.id, { force: true });

      expect(store.getPlugin(cycleA.id)).toBeNull();
      expect(store.getPluginUninstallTombstone(cycleA.id)?.version).toBe(cycleA.version);
      expect(store.getPlugin(cycleB.id)?.state).toBe("error");
      expect(service.getDependencyGraph().hasCycles()).toBe(false);
      expect(loader.getPlugin(cycleB.id)).toBeUndefined();
    });

    it("rejects a plugin that directly requires itself", async () => {
      const selfDependent: PluginManifest = {
        id: "@test/self-dependent",
        name: "Self dependent",
        version: "1.0.0",
        author: "Tests",
        description: "Synthetic direct self-cycle fixture",
        trustLevel: "core",
        provides: [{ capability: "self.dependent", apiVersion: "1.0", implementation: mockImpl }],
        requires: { modus: ">=0.8.0", plugins: ["@test/self-dependent"] },
        permissions: mockPerms,
      };
      catalog.add(selfDependent);

      await expect(service.install(selfDependent)).rejects.toThrow(CircularDependencyError);

      expect(store.getPlugin(selfDependent.id)).toBeNull();
      expect(service.getDependencyGraph().getPlugin(selfDependent.id)).toBeUndefined();
    });

    it("rejects malformed capability version constraints before registering a provider", async () => {
      registry.registerCapability({
        id: "dependency.range.base",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: { description: "Synthetic dependency version fixture" },
      });
      const invalidRangePlugin: PluginManifest = {
        id: "@test/invalid-capability-range",
        name: "Invalid range",
        version: "1.0.0",
        author: "Tests",
        description: "Synthetic version validation fixture",
        trustLevel: "core",
        provides: [
          { capability: "dependency.range.output", apiVersion: "1.0", implementation: mockImpl },
        ],
        requires: {
          modus: ">=0.8.0",
          capabilities: [{ capability: "dependency.range.base", version: "not a range" }],
        },
        permissions: mockPerms,
      };
      catalog.add(invalidRangePlugin);

      await expect(service.install(invalidRangePlugin)).rejects.toThrow(
        /invalid capability version constraint/i,
      );
      expect(store.getPlugin(invalidRangePlugin.id)).toBeNull();
      await expect(loader.load(invalidRangePlugin)).rejects.toThrow(
        /invalid capability version constraint/i,
      );
      expect(registry.listProviders("dependency.range.output")).toHaveLength(0);
    });

    it("rejects provider upgrades that break a dependent capability range", async () => {
      await service.install(baseMemoryPlugin);
      await service.install(contextEnginePlugin);
      const incompatibleMemory: PluginManifest = {
        ...baseMemoryPlugin,
        version: "2.0.0",
        provides: [{ capability: "memory.query", apiVersion: "2.0", implementation: mockImpl }],
      };
      catalog.add(incompatibleMemory);

      await expect(service.upgrade(incompatibleMemory)).rejects.toThrow(PluginDependencyError);
      expect(store.getPlugin(baseMemoryPlugin.id)?.version).toBe("1.0.0");
      expect(service.getDependencyGraph().getPlugin(baseMemoryPlugin.id)?.version).toBe("1.0.0");
    });

    it("rehydrates dependency links before lifecycle changes after restart", async () => {
      await service.install(baseMemoryPlugin);
      await service.install(contextEnginePlugin);

      const restartedRegistry = new CapabilityRegistry();
      const restartedService = new PluginLifecycleService(
        store,
        new PluginLoader(restartedRegistry, catalog),
        restartedRegistry,
      );
      await restartedService.syncOnStartup();

      const incompatibleMemory: PluginManifest = {
        ...baseMemoryPlugin,
        version: "2.0.0",
        provides: [{ capability: "memory.query", apiVersion: "2.0", implementation: mockImpl }],
      };
      catalog.add(incompatibleMemory);

      await expect(restartedService.upgrade(incompatibleMemory)).rejects.toThrow(
        PluginDependencyError,
      );
      expect(store.getPlugin(baseMemoryPlugin.id)?.version).toBe("1.0.0");
    });

    it("rejects a cycle-forming install against dependency links restored after restart", async () => {
      const pluginA: PluginManifest = {
        id: "@test/restarted-cycle-a",
        name: "Restarted cycle A",
        version: "1.0.0",
        author: "Tests",
        description: "Persisted graph fixture",
        trustLevel: "core",
        provides: [
          { capability: "restarted-cycle.a", apiVersion: "1.0", implementation: mockImpl },
        ],
        requires: { modus: ">=0.8.0", plugins: ["@test/restarted-cycle-b"] },
        permissions: mockPerms,
      };
      const pluginB: PluginManifest = {
        ...pluginA,
        id: "@test/restarted-cycle-b",
        name: "Restarted cycle B",
        provides: [
          { capability: "restarted-cycle.b", apiVersion: "1.0", implementation: mockImpl },
        ],
        requires: { modus: ">=0.8.0", plugins: ["@test/restarted-cycle-a"] },
      };
      catalog.add(pluginA);
      catalog.add(pluginB);
      await service.install(pluginA);

      const restartedService = new PluginLifecycleService(store, loader, registry);
      await restartedService.syncOnStartup();

      await expect(restartedService.install(pluginB)).rejects.toThrow(CircularDependencyError);
      expect(store.getPlugin(pluginB.id)).toBeNull();
    });
  });

  describe("14.4 — Topological Update Planner & Phase Parallelization", () => {
    it("plans updates in topological dependency phases with parallel grouping", () => {
      const graph = new DependencyGraph();
      graph.rebuild([baseMemoryPlugin, modelRouterPlugin, contextEnginePlugin, verifierPlugin]);

      const planner = new UpdatePlanner();
      const updates: PluginUpdate[] = [
        { pluginId: "@modus/verifier", currentVersion: "1.0.0", targetVersion: "1.1.0" },
        { pluginId: "@modus/memory", currentVersion: "1.0.0", targetVersion: "1.1.0" },
        { pluginId: "@modus/model-router", currentVersion: "1.0.0", targetVersion: "1.2.0" },
        { pluginId: "@modus/context-engine", currentVersion: "1.0.0", targetVersion: "1.3.0" },
      ];

      const plan = planner.planUpdates(updates, graph);

      expect(plan.totalUpdates).toBe(4);
      expect(plan.phases.length).toBeGreaterThanOrEqual(2);

      // Phase 1 must contain memory and model-router (independent roots) in parallel
      const phase1Ids = plan.phases[0]!.map((u) => u.pluginId);
      expect(phase1Ids).toContain("@modus/memory");
      expect(phase1Ids).toContain("@modus/model-router");

      // Subsequent phases must contain context-engine then verifier
      const laterPhases = plan.phases.slice(1).flatMap((p) => p.map((u) => u.pluginId));
      expect(laterPhases.indexOf("@modus/context-engine")).toBeLessThan(
        laterPhases.indexOf("@modus/verifier"),
      );
    });
  });

  describe("14.5 — Accidental Uninstall Prevention & CLI Commands", () => {
    it("blocks uninstall of a plugin that has active dependents unless forced", async () => {
      await service.install(baseMemoryPlugin);
      await service.install(modelRouterPlugin);
      await service.install(contextEnginePlugin);
      await service.install(verifierPlugin);
      await service.enable(baseMemoryPlugin.id);
      await service.enable(modelRouterPlugin.id);
      await service.enable(contextEnginePlugin.id);
      await service.enable(verifierPlugin.id);

      // Attempting to uninstall memory without force must throw
      await expect(service.uninstall("@modus/memory")).rejects.toThrow(PluginLifecycleError);
      await expect(service.uninstall("@modus/memory")).rejects.toThrow(
        /is required by @modus\/context-engine/,
      );

      // Still installed
      expect(store.getPlugin("@modus/memory")).not.toBeNull();

      const unrelatedCycleA: PluginManifest = {
        id: "@test/unrelated-cycle-a",
        name: "Unrelated cycle A",
        version: "1.0.0",
        author: "Tests",
        description: "Synthetic unrelated cycle fixture",
        trustLevel: "core",
        provides: [
          { capability: "unrelated-cycle.a", apiVersion: "1.0", implementation: mockImpl },
        ],
        requires: { modus: ">=0.8.0", plugins: ["@test/unrelated-cycle-b"] },
        permissions: mockPerms,
      };
      const unrelatedCycleB: PluginManifest = {
        ...unrelatedCycleA,
        id: "@test/unrelated-cycle-b",
        name: "Unrelated cycle B",
        provides: [
          { capability: "unrelated-cycle.b", apiVersion: "1.0", implementation: mockImpl },
        ],
        requires: { modus: ">=0.8.0", plugins: [unrelatedCycleA.id] },
      };
      service
        .getDependencyGraph()
        .rebuild([
          baseMemoryPlugin,
          modelRouterPlugin,
          contextEnginePlugin,
          verifierPlugin,
          unrelatedCycleA,
          unrelatedCycleB,
        ]);

      await service.uninstall("@modus/memory", { force: true });
      expect(store.getPlugin("@modus/memory")).toBeNull();
      expect(store.getPlugin("@modus/context-engine")?.state).toBe("disabled");
      expect(store.getPlugin("@modus/verifier")?.state).toBe("disabled");
      await expect(service.enable("@modus/context-engine")).rejects.toThrow(/no active provider/i);
    });

    it("restores the provider and its dependents when forced uninstall cannot commit deletion", async () => {
      await service.install(baseMemoryPlugin);
      await service.install(modelRouterPlugin);
      await service.install(contextEnginePlugin);
      await service.install(verifierPlugin);
      await service.enable(baseMemoryPlugin.id);
      await service.enable(modelRouterPlugin.id);
      await service.enable(contextEnginePlugin.id);
      await service.enable(verifierPlugin.id);
      const deletePlugin = store.deletePlugin.bind(store);
      const deleteSpy = vi.spyOn(store, "deletePlugin").mockImplementation((pluginId) => {
        if (pluginId === baseMemoryPlugin.id) throw new Error("durable uninstall failed");
        deletePlugin(pluginId);
      });

      await expect(service.uninstall(baseMemoryPlugin.id, { force: true })).rejects.toThrow(
        "durable uninstall failed",
      );

      expect(store.getPlugin(baseMemoryPlugin.id)?.state).toBe("enabled");
      expect(loader.getPlugin(baseMemoryPlugin.id)?.status).toBe("enabled");
      expect(registry.isProviderQuarantined(baseMemoryPlugin.id)).toBe(false);
      expect((await service.status(contextEnginePlugin.id))?.state).toBe("enabled");
      expect((await service.status(verifierPlugin.id))?.state).toBe("enabled");
      await expect(registry.execute("memory.query", {})).resolves.toBeDefined();
      deleteSpy.mockRestore();
    });

    it("restores forced-uninstall dependents in topological order", async () => {
      const providerA = baseMemoryPlugin;
      const providerB: PluginManifest = {
        id: "@test/order-b",
        name: "Order B",
        version: "1.0.0",
        author: "Tests",
        description: "Synthetic dependent ordering fixture",
        trustLevel: "core",
        provides: [{ capability: "order.b", apiVersion: "1.0", implementation: mockImpl }],
        requires: {
          modus: ">=0.8.0",
          capabilities: [{ capability: "memory.query", version: "^1.0" }],
        },
        permissions: mockPerms,
      };
      const dependentC: PluginManifest = {
        id: "@test/order-c",
        name: "Order C",
        version: "1.0.0",
        author: "Tests",
        description: "Synthetic dependent ordering fixture",
        trustLevel: "core",
        provides: [{ capability: "order.c", apiVersion: "1.0", implementation: mockImpl }],
        requires: {
          modus: ">=0.8.0",
          capabilities: [{ capability: "memory.query", version: "^1.0" }],
          plugins: [providerB.id],
        },
        permissions: mockPerms,
      };
      catalog.add(providerB);
      catalog.add(dependentC);

      await service.install(providerA);
      await service.install(dependentC);
      await service.install(providerB);
      await service.enable(providerA.id);
      await service.enable(providerB.id);
      await service.enable(dependentC.id);
      expect(
        service.getDependencyGraph().calculateBlastRadius(providerA.id).directDependents,
      ).toEqual([dependentC.id, providerB.id]);

      const deletePlugin = store.deletePlugin.bind(store);
      const deleteSpy = vi.spyOn(store, "deletePlugin").mockImplementation((pluginId) => {
        if (pluginId === providerA.id) throw new Error("durable uninstall failed");
        deletePlugin(pluginId);
      });

      await expect(service.uninstall(providerA.id, { force: true })).rejects.toThrow(
        "durable uninstall failed",
      );

      expect((await service.status(providerB.id))?.state).toBe("enabled");
      expect((await service.status(dependentC.id))?.state).toBe("enabled");
      deleteSpy.mockRestore();
    });

    it("restores loaded runtime-only dependents after forced uninstall fails", async () => {
      const runtimeDependent: PluginManifest = {
        id: "@test/runtime-only-dependent",
        name: "Runtime only dependent",
        version: "1.0.0",
        author: "Tests",
        description: "Synthetic loaded dependent without a persisted plugin row",
        trustLevel: "core",
        provides: [
          {
            capability: "runtime.only.dependent",
            apiVersion: "1.0",
            implementation: { execute: async () => "active" },
          },
        ],
        requires: {
          modus: ">=0.8.0",
          capabilities: [{ capability: "memory.query", version: "^1.0" }],
        },
        permissions: mockPerms,
      };
      catalog.add(runtimeDependent);
      registry.registerCapability({
        id: "runtime.only.dependent",
        apiVersion: "1.0",
        replaceable: true,
        dependencies: [],
        metadata: { description: "Synthetic runtime-only dependent fixture" },
      });
      await service.install(baseMemoryPlugin);
      await service.enable(baseMemoryPlugin.id);
      await loader.load(runtimeDependent);
      await loader.enable(runtimeDependent.id);
      expect(store.getPlugin(runtimeDependent.id)).toBeNull();

      await service.syncOnStartup();
      expect(
        service.getDependencyGraph().calculateBlastRadius(baseMemoryPlugin.id).directDependents,
      ).toContain(runtimeDependent.id);

      const deletePlugin = store.deletePlugin.bind(store);
      const deleteSpy = vi.spyOn(store, "deletePlugin").mockImplementation((pluginId) => {
        if (pluginId === baseMemoryPlugin.id) throw new Error("durable uninstall failed");
        deletePlugin(pluginId);
      });

      await expect(service.uninstall(baseMemoryPlugin.id, { force: true })).rejects.toThrow(
        "durable uninstall failed",
      );

      expect(loader.getPlugin(runtimeDependent.id)?.status).toBe("enabled");
      expect(registry.isProviderQuarantined(runtimeDependent.id)).toBe(false);
      await expect(registry.execute("runtime.only.dependent", {})).resolves.toBe("active");
      deleteSpy.mockRestore();
    });

    it("executes blast-radius CLI command and outputs structured report", async () => {
      await service.install(baseMemoryPlugin);
      await service.install(modelRouterPlugin);
      await service.install(contextEnginePlugin);

      const cliResult = await executePluginCli(["blast-radius", "@modus/memory"], service);

      expect(cliResult.success).toBe(true);
      expect(cliResult.command).toBe("blast-radius");
      expect(cliResult.output).toContain("Removing @modus/memory would affect:");
      expect(cliResult.output).toContain("Direct dependents:");
      expect(cliResult.output).toContain("@modus/context-engine");
      expect(cliResult.output).toContain("Severity: LOW");
    });

    it("executes blast-radius CLI with --json option", async () => {
      await service.install(baseMemoryPlugin);
      await service.install(contextEnginePlugin);

      const cliResult = await executePluginCli(
        ["blast-radius", "@modus/memory", "--json"],
        service,
      );

      expect(cliResult.success).toBe(true);
      const parsed = JSON.parse(cliResult.output);
      expect(parsed.targetPluginId).toBe("@modus/memory");
      expect(parsed.directDependents).toContain("@modus/context-engine");
    });

    it("executes tree CLI command displaying ASCII dependency structure", async () => {
      await service.install(baseMemoryPlugin);
      await service.install(contextEnginePlugin);

      const cliResult = await executePluginCli(["tree"], service);
      expect(cliResult.success).toBe(true);
      expect(cliResult.output).toContain("@modus/memory@1.0.0");
      expect(cliResult.output).toContain("provides: memory.query");
      expect(cliResult.output).toContain("required by:");
      expect(cliResult.output).toContain("@modus/context-engine");
    });

    it("executes plan-updates CLI command", async () => {
      await service.install(baseMemoryPlugin);
      await service.install(contextEnginePlugin);

      const cliResult = await executePluginCli(
        ["plan-updates", "@modus/memory@1.1.0", "@modus/context-engine@1.3.0"],
        service,
      );
      expect(cliResult.success).toBe(true);
      expect(cliResult.output).toContain("Update plan:");
      expect(cliResult.output).toContain("Phase 1");
      expect(cliResult.output).toContain("@modus/memory 1.0.0");
      expect(cliResult.output).toContain("Estimated duration:");
    });

    it("rejects plan-updates CLI without explicit targets instead of inventing versions", async () => {
      await service.install(baseMemoryPlugin);

      const cliResult = await executePluginCli(["plan-updates"], service);
      expect(cliResult.success).toBe(false);
      expect(cliResult.error).toContain("Missing update targets");
    });
  });

  describe("14.7 — Fase 14 review regressions: graph freshness & planner totality", () => {
    const capManifest = (version: string, provides: string[]): PluginManifest => ({
      id: "@test/svc",
      name: "Svc",
      version,
      author: "Test",
      description: "Test",
      trustLevel: "official",
      provides: provides.map((capability) => ({
        capability,
        apiVersion: "1.0",
        implementation: { execute: async () => ({}) },
      })),
      requires: { modus: ">=0.8.0" },
      permissions: { required: {} },
    });

    it("refreshes the graph node on downgrade instead of keeping the rolled-back version", async () => {
      const v1 = capManifest("1.0.0", ["cap.a"]);
      const v2 = capManifest("2.0.0", ["cap.b"]);
      catalog.add(v1);
      catalog.add(v2);
      await service.install(v1);
      await service.enable("@test/svc");
      await service.upgrade(v2);
      expect(service.getDependencyGraph().getPlugin("@test/svc")?.provides).toEqual(["cap.b"]);

      await service.downgrade("@test/svc", "1.0.0");

      const node = service.getDependencyGraph().getPlugin("@test/svc");
      expect(node?.version).toBe("1.0.0");
      expect(node?.provides).toEqual(["cap.a"]);
    });

    it("retains host catalog resolution after uninstall", async () => {
      const manifest = capManifest("1.0.0", ["cap.a"]);
      catalog.add(manifest);
      await service.install(manifest);
      await service.uninstall("@test/svc");

      const descriptor = loader.authorizeManifest(manifest).manifest;
      expect(service.resolveManifest("@test/svc", "1.0.0")).toBe(descriptor);
      expect(service.resolveManifest("@test/svc")).toBe(descriptor);
      expect(descriptor.provides[0]).not.toHaveProperty("implementation");
    });

    it("plans updates across cyclic graphs without throwing", () => {
      const graph = new DependencyGraph();
      const mk = (id: string, req: string[]): PluginManifest => ({
        id,
        name: id,
        version: "1.0.0",
        author: "T",
        description: "T",
        trustLevel: "community",
        provides: [
          { capability: `cap.${id}`, apiVersion: "1.0", implementation: { execute: () => ({}) } },
        ],
        requires: { modus: ">=0.8.0", plugins: req },
        permissions: { required: {} },
      });
      graph.rebuild([mk("a", ["b"]), mk("b", ["a"])]);
      expect(graph.hasCycles()).toBe(true);

      const planner = new UpdatePlanner();
      const plan = planner.planUpdates(
        [
          { pluginId: "a", currentVersion: "1.0.0", targetVersion: "1.1.0" },
          { pluginId: "b", currentVersion: "1.0.0", targetVersion: "1.1.0" },
        ],
        graph,
      );
      expect(plan.totalUpdates).toBe(2);
      expect(plan.phases.length).toBeGreaterThan(0);
      expect(plan.phases.flat().length).toBe(2);
    });
  });

  describe("14.6 — Feature Flags & Runtime Integration", () => {
    it("validates feature flag dependencies for MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE", () => {
      const errors = validateFeatureFlags({
        MODUS_USE_KERNEL: true,
        MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE: true,
        MODUS_PLUGINS: false,
      });
      expect(errors).toContain(
        "MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE requires MODUS_PLUGINS to be enabled",
      );

      const kernelErrors = validateFeatureFlags({
        MODUS_USE_KERNEL: false,
        MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE: true,
      });
      expect(kernelErrors).toContain(
        "MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE requires MODUS_USE_KERNEL to be enabled",
      );
    });

    it("does not expose the mutable dependency graph through PiSdkRuntime", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_CAPABILITY_REGISTRY: true,
        MODUS_PLUGINS: true,
        MODUS_PLUGIN_LIFECYCLE: true,
        MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE: true,
      });

      const userData = mkdtempSync(join(tmpdir(), "modus-plugin-dependency-runtime-"));
      runtimeElectronState.userData = userData;
      let runtime: PiSdkRuntime | undefined;
      try {
        runtime = new PiSdkRuntime();
        await runtime.waitForPlugins();
        expect("getDependencyGraph" in runtime).toBe(false);
      } finally {
        await runtime?.closePluginLifecycleStore();
        rmSync(userData, { recursive: true, force: true });
      }
    });
  });
});
