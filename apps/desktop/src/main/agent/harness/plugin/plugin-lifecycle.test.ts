/**
 * Modus Harness Evolution — Fase 11: Plugin Lifecycle Tests
 * Validates SQLite State Storage (ACID), Lifecycle Service, CLI, and Startup Sync.
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_CAPABILITY_REGISTRATION_AUTHORITY } from "../capability/capability-registration-authority";
import { CapabilityRegistry } from "../capability/capability-registry";
import { executePluginCli } from "./plugin-cli";
import { PluginLifecycleService } from "./plugin-lifecycle-service";
import { PluginLoader } from "./plugin-loader";
import { PluginStateStore } from "./plugin-state-store";
import { TestPluginCatalog } from "./plugin-test-catalog";
import type { PluginManifest } from "./plugin-types";

describe("Fase 11 — Plugin Lifecycle & State Storage", () => {
  let db: DatabaseSync;
  let store: PluginStateStore;
  let registry: CapabilityRegistry;
  let loader: PluginLoader;
  let service: PluginLifecycleService;
  let catalog: TestPluginCatalog;

  const sampleManifestV1: PluginManifest = {
    id: "@modus/smart-cache",
    name: "Smart Cache Plugin",
    version: "1.0.0",
    author: "Modus Team",
    description: "High performance query cache",
    trustLevel: "official",
    provides: [
      {
        capability: "cache.query",
        apiVersion: "1.0.0",
        implementation: {
          execute: async () => ({ hit: true }),
        },
      },
    ],
    requires: {
      modus: ">=0.8.0",
    },
    permissions: {
      required: {
        memory: { read: true, write: true },
      },
    },
  };

  const sampleManifestV2: PluginManifest = {
    id: "@modus/smart-cache",
    name: "Smart Cache Plugin",
    version: "1.2.0",
    author: "Modus Team",
    description: "High performance distributed query cache",
    trustLevel: "official",
    provides: [
      {
        capability: "cache.query",
        apiVersion: "1.0.0",
        implementation: {
          execute: async () => ({ hit: true, version: 2 }),
        },
      },
    ],
    requires: {
      modus: ">=0.8.0",
    },
    permissions: {
      required: {
        memory: { read: true, write: true },
        network: { domains: ["*"] },
      },
    },
  };

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    store = new PluginStateStore(db);
    registry = new CapabilityRegistry();
    catalog = new TestPluginCatalog();
    catalog.add(sampleManifestV1);
    catalog.add(sampleManifestV2);
    loader = new PluginLoader(registry, catalog);
    service = new PluginLifecycleService(store, loader, registry);
  });

  afterEach(() => {
    store.close();
  });

  describe("11.1 - Plugin State Storage (SQLite) & ACID Transactions", () => {
    it("creates all tables defined in Fase 11 schema", () => {
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC`)
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain("plugins");
      expect(tableNames).toContain("plugin_versions");
      expect(tableNames).toContain("plugin_capabilities");
      expect(tableNames).toContain("plugin_permissions");
      expect(tableNames).toContain("plugin_events");
    });

    it("saves and retrieves plugin record", () => {
      const now = new Date().toISOString();
      store.savePlugin({
        id: "@modus/smart-cache",
        version: "1.0.0",
        state: "installed",
        trust_level: "official",
        installed_at: now,
        last_enabled: null,
        config: { maxEntries: 100 },
      });

      const retrieved = store.getPlugin("@modus/smart-cache");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe("@modus/smart-cache");
      expect(retrieved?.version).toBe("1.0.0");
      expect(retrieved?.state).toBe("installed");
      expect(retrieved?.trust_level).toBe("official");
      expect(retrieved?.config).toEqual({ maxEntries: 100 });
    });

    it("rolls back completely when transaction throws an error (ACID atomicity)", () => {
      expect(() => {
        store.transaction(() => {
          store.savePlugin({
            id: "@modus/failed-tx",
            version: "0.1.0",
            state: "installed",
            trust_level: "community",
            installed_at: new Date().toISOString(),
            last_enabled: null,
            config: null,
          });

          // Simulate mid-transaction crash
          throw new Error("Simulated disk/validation failure during write");
        });
      }).toThrow("Simulated disk/validation failure during write");

      // The uncommitted write must NOT be persisted in SQLite
      const plugin = store.getPlugin("@modus/failed-tx");
      expect(plugin).toBeNull();
    });

    it("manages version history and capabilities correctly", () => {
      store.savePlugin({
        id: "@test/p",
        version: "1.0.0",
        state: "installed",
        trust_level: "official",
        installed_at: new Date().toISOString(),
        last_enabled: null,
        config: null,
      });

      store.saveVersion("@test/p", "1.0.0", sampleManifestV1);
      store.saveVersion("@test/p", "1.2.0", sampleManifestV2);

      const versions = store.getVersions("@test/p");
      expect(versions).toHaveLength(2);
      expect(versions.map((v) => v.version)).toContain("1.0.0");
      expect(versions.map((v) => v.version)).toContain("1.2.0");

      store.saveCapabilities("@test/p", [
        { capability: "cap.a", apiVersion: "1.0" },
        { capability: "cap.b", apiVersion: "2.0" },
      ]);
      const caps = store.getCapabilities("@test/p");
      expect(caps).toHaveLength(2);
      expect(caps[0]?.capability_id).toBe("cap.a");

      // Audit event recording
      const event = store.recordEvent("@test/p", "test_event", { key: "val" });
      expect(event.id).toBeGreaterThan(0);
      expect(event.event_type).toBe("test_event");
      expect(event.details).toEqual({ key: "val" });

      const events = store.getEvents("@test/p");
      expect(events).toHaveLength(1);
      expect(events[0]?.event_type).toBe("test_event");
    });
  });

  describe("11.2 - Plugin Lifecycle Service Transitions", () => {
    it("rejects an uncatalogued core manifest before install side effects", async () => {
      const onLoad = vi.fn();
      const forged = { ...sampleManifestV1, trustLevel: "core" as const, lifecycle: { onLoad } };
      await expect(service.install(forged)).rejects.toThrow();
      expect(store.getPlugin(forged.id)).toBeNull();
      expect(registry.listProviders("cache.query")).toHaveLength(0);
      expect(onLoad).not.toHaveBeenCalled();
    });

    it("does not restore a persisted plugin outside the host catalog", async () => {
      const onLoad = vi.fn();
      const untrusted: PluginManifest = {
        ...sampleManifestV1,
        id: "@untrusted/persisted",
        lifecycle: { onLoad },
      };
      const now = new Date().toISOString();
      store.savePlugin({
        id: untrusted.id,
        version: untrusted.version,
        state: "enabled",
        trust_level: "core",
        installed_at: now,
        last_enabled: null,
        config: null,
      });
      store.saveVersion(untrusted.id, untrusted.version, untrusted, now);

      const restored = await service.syncOnStartup();
      expect(restored).not.toContain(untrusted.id);
      expect(loader.getPlugin(untrusted.id)).toBeUndefined();
      expect(registry.listProviders("cache.query")).toHaveLength(0);
      expect(onLoad).not.toHaveBeenCalled();
      expect(store.getPlugin(untrusted.id)?.state).toBe("error");
      expect(store.getEvents(untrusted.id).some((event) => event.event_type === "sync_error")).toBe(
        true,
      );
    });

    it("does not claim a missing persisted version restored when its exact catalog built-in is already loaded", async () => {
      const now = new Date().toISOString();
      await loader.load(sampleManifestV1);
      await loader.enable(sampleManifestV1.id);
      const loadedCanonical = loader.getPlugin(sampleManifestV1.id);
      store.savePlugin({
        id: sampleManifestV1.id,
        version: "9.9.9",
        state: "enabled",
        trust_level: "official",
        installed_at: now,
        last_enabled: null,
        config: null,
      });

      const restored = await service.syncOnStartup();

      expect(restored).not.toContain(sampleManifestV1.id);
      expect(store.getPlugin(sampleManifestV1.id)?.state).toBe("error");
      expect(store.getEvents(sampleManifestV1.id).at(-1)).toMatchObject({
        event_type: "sync_error",
      });
      expect(loader.getPlugin(sampleManifestV1.id)).toBeUndefined();
      expect(loadedCanonical?.status).toBe("unloaded");
      expect(registry.isProviderQuarantined(sampleManifestV1.id)).toBe(true);
    });

    it("unloads a same-ID instance whose manifest identity is absent from the host catalog", async () => {
      const now = new Date().toISOString();
      const uncatalogued = { ...sampleManifestV1, version: "77.0.0" };
      (loader as unknown as { plugins: Map<string, unknown> }).plugins.set(uncatalogued.id, {
        manifest: uncatalogued,
        status: "loaded",
        loadedAt: new Date(),
        implementations: {},
      });
      store.savePlugin({
        id: uncatalogued.id,
        version: "9.9.9",
        state: "enabled",
        trust_level: "official",
        installed_at: now,
        last_enabled: null,
        config: null,
      });

      const restored = await service.syncOnStartup();

      expect(restored).not.toContain(uncatalogued.id);
      expect(loader.getPlugin(uncatalogued.id)).toBeUndefined();
      expect(store.getPlugin(uncatalogued.id)?.state).toBe("error");
    });
    it("installs a plugin into SQLite and live catalog", async () => {
      const record = await service.install(sampleManifestV1, { maxEntries: 50 });
      expect(record.id).toBe("@modus/smart-cache");
      expect(record.version).toBe("1.0.0");
      expect(record.state).toBe("installed");
      expect(record.config).toEqual({ maxEntries: 50 });

      const inStore = store.getPlugin("@modus/smart-cache");
      expect(inStore).not.toBeNull();
      expect(inStore?.state).toBe("installed");

      const versions = store.getVersions("@modus/smart-cache");
      expect(versions).toHaveLength(1);
      expect(versions[0]?.version).toBe("1.0.0");
    });

    it("enables an installed plugin and updates SQLite state", async () => {
      await service.install(sampleManifestV1);
      await service.enable("@modus/smart-cache");

      const plugin = store.getPlugin("@modus/smart-cache");
      expect(plugin?.state).toBe("enabled");
      expect(plugin?.last_enabled).not.toBeNull();

      // Should be active in loader
      const loaded = loader.getPlugin("@modus/smart-cache");
      expect(loaded?.status).toBe("enabled");

      // Capability should be provided in registry
      expect(registry.getCapability("cache.query")).toBeDefined();
      expect(registry.getActiveProvider("cache.query")).toBeDefined();
    });

    it("keeps dispatch quarantined when the enabled-state transaction fails", async () => {
      await service.install(sampleManifestV1);
      const transaction = store.transaction.bind(store);
      vi.spyOn(store, "transaction").mockImplementation(((fn: () => unknown) => {
        throw new Error("commit failed");
      }) as typeof store.transaction);

      await expect(service.enable(sampleManifestV1.id)).rejects.toThrow("commit failed");
      expect(registry.isProviderQuarantined(sampleManifestV1.id)).toBe(true);
      await expect(registry.execute("cache.query", {})).rejects.toThrow();
      vi.mocked(store.transaction).mockRestore();
      expect(transaction).toBeDefined();
    });

    it("disables an active plugin", async () => {
      await service.install(sampleManifestV1);
      await service.enable("@modus/smart-cache");
      await service.disable("@modus/smart-cache");

      const plugin = store.getPlugin("@modus/smart-cache");
      expect(plugin?.state).toBe("disabled");

      const loaded = loader.getPlugin("@modus/smart-cache");
      expect(loaded?.status).toBe("disabled");
    });

    it("upgrades a plugin atomically and hot-reloads it when active", async () => {
      await service.install(sampleManifestV1);
      await service.enable("@modus/smart-cache");

      // Upgrade to v1.2.0
      await service.upgrade(sampleManifestV2);

      const plugin = store.getPlugin("@modus/smart-cache");
      expect(plugin?.version).toBe("1.2.0");
      expect(plugin?.state).toBe("enabled");

      // Version history must preserve both v1.0.0 and v1.2.0
      const versions = store.getVersions("@modus/smart-cache");
      expect(versions).toHaveLength(2);
      expect(versions.map((v) => v.version)).toEqual(["1.2.0", "1.0.0"]);

      // Audit events must reflect upgrade
      const events = store.getEvents("@modus/smart-cache");
      const upgradeEvent = events.find((e) => e.event_type === "upgraded");
      expect(upgradeEvent).toBeDefined();
      expect(upgradeEvent?.details).toEqual({ fromVersion: "1.0.0", toVersion: "1.2.0" });

      // Live loader must have v1.2.0 running
      const loaded = loader.getPlugin("@modus/smart-cache");
      expect(loaded?.manifest.version).toBe("1.2.0");
      expect(loaded?.status).toBe("enabled");
      expect(registry.isProviderQuarantined("@modus/smart-cache")).toBe(false);
      expect(await registry.execute("cache.query", {})).toEqual({ hit: true, version: 2 });
    });

    it("downgrades a plugin to a previously preserved version", async () => {
      await service.install(sampleManifestV1);
      await service.enable("@modus/smart-cache");
      await service.upgrade(sampleManifestV2);

      // Now rollback to v1.0.0
      await service.downgrade("@modus/smart-cache", "1.0.0");

      const plugin = store.getPlugin("@modus/smart-cache");
      expect(plugin?.version).toBe("1.0.0");
      expect(plugin?.state).toBe("enabled");

      const events = store.getEvents("@modus/smart-cache");
      const downgradeEvent = events.find((e) => e.event_type === "downgraded");
      expect(downgradeEvent).toBeDefined();
      expect(downgradeEvent?.details).toEqual({ fromVersion: "1.2.0", toVersion: "1.0.0" });

      const loaded = loader.getPlugin("@modus/smart-cache");
      expect(loaded?.manifest.version).toBe("1.0.0");
      expect(registry.isProviderQuarantined("@modus/smart-cache")).toBe(false);
      expect(await registry.execute("cache.query", {})).toEqual({ hit: true });
    });

    it("uninstalls a plugin completely and marks uninstalled", async () => {
      await service.install(sampleManifestV1);
      await service.enable("@modus/smart-cache");
      await service.uninstall("@modus/smart-cache");

      const plugin = store.getPlugin("@modus/smart-cache");
      expect(plugin).toBeNull();

      const loaded = loader.getPlugin("@modus/smart-cache");
      expect(loaded).toBeUndefined();

      // Capability should no longer have an active provider
      expect(registry.getActiveProvider("cache.query")).toBeUndefined();
    });

    it("generates a comprehensive status report", async () => {
      await service.install(sampleManifestV1);
      await service.enable("@modus/smart-cache");

      const status = await service.status("@modus/smart-cache");
      expect(status).not.toBeNull();
      expect(status?.id).toBe("@modus/smart-cache");
      expect(status?.version).toBe("1.0.0");
      expect(status?.state).toBe("enabled");
      expect(status?.runtimeStatus).toBe("enabled");
      expect(status?.capabilities).toHaveLength(1);
      expect(status?.capabilities[0]?.capability_id).toBe("cache.query");
      expect(status?.availableVersions).toEqual(["1.0.0"]);
      expect(status?.recentEvents.length).toBeGreaterThanOrEqual(2); // installed, enabled
    });

    it("synchronizes enabled plugins on startup (syncOnStartup)", async () => {
      // Seed SQLite with an enabled plugin
      await service.install(sampleManifestV1);
      await service.enable("@modus/smart-cache");

      // Create a fresh loader and service simulating application restart
      const freshRegistry = new CapabilityRegistry();
      const freshCatalog = new TestPluginCatalog();
      freshCatalog.add(sampleManifestV1);
      const freshLoader = new PluginLoader(freshRegistry, freshCatalog);
      const freshService = new PluginLifecycleService(store, freshLoader, freshRegistry);

      // Register manifest in fresh service catalog
      freshService.registerManifest(sampleManifestV1);

      // Verify fresh loader does not yet have it loaded
      expect(freshLoader.getPlugin("@modus/smart-cache")).toBeUndefined();

      // Boot synchronization
      const restored = await freshService.syncOnStartup();
      expect(restored).toContain("@modus/smart-cache");

      // Now it must be loaded and enabled
      const loaded = freshLoader.getPlugin("@modus/smart-cache");
      expect(loaded?.status).toBe("enabled");
      expect(freshRegistry.getCapability("cache.query")).toBeDefined();
      expect(freshRegistry.getActiveProvider("cache.query")).toBeDefined();
    });

    it("reconciles an already-loaded same-ID plugin to the exact persisted host-catalog version", async () => {
      await service.install(sampleManifestV1);
      store.updatePluginState(sampleManifestV1.id, "enabled");

      // Simulate an unrelated/stale runtime instance already occupying the ID.
      await loader.load(sampleManifestV2);
      expect(loader.getPlugin(sampleManifestV1.id)?.manifest.version).toBe("1.2.0");

      const restored = await service.syncOnStartup();

      expect(restored).toContain(sampleManifestV1.id);
      expect(loader.getPlugin(sampleManifestV1.id)?.manifest).toBe(sampleManifestV1);
      expect(loader.getPlugin(sampleManifestV1.id)?.manifest.version).toBe("1.0.0");
      expect(store.getPlugin(sampleManifestV1.id)?.state).toBe("enabled");
    });

    it("quarantines an unresolved persisted version before failing cleanup and clears only after exact recovery", async () => {
      let failDisable = true;
      const onEnable = vi.fn();
      const manifest: PluginManifest = {
        ...sampleManifestV1,
        id: "@test/quarantine-recovery",
        provides: [
          {
            capability: "quarantine.recovery",
            apiVersion: "1.0.0",
            implementation: { execute: () => "old" },
          },
        ],
        lifecycle: {
          onDisable: async () => {
            if (failDisable) throw new Error("cleanup failed");
          },
          onEnable,
        },
      };
      catalog.add(manifest);
      await service.install(manifest);
      await service.enable(manifest.id);
      store.savePlugin({ ...store.getPlugin(manifest.id)!, version: "9.9.9", state: "enabled" });

      expect(await registry.execute("quarantine.recovery", {})).toBe("old");
      expect(await service.syncOnStartup()).not.toContain(manifest.id);
      expect(store.getPlugin(manifest.id)?.state).toBe("error");
      expect(store.getEvents(manifest.id).some((event) => event.event_type === "sync_error")).toBe(
        true,
      );
      await expect(registry.execute("quarantine.recovery", {})).rejects.toThrow();
      expect(registry.isProviderQuarantined(manifest.id)).toBe(true);
      expect(() => registry.activateProvider("quarantine.recovery", manifest.id)).toThrow();
      expect(() => registry.switchProvider("quarantine.recovery", manifest.id)).toThrow();
      const callsBeforeDirectEnable = onEnable.mock.calls.length;
      await expect(loader.enable(manifest.id)).rejects.toThrow();
      expect(onEnable).toHaveBeenCalledTimes(callsBeforeDirectEnable);
      expect(registry.isProviderQuarantined(manifest.id)).toBe(true);
      await expect(registry.execute("quarantine.recovery", {})).rejects.toThrow();

      failDisable = false;
      store.savePlugin({
        ...store.getPlugin(manifest.id)!,
        version: manifest.version,
        state: "enabled",
      });
      expect(await service.syncOnStartup()).toContain(manifest.id);
      expect(registry.isProviderQuarantined(manifest.id)).toBe(false);
      expect(await registry.execute("quarantine.recovery", {})).toBe("old");

      registry.quarantineProvider(manifest.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      await service.enable(manifest.id);
      expect(registry.isProviderQuarantined(manifest.id)).toBe(false);
      expect(await registry.execute("quarantine.recovery", {})).toBe("old");
    });

    it("keeps partial onLoad registration quarantined after startup failure", async () => {
      const manifest: PluginManifest = {
        ...sampleManifestV1,
        id: "@test/onload-fails",
        provides: [
          {
            capability: "startup.partial",
            apiVersion: "1.0.0",
            implementation: { execute: () => "partial" },
          },
        ],
        lifecycle: {
          onLoad: async () => {
            throw new Error("load hook failed");
          },
        },
      };
      catalog.add(manifest);
      const now = new Date().toISOString();
      store.savePlugin({
        id: manifest.id,
        version: manifest.version,
        state: "enabled",
        trust_level: "official",
        installed_at: now,
        last_enabled: null,
        config: null,
      });

      await service.syncOnStartup();

      expect(store.getPlugin(manifest.id)?.state).toBe("error");
      expect(registry.isProviderQuarantined(manifest.id)).toBe(true);
      await expect(registry.execute("startup.partial", {})).rejects.toThrow();
      await expect(loader.enable(manifest.id)).rejects.toThrow();
      expect(registry.isProviderQuarantined(manifest.id)).toBe(true);
    });
  });

  describe("11.3 - CLI Command Handler Execution", () => {
    it('handles "list" and "list --enabled" and "list --json"', async () => {
      await service.install(sampleManifestV1);

      // Unfiltered list
      const res1 = await executePluginCli(["list"], service);
      expect(res1.success).toBe(true);
      expect(res1.output).toContain("@modus/smart-cache");

      // Enabled only (none enabled yet)
      const res2 = await executePluginCli(["list", "--enabled"], service);
      expect(res2.success).toBe(true);
      expect(res2.output).toBe("No plugins found.");

      // Enable and check json
      await service.enable("@modus/smart-cache");
      const res3 = await executePluginCli(["list", "--json"], service);
      expect(res3.success).toBe(true);
      const parsed = JSON.parse(res3.output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].id).toBe("@modus/smart-cache");
    });

    it('handles "status <plugin-id>"', async () => {
      await service.install(sampleManifestV1);
      await service.enable("@modus/smart-cache");

      const res = await executePluginCli(["status", "@modus/smart-cache"], service);
      expect(res.success).toBe(true);
      expect(res.output).toContain("Plugin: @modus/smart-cache");
      expect(res.output).toContain("State: enabled");
      expect(res.output).toContain("cache.query");
    });

    it('handles "install <manifest-json>" and "install <catalog-id>"', async () => {
      service.registerManifest(sampleManifestV1);

      const res = await executePluginCli(["install", "@modus/smart-cache"], service);
      expect(res.success).toBe(true);
      expect(res.output).toContain("Plugin '@modus/smart-cache' v1.0.0 installed successfully.");

      const plugin = store.getPlugin("@modus/smart-cache");
      expect(plugin).not.toBeNull();
    });

    it('handles "enable", "disable", and "uninstall" commands', async () => {
      await service.install(sampleManifestV1);

      const enableRes = await executePluginCli(["enable", "@modus/smart-cache"], service);
      expect(enableRes.success).toBe(true);
      expect(enableRes.output).toContain("enabled successfully");

      const disableRes = await executePluginCli(["disable", "@modus/smart-cache"], service);
      expect(disableRes.success).toBe(true);
      expect(disableRes.output).toContain("disabled successfully");

      const uninstallRes = await executePluginCli(["uninstall", "@modus/smart-cache"], service);
      expect(uninstallRes.success).toBe(true);
      expect(uninstallRes.output).toContain("uninstalled successfully");
      expect(store.getPlugin("@modus/smart-cache")).toBeNull();
    });

    it('handles "upgrade" and "downgrade" commands via CLI', async () => {
      await service.install(sampleManifestV1);
      service.registerManifest(sampleManifestV2);

      // CLI Upgrade
      const upRes = await executePluginCli(["upgrade", "@modus/smart-cache@1.2.0"], service);
      expect(upRes.success).toBe(true);
      expect(upRes.output).toContain("upgraded to version 1.2.0 successfully");
      expect(store.getPlugin("@modus/smart-cache")?.version).toBe("1.2.0");

      // CLI Downgrade
      const downRes = await executePluginCli(["downgrade", "@modus/smart-cache", "1.0.0"], service);
      expect(downRes.success).toBe(true);
      expect(downRes.output).toContain("rolled back to version 1.0.0 successfully");
      expect(store.getPlugin("@modus/smart-cache")?.version).toBe("1.0.0");
    });

    it("handles errors cleanly for invalid or non-existent commands", async () => {
      const resUnknown = await executePluginCli(["nonexistent-cmd"], service);
      expect(resUnknown.success).toBe(false);
      expect(resUnknown.error).toBe("Unknown command");

      const resMissingArg = await executePluginCli(["status"], service);
      expect(resMissingArg.success).toBe(false);
      expect(resMissingArg.error).toBe("Missing plugin-id");

      const resNotFound = await executePluginCli(["enable", "@nonexistent/plug"], service);
      expect(resNotFound.success).toBe(false);
      expect(resNotFound.error).toContain("not installed");
    });
  });

  describe("11.4 — Fase 11 review regressions: atomic reloads & transaction discipline", () => {
    it("failed upgrade reload leaves DB and loader on the old version", async () => {
      await service.install(sampleManifestV1);
      await service.enable("@modus/smart-cache");

      const badV2: PluginManifest = {
        ...sampleManifestV2,
        version: "1.3.0",
        requires: {
          modus: ">=0.8.0",
          capabilities: [{ capability: "nope.missing", version: "1.0" }],
        },
      };
      catalog.add(badV2);
      await expect(service.upgrade(badV2)).rejects.toThrow();

      // No divergence: durable state untouched and live runtime restored.
      expect(store.getPlugin("@modus/smart-cache")?.version).toBe("1.0.0");
      expect(loader.getPlugin("@modus/smart-cache")?.manifest.version).toBe("1.0.0");
      expect(loader.getPlugin("@modus/smart-cache")?.status).toBe("enabled");
    });

    it("upgrade while disabled serves the new version after enable", async () => {
      await service.install(sampleManifestV1);
      await service.enable("@modus/smart-cache");
      await service.disable("@modus/smart-cache");
      await service.upgrade(sampleManifestV2);

      expect(store.getPlugin("@modus/smart-cache")?.version).toBe("1.2.0");

      await service.enable("@modus/smart-cache");
      expect(loader.getPlugin("@modus/smart-cache")?.manifest.version).toBe("1.2.0");
      const out = (await registry.execute("cache.query", {})) as { version?: number };
      expect(out.version).toBe(2);
    });

    it("transaction() refuses async functions instead of committing early", () => {
      expect(() =>
        store.transaction(async () => {
          store.savePlugin({
            id: "@test/async",
            version: "1.0.0",
            state: "installed",
            trust_level: "local",
            installed_at: new Date().toISOString(),
            last_enabled: null,
            config: null,
          });
        }),
      ).toThrow(/async/);
      expect(store.getPlugin("@test/async")).toBeNull();
    });
  });
});
