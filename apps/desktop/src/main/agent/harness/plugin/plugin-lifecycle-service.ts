/**
 * Modus Harness Evolution — Fase 11, 14 & 15: Plugin Lifecycle, Dependency Intelligence & Resilience
 * Service for transactional plugin lifecycle operations (install, enable, disable, upgrade, downgrade, uninstall, status, safe mode, recovery).
 */

import { HOST_CAPABILITY_REGISTRATION_AUTHORITY } from "../capability/capability-registration-authority";
import type { CapabilityRegistry } from "../capability/capability-registry";
import type { TrustLevel } from "../capability/capability-types";
import { AutoRollbackManager } from "./auto-rollback";
import { DependencyGraph } from "./dependency-graph";
import { BUILT_IN_PLUGIN_ENTRIES } from "./plugin-catalog";
import type { PluginLoader } from "./plugin-loader";
import { PluginRecoveryManager } from "./plugin-recovery";
import type { SafeModeLevel } from "./plugin-rollback-types";
import type {
  PersistedSafeModeState,
  PersistentPluginState,
  PluginCapabilityRecord,
  PluginEventRecord,
  PluginRecord,
  PluginStateStore,
} from "./plugin-state-store";
import {
  PluginDependencyError,
  PluginLifecycleError,
  type PluginManifest,
  type PluginStatus,
} from "./plugin-types";
import { PluginSafeModeManager } from "./safe-mode";
import { PluginVersionManager } from "./version-manager";

export interface PluginStatusReport {
  id: string;
  version: string;
  state: PersistentPluginState;
  runtimeStatus?: PluginStatus | undefined;
  trustLevel: string;
  installedAt: string;
  lastEnabled: string | null;
  config: Record<string, unknown> | null;
  capabilities: PluginCapabilityRecord[];
  permissions: unknown | null;
  availableVersions: string[];
  recentEvents: PluginEventRecord[];
}

const lifecycleQueuesByStore = new WeakMap<PluginStateStore, Map<string, Promise<void>>>();

export class PluginLifecycleService {
  private store: PluginStateStore;
  private loader: PluginLoader;
  private registry: CapabilityRegistry;
  private dependencyGraph: DependencyGraph = new DependencyGraph();
  private versionManager?: PluginVersionManager | undefined;
  private safeModeManager?: PluginSafeModeManager | undefined;
  private recoveryManager?: PluginRecoveryManager | undefined;
  private autoRollbackManager?: AutoRollbackManager | undefined;
  private readonly lifecycleQueues: Map<string, Promise<void>>;

  constructor(store: PluginStateStore, loader: PluginLoader, registry: CapabilityRegistry) {
    this.store = store;
    this.loader = loader;
    this.registry = registry;
    let lifecycleQueues = lifecycleQueuesByStore.get(store);
    if (!lifecycleQueues) {
      lifecycleQueues = new Map();
      lifecycleQueuesByStore.set(store, lifecycleQueues);
    }
    this.lifecycleQueues = lifecycleQueues;
  }

  private async withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    // Lifecycle operations share one SQLite transaction store and dependency
    // graph. Serialize the short maintenance operations at that shared boundary
    // so different plugin IDs cannot race each other's durable graph changes.
    const lockKey = "*";
    const predecessor = this.lifecycleQueues.get(lockKey) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => current);
    this.lifecycleQueues.set(lockKey, tail);

    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.lifecycleQueues.get(lockKey) === tail) {
        await tail;
        if (this.lifecycleQueues.get(lockKey) === tail) this.lifecycleQueues.delete(lockKey);
      }
    }
  }

  public getStore(): PluginStateStore {
    return this.store;
  }

  public getLoader(): PluginLoader {
    return this.loader;
  }

  public getRegistry(): CapabilityRegistry {
    return this.registry;
  }

  public getDependencyGraph(): DependencyGraph {
    return this.dependencyGraph;
  }

  public getSafeModeState(): PersistedSafeModeState {
    return this.store.getSafeModeState();
  }

  private allowedTrustLevels(level: SafeModeLevel): TrustLevel[] {
    if (level === "core") return ["core"];
    if (level === "official") return ["core", "official"];
    return ["core", "official", "verified"];
  }

  private assertTrustAllowedBySafeMode(
    pluginId: string,
    trustLevel: TrustLevel,
    operation: string,
    quarantineWhenDenied = false,
  ): void {
    const { level } = this.store.getSafeModeState();
    if (!level || this.allowedTrustLevels(level).includes(trustLevel)) return;

    if (quarantineWhenDenied) {
      this.registry.quarantineProvider(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
    }
    throw new PluginLifecycleError(
      `Cannot ${operation} plugin '${pluginId}' while Safe Mode '${level}' excludes trust level '${trustLevel}'`,
    );
  }

  public enterSafeMode(
    level: SafeModeLevel,
  ): Promise<{ enabledPlugins: string[]; disabledPlugins: string[]; previouslyEnabled: string[] }> {
    return this.withLifecycleLock(async () => {
      const allowedTrusts = this.allowedTrustLevels(level);
      const records = this.store.listPlugins();
      const currentState = this.store.getSafeModeState();
      const previouslyEnabled =
        currentState.level === null
          ? [
              ...new Set([
                ...currentState.previouslyEnabled,
                ...records
                  .filter((plugin) => plugin.state === "enabled")
                  .map((plugin) => plugin.id),
              ]),
            ]
          : currentState.previouslyEnabled;
      const disabledPlugins = new Set(currentState.disabledPlugins);
      this.store.setSafeModeState({
        level,
        previouslyEnabled,
        disabledPlugins: [...disabledPlugins],
      });

      const enabledPlugins: string[] = [];
      for (const plugin of records) {
        if (plugin.state !== "enabled") continue;
        const manifest = this.resolveManifest(plugin.id, plugin.version);
        let trustLevel: TrustLevel | undefined;
        if (manifest) {
          try {
            trustLevel = this.loader.authorizeManifest(manifest).trustLevel;
          } catch {
            trustLevel = undefined;
          }
        }
        if (trustLevel && allowedTrusts.includes(trustLevel)) {
          enabledPlugins.push(plugin.id);
          continue;
        }

        this.registry.quarantineProvider(plugin.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
        this.loader.disableForHostSafety(plugin.id);
        this.store.transaction(() => {
          this.store.updatePluginState(plugin.id, "disabled");
          this.store.recordEvent(plugin.id, "safe_mode_disabled", {
            level,
            version: plugin.version,
          });
        });
        disabledPlugins.add(plugin.id);
      }

      const trackedIds = new Set(records.map((plugin) => plugin.id));
      for (const plugin of this.loader.listPlugins()) {
        if (plugin.status !== "enabled" || trackedIds.has(plugin.manifest.id)) continue;
        let trustLevel: TrustLevel | undefined;
        try {
          trustLevel = this.loader.authorizeManifest(plugin.manifest).trustLevel;
        } catch {
          trustLevel = undefined;
        }
        if (trustLevel && allowedTrusts.includes(trustLevel)) continue;
        this.registry.quarantineProvider(
          plugin.manifest.id,
          HOST_CAPABILITY_REGISTRATION_AUTHORITY,
        );
        this.loader.disableForHostSafety(plugin.manifest.id);
        disabledPlugins.add(plugin.manifest.id);
      }

      this.store.setSafeModeState({
        level,
        previouslyEnabled,
        disabledPlugins: [...disabledPlugins],
      });
      return { enabledPlugins, disabledPlugins: [...disabledPlugins], previouslyEnabled };
    });
  }

  public clearSafeMode(): Promise<string[]> {
    return this.withLifecycleLock(async () => {
      const state = this.store.getSafeModeState();
      this.store.setSafeModeState({ ...state, level: null });
      return state.previouslyEnabled;
    });
  }

  public markSafeModePluginRestored(pluginId: string): Promise<void> {
    return this.withLifecycleLock(async () => this.markSafeModePluginRestoredUnlocked(pluginId));
  }

  private markSafeModePluginRestoredUnlocked(pluginId: string): void {
    const state = this.store.getSafeModeState();
    this.store.setSafeModeState({
      ...state,
      previouslyEnabled: state.previouslyEnabled.filter((id) => id !== pluginId),
      disabledPlugins: state.disabledPlugins.filter((id) => id !== pluginId),
    });
  }

  public finishSafeModeExit(): Promise<void> {
    return this.withLifecycleLock(async () => this.finishSafeModeExitUnlocked());
  }

  private finishSafeModeExitUnlocked(): void {
    const state = this.store.getSafeModeState();
    if (state.level !== null || state.previouslyEnabled.length > 0) {
      throw new PluginLifecycleError("Safe Mode restoration is still pending");
    }
    this.store.setSafeModeState({ level: null, previouslyEnabled: [], disabledPlugins: [] });
  }

  public restoreAfterSafeMode(pluginId: string): Promise<boolean> {
    return this.withLifecycleLock(() => this.restoreAfterSafeModeUnlocked(pluginId));
  }

  private async restoreAfterSafeModeUnlocked(pluginId: string): Promise<boolean> {
    const record = this.store.getPlugin(pluginId);
    if (!record) return false;

    if (record.state === "enabled") {
      const manifest = this.resolveManifest(pluginId, record.version);
      const loaded = this.loader.getPlugin(pluginId);
      if (manifest && loaded?.manifest === manifest && loaded.status === "enabled") {
        if (this.registry.isProviderQuarantined(pluginId)) {
          const hostEntry = this.loader.authorizeManifest(manifest);
          this.assertTrustAllowedBySafeMode(pluginId, hostEntry.trustLevel, "restore", true);
          this.releaseQuarantineAfterDurableEnable(pluginId, record.version);
          return true;
        }
        return false;
      }
    }

    await this.enableUnlocked(pluginId);
    return true;
  }

  public getVersionManager(): PluginVersionManager {
    if (!this.versionManager) {
      this.versionManager = new PluginVersionManager(this, this.store);
    }
    return this.versionManager;
  }

  public getSafeModeManager(): PluginSafeModeManager {
    if (!this.safeModeManager) {
      this.safeModeManager = new PluginSafeModeManager(this);
    }
    return this.safeModeManager;
  }

  public getRecoveryManager(): PluginRecoveryManager {
    if (!this.recoveryManager) {
      this.recoveryManager = new PluginRecoveryManager(
        this,
        this.getVersionManager(),
        this.registry,
        this.dependencyGraph,
      );
    }
    return this.recoveryManager;
  }

  public getAutoRollbackManager(): AutoRollbackManager {
    if (!this.autoRollbackManager) {
      this.autoRollbackManager = new AutoRollbackManager(this, this.getVersionManager());
    }
    return this.autoRollbackManager;
  }

  /**
   * Registers a manifest in the live catalog so its implementations are available across lifecycle transitions.
   */
  public registerManifest(manifest: PluginManifest): void {
    this.loader.authorizeManifest(manifest);
    this.dependencyGraph.addPlugin(manifest);
  }

  private assertDependentCapabilitiesCompatible(manifest: PluginManifest): void {
    const graphNode = this.dependencyGraph.getPlugin(manifest.id);
    if (!graphNode) return;

    const directDependents = this.dependencyGraph.calculateBlastRadius(
      manifest.id,
    ).directDependents;
    for (const dependentId of directDependents) {
      const dependentRecord = this.store.getPlugin(dependentId);
      const dependentManifest = dependentRecord
        ? this.resolveManifest(dependentId, dependentRecord.version)
        : this.resolveManifest(dependentId);
      if (!dependentManifest) {
        throw new PluginDependencyError(
          `Cannot change '${manifest.id}': dependent '${dependentId}' has no exact host catalog manifest`,
        );
      }

      for (const requirement of dependentManifest.requires.capabilities ?? []) {
        if (!graphNode.provides.includes(requirement.capability)) continue;
        const replacement = manifest.provides.find(
          (provision) => provision.capability === requirement.capability,
        );
        if (
          !replacement ||
          !this.loader.isApiVersionSatisfied(replacement.apiVersion, requirement.version)
        ) {
          throw new PluginDependencyError(
            `Cannot change '${manifest.id}': dependent '${dependentId}' requires ${requirement.capability}@${requirement.version}`,
          );
        }
      }
    }
  }

  /**
   * Resolves a live manifest with implementations from catalog or fallback.
   */
  public resolveManifest(id: string, version?: string): PluginManifest | undefined {
    const requestedVersion = version ?? this.store.getPlugin(id)?.version;
    return requestedVersion
      ? this.loader.resolveHostManifest(id, requestedVersion)
      : this.loader.resolveHostManifestById(id);
  }

  /**
   * Installs a plugin into the state store and catalog.
   */
  public install(
    manifest: PluginManifest,
    config?: Record<string, unknown>,
  ): Promise<PluginRecord> {
    return this.withLifecycleLock(() => this.installUnlocked(manifest, config));
  }

  private async installUnlocked(
    manifest: PluginManifest,
    config?: Record<string, unknown>,
    initialState: PersistentPluginState = "installed",
  ): Promise<PluginRecord> {
    const hostEntry = this.loader.authorizeManifest(manifest);
    this.loader.validateManifest(manifest);
    this.dependencyGraph.assertCanAddPlugin(manifest);
    this.assertDependentCapabilitiesCompatible(manifest);

    const now = new Date().toISOString();
    const existing = this.store.getPlugin(manifest.id);

    this.store.transaction(() => {
      const record: PluginRecord = {
        id: manifest.id,
        version: manifest.version,
        state: initialState,
        trust_level: hostEntry.trustLevel,
        installed_at: existing ? existing.installed_at : now,
        last_enabled: existing ? existing.last_enabled : initialState === "enabled" ? now : null,
        config: config ?? existing?.config ?? null,
      };

      // 1. Save primary plugin record first (satisfying Foreign Key constraints)
      this.store.savePlugin(record);

      // 2. Save version history, capabilities, and permissions
      this.store.saveVersion(manifest.id, manifest.version, manifest, now);
      this.store.saveCapabilities(
        manifest.id,
        manifest.provides.map((p) => ({
          capability: p.capability,
          apiVersion: p.apiVersion,
        })),
      );
      this.store.savePermissions(manifest.id, manifest.permissions);
      this.store.deletePluginUninstallTombstone(manifest.id);

      // 3. Record audit event
      this.store.recordEvent(manifest.id, "installed", {
        version: manifest.version,
        trustLevel: manifest.trustLevel,
      });
      if (initialState === "enabled") {
        this.store.recordEvent(manifest.id, "enabled", {
          version: manifest.version,
          source: "built-in bootstrap default",
        });
      }
    });

    this.dependencyGraph.addPlugin(manifest);

    return this.store.getPlugin(manifest.id)!;
  }

  /**
   * Enables an installed or disabled plugin.
   */
  public enable(pluginId: string): Promise<void> {
    return this.withLifecycleLock(() => this.enableUnlocked(pluginId));
  }

  private async enableUnlocked(pluginId: string): Promise<void> {
    const pluginRecord = this.store.getPlugin(pluginId);
    if (!pluginRecord) {
      throw new PluginLifecycleError(`Cannot enable plugin '${pluginId}': not installed`);
    }

    const manifest = this.resolveManifest(pluginId, pluginRecord.version);
    if (!manifest) {
      throw new PluginLifecycleError(
        `Manifest not found for plugin '${pluginId}' version ${pluginRecord.version}`,
      );
    }

    const cycle = this.dependencyGraph
      .findCycles()
      .find((candidate) => candidate.includes(pluginId));
    if (cycle) {
      throw new PluginDependencyError(
        `Cannot enable plugin '${pluginId}': it participates in dependency cycle ${cycle.join(" -> ")}`,
      );
    }

    const safeMode = this.store.getSafeModeState();
    if (
      safeMode.level &&
      !this.allowedTrustLevels(safeMode.level).includes(
        this.loader.authorizeManifest(manifest).trustLevel,
      )
    ) {
      this.registry.quarantineProvider(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      throw new PluginLifecycleError(
        `Cannot enable plugin '${pluginId}' while Safe Mode '${safeMode.level}' is active`,
      );
    }

    this.loader.checkDependencies(manifest);
    const loadedPlugin = this.loader.getPlugin(pluginId);
    if (
      pluginRecord.state === "enabled" &&
      loadedPlugin?.manifest === manifest &&
      loadedPlugin.status === "enabled"
    ) {
      this.releaseQuarantineAfterDurableEnable(pluginId, pluginRecord.version);
      return;
    }

    this.registry.quarantineProvider(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

    // Ensure it is loaded in PluginLoader, at the recorded version: a stale
    // loaded manifest (e.g. after upgrading while disabled) is reloaded.
    if (!loadedPlugin || loadedPlugin.manifest !== manifest) {
      if (loadedPlugin) {
        await this.loader.unload(pluginId);
      }
      await this.loader.load(manifest);
    }

    try {
      await this.loader.enableFromHostLifecycle(manifest);
      const now = new Date().toISOString();
      this.store.transaction(() => {
        this.store.updatePluginState(pluginId, "enabled");
        this.store.updatePluginLastEnabled(pluginId, now);
        this.store.recordEvent(pluginId, "enabled", { version: pluginRecord.version });
      });
      this.releaseQuarantineAfterDurableEnable(pluginId, pluginRecord.version);
    } catch (error) {
      this.registry.quarantineProvider(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      throw error;
    }
  }

  /**
   * Disables an active plugin.
   */
  public disable(pluginId: string): Promise<void> {
    return this.withLifecycleLock(() => this.disableUnlocked(pluginId));
  }

  private async disableUnlocked(pluginId: string): Promise<void> {
    const pluginRecord = this.store.getPlugin(pluginId);
    if (!pluginRecord) {
      throw new PluginLifecycleError(`Cannot disable plugin '${pluginId}': not installed`);
    }

    const loaded = this.loader.getPlugin(pluginId);
    this.registry.quarantineProvider(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

    try {
      if (loaded) await this.loader.disable(pluginId);

      try {
        this.store.transaction(() => {
          this.store.updatePluginState(pluginId, "disabled");
          this.store.recordEvent(pluginId, "disabled", { version: pluginRecord.version });
          const safeMode = this.store.getSafeModeState();
          if (safeMode.previouslyEnabled.includes(pluginId)) {
            this.store.setSafeModeState({
              ...safeMode,
              previouslyEnabled: safeMode.previouslyEnabled.filter((id) => id !== pluginId),
            });
          }
        });
      } catch (commitError) {
        const manifest = this.resolveManifest(pluginId, pluginRecord.version);
        if (loaded && manifest === loaded.manifest) {
          try {
            await this.loader.enableFromHostLifecycle(manifest);
            this.releaseQuarantineAfterDurableEnable(pluginId, pluginRecord.version);
          } catch (restoreError) {
            try {
              this.store.transaction(() => {
                this.store.updatePluginState(pluginId, "error");
                this.store.recordEvent(pluginId, "lifecycle_recovery_error", {
                  operation: "disable",
                  error:
                    restoreError instanceof Error ? restoreError.message : String(restoreError),
                });
              });
            } catch {
              // The provider remains quarantined if durable recovery also fails.
            }
            throw new PluginLifecycleError(
              `Disable commit failed and runtime restoration failed for '${pluginId}': ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
            );
          }
        }
        throw commitError;
      }
    } catch (error) {
      const current = this.loader.getPlugin(pluginId);
      if (current?.status === "enabled" && this.registry.isProviderQuarantined(pluginId)) {
        try {
          this.store.transaction(() => {
            this.store.updatePluginState(pluginId, "error");
            this.store.recordEvent(pluginId, "lifecycle_error", {
              operation: "disable",
              error: error instanceof Error ? error.message : String(error),
            });
          });
        } catch {
          // Keep the in-memory quarantine if even the failure record cannot persist.
        }
      }
      throw error;
    }
  }

  /**
   * Upgrades a plugin to a new manifest / version.
   */
  public upgrade(newManifest: PluginManifest): Promise<void> {
    return this.withLifecycleLock(() => this.upgradeUnlocked(newManifest));
  }

  private async upgradeUnlocked(newManifest: PluginManifest): Promise<void> {
    const hostEntry = this.loader.authorizeManifest(newManifest);
    this.loader.validateManifest(newManifest);
    const existing = this.store.getPlugin(newManifest.id);
    if (!existing) {
      throw new PluginLifecycleError(
        `Cannot upgrade plugin '${newManifest.id}': plugin is not installed`,
      );
    }

    this.assertTrustAllowedBySafeMode(newManifest.id, hostEntry.trustLevel, "upgrade");

    const oldVersion = existing.version;
    this.dependencyGraph.assertCanAddPlugin(newManifest);
    this.assertDependentCapabilitiesCompatible(newManifest);

    const now = new Date().toISOString();
    const wasEnabled = existing.state === "enabled";

    // Hot-reload FIRST: a failure here leaves durable state untouched, so the
    // next syncOnStartup restores the old version instead of diverging from it.
    if (wasEnabled) {
      this.registry.quarantineProvider(newManifest.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      await this.loader.unload(newManifest.id);
      try {
        await this.loader.load(newManifest);
        await this.loader.enableFromHostLifecycle(newManifest);
      } catch (err) {
        await this.restoreLoaderVersion(newManifest.id, oldVersion);
        throw err;
      }
    }

    // Perform atomic state migration only after the live reload succeeded.
    try {
      this.store.transaction(() => {
        this.store.savePlugin({
          ...existing,
          version: newManifest.version,
          trust_level: hostEntry.trustLevel,
        });

        this.store.saveVersion(newManifest.id, newManifest.version, newManifest, now);
        this.store.saveCapabilities(
          newManifest.id,
          newManifest.provides.map((p) => ({
            capability: p.capability,
            apiVersion: p.apiVersion,
          })),
        );
        this.store.savePermissions(newManifest.id, newManifest.permissions);

        this.store.recordEvent(newManifest.id, "upgraded", {
          fromVersion: oldVersion,
          toVersion: newManifest.version,
        });
      });
    } catch (err) {
      // Durable commit failed after a successful reload: roll the live
      // runtime back too, so the two never disagree.
      if (wasEnabled) {
        await this.restoreLoaderVersion(newManifest.id, oldVersion);
      }
      throw err;
    }
    this.dependencyGraph.addPlugin(newManifest);
    if (wasEnabled) this.releaseQuarantineAfterDurableEnable(newManifest.id, newManifest.version);
  }

  /**
   * Best-effort restoration of a previous plugin version into the loader,
   * used to compensate failed upgrades/downgrades. Startup sync reconciles
   * anything left behind from SQLite on the next boot.
   */
  private async restoreLoaderVersion(pluginId: string, version: string): Promise<void> {
    this.registry.quarantineProvider(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
    const previous = this.resolveManifest(pluginId, version);
    if (!previous)
      throw new PluginLifecycleError(
        `Cannot restore ${pluginId}@${version}: catalog manifest unavailable`,
      );
    const loaded = this.loader.getPlugin(pluginId);
    if (loaded) await this.loader.unload(pluginId);
    await this.loader.load(previous);
    await this.loader.enableFromHostLifecycle(previous);
    this.releaseQuarantineAfterDurableEnable(pluginId, version);
  }

  private releaseQuarantineAfterDurableEnable(pluginId: string, version: string): void {
    const record = this.store.getPlugin(pluginId);
    const manifest = this.loader.resolveHostManifest(pluginId, version);
    const loaded = this.loader.getPlugin(pluginId);
    if (
      !record ||
      record.version !== version ||
      record.state !== "enabled" ||
      !manifest ||
      loaded?.manifest !== manifest ||
      loaded.status !== "enabled"
    ) {
      throw new PluginLifecycleError(
        `Cannot recover quarantine for ${pluginId}@${version}: durable state or exact loaded manifest mismatch`,
      );
    }
    this.registry.clearProviderQuarantine(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
    for (const provision of manifest.provides) {
      try {
        this.registry.activateProvider(provision.capability, pluginId);
      } catch {
        /* non-replaceable provider */
      }
    }
  }

  /**
   * Downgrades a plugin to a previously preserved version.
   */
  public downgrade(pluginId: string, targetVersion: string): Promise<void> {
    return this.withLifecycleLock(() => this.downgradeUnlocked(pluginId, targetVersion));
  }

  private async downgradeUnlocked(pluginId: string, targetVersion: string): Promise<void> {
    const existing = this.store.getPlugin(pluginId);
    if (!existing) {
      throw new PluginLifecycleError(
        `Cannot downgrade plugin '${pluginId}': plugin is not installed`,
      );
    }

    const targetManifest = this.resolveManifest(pluginId, targetVersion);
    if (!targetManifest) {
      throw new PluginLifecycleError(
        `Cannot downgrade plugin '${pluginId}' to '${targetVersion}': version is not available in the host catalog`,
      );
    }
    const hostEntry = this.loader.authorizeManifest(targetManifest);
    this.loader.validateManifest(targetManifest);
    this.assertTrustAllowedBySafeMode(pluginId, hostEntry.trustLevel, "downgrade");
    this.dependencyGraph.assertCanAddPlugin(targetManifest);
    this.assertDependentCapabilitiesCompatible(targetManifest);

    const oldVersion = existing.version;
    const wasEnabled = existing.state === "enabled";

    // Hot-reload FIRST so a failure leaves durable state untouched.
    if (wasEnabled) {
      this.registry.quarantineProvider(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      await this.loader.unload(pluginId);
      try {
        await this.loader.load(targetManifest);
        await this.loader.enableFromHostLifecycle(targetManifest);
      } catch (err) {
        await this.restoreLoaderVersion(pluginId, oldVersion);
        throw err;
      }
    }

    try {
      this.store.transaction(() => {
        this.store.savePlugin({
          ...existing,
          version: targetVersion,
          trust_level: hostEntry.trustLevel,
        });

        this.store.saveCapabilities(
          pluginId,
          targetManifest.provides.map((p) => ({
            capability: p.capability,
            apiVersion: p.apiVersion,
          })),
        );
        this.store.savePermissions(pluginId, targetManifest.permissions);

        this.store.recordEvent(pluginId, "downgraded", {
          fromVersion: oldVersion,
          toVersion: targetVersion,
        });
      });
      this.dependencyGraph.addPlugin(targetManifest);
    } catch (err) {
      if (wasEnabled) {
        await this.restoreLoaderVersion(pluginId, oldVersion);
      }
      throw err;
    }
    if (wasEnabled) this.releaseQuarantineAfterDurableEnable(pluginId, targetVersion);
  }

  /**
   * Uninstalls a plugin, removing it from active registry and storage records.
   * If dependencies are active, prevents removal unless force is specified.
   */
  public uninstall(pluginId: string, options?: { force?: boolean }): Promise<void> {
    return this.withLifecycleLock(() => this.uninstallUnlocked(pluginId, options));
  }

  private async uninstallUnlocked(pluginId: string, options?: { force?: boolean }): Promise<void> {
    const existing = this.store.getPlugin(pluginId);
    if (!existing) {
      return; // Idempotent
    }

    const cyclePluginIds = new Set(this.dependencyGraph.findCycles().flat());
    const targetParticipatesInCycle = cyclePluginIds.has(pluginId);
    if (targetParticipatesInCycle && !options?.force) {
      throw new PluginDependencyError(
        `Cannot uninstall plugin '${pluginId}' while it participates in a dependency cycle`,
      );
    }
    const blast = this.dependencyGraph.calculateBlastRadius(pluginId);
    if (blast.directDependents.length > 0 && !options?.force) {
      throw new PluginLifecycleError(
        `Cannot uninstall plugin '${pluginId}' while it is required by ${blast.directDependents.join(", ")}. Uninstall or update dependents first.`,
      );
    }

    const suspendedDependents: Array<{ pluginId: string; persisted: boolean }> = [];
    try {
      if (targetParticipatesInCycle) {
        // Startup already fails closed for persisted cycles. Keep the same
        // invariant for an explicit forced repair: remove every cycle
        // participant from dispatch before deleting one node, and persist any
        // enabled participant as an error until its graph is repaired.
        for (const cycleId of cyclePluginIds) {
          this.registry.quarantineProvider(cycleId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
          this.loader.disableForHostSafety(cycleId);
          const cycleRecord = this.store.getPlugin(cycleId);
          if (cycleRecord?.state === "enabled") {
            this.store.transaction(() => {
              this.store.updatePluginState(cycleId, "error");
              this.store.recordEvent(cycleId, "sync_error", {
                error: `Plugin '${cycleId}' was quarantined while force-removing dependency cycle participant '${pluginId}'`,
              });
            });
          }
        }
      }

      if (options?.force && blast.directDependents.length > 0) {
        const affectedDependents = new Set([
          ...blast.directDependents,
          ...blast.transitiveDependents.map((dependent) => dependent.pluginId),
        ]);
        const dependentsToSuspend = this.dependencyGraph
          .topologicalSortExcluding(cyclePluginIds)
          .filter((dependentId) => affectedDependents.has(dependentId))
          .reverse();
        for (const dependentId of dependentsToSuspend) {
          const dependentRecord = this.store.getPlugin(dependentId);
          const loadedDependent = this.loader.getPlugin(dependentId);
          if (dependentRecord?.state !== "enabled" && loadedDependent?.status !== "enabled") {
            continue;
          }

          if (dependentRecord) {
            await this.disableUnlocked(dependentId);
            suspendedDependents.push({ pluginId: dependentId, persisted: true });
            this.store.recordEvent(dependentId, "dependency_suspended", {
              missingPlugin: pluginId,
              forcedUninstall: true,
            });
          } else {
            this.registry.quarantineProvider(dependentId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
            this.loader.disableForHostSafety(dependentId);
            suspendedDependents.push({ pluginId: dependentId, persisted: false });
          }
        }
      }

      if (this.loader.getPlugin(pluginId)) {
        await this.loader.unload(pluginId);
      }

      // NOTE: no 'uninstalled' audit event is recorded: deletePlugin removes
      // every row for the plugin (including events) in the same transaction,
      // so such an event could never survive. Complete removal is the contract.
      this.store.transaction(() => {
        this.store.deletePlugin(pluginId);
        this.store.savePluginUninstallTombstone({
          pluginId,
          version: existing.version,
          uninstalledAt: new Date().toISOString(),
        });
      });
    } catch (error) {
      // If uninstall did not durably remove the provider, reconcile runtime and
      // dependent state before returning the failure to the caller.
      if (this.store.getPlugin(pluginId)) {
        if (existing.state === "enabled") {
          try {
            const loaded = this.loader.getPlugin(pluginId);
            if (loaded?.status !== "enabled" || this.registry.isProviderQuarantined(pluginId)) {
              await this.restoreLoaderVersion(pluginId, existing.version);
            }
          } catch (restoreError) {
            this.registry.quarantineProvider(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
            try {
              this.store.transaction(() => {
                this.store.updatePluginState(pluginId, "error");
                this.store.recordEvent(pluginId, "lifecycle_recovery_error", {
                  operation: "uninstall",
                  error:
                    restoreError instanceof Error ? restoreError.message : String(restoreError),
                });
              });
            } catch {
              // Keep the provider quarantined if durable recovery also fails.
            }
          }
        }

        for (const dependent of suspendedDependents.reverse()) {
          try {
            if (dependent.persisted) {
              await this.enableUnlocked(dependent.pluginId);
              continue;
            }

            const loaded = this.loader.getPlugin(dependent.pluginId);
            if (!loaded) continue;
            this.loader.checkDependencies(loaded.manifest);
            await this.loader.enableFromHostLifecycle(loaded.manifest);
            this.registry.clearProviderQuarantine(
              dependent.pluginId,
              HOST_CAPABILITY_REGISTRATION_AUTHORITY,
            );
            for (const provision of loaded.manifest.provides) {
              try {
                this.registry.activateProvider(provision.capability, dependent.pluginId);
              } catch {
                /* non-replaceable provider */
              }
            }
          } catch {
            // A dependent that cannot be restored remains quarantined/disabled.
          }
        }
      }
      throw error;
    }

    this.dependencyGraph.removePlugin(pluginId);
  }

  /**
   * Returns complete status inspection for a plugin.
   */
  public async status(pluginId: string): Promise<PluginStatusReport | null> {
    const record = this.store.getPlugin(pluginId);
    if (!record) return null;

    const capabilities = this.store.getCapabilities(pluginId);
    const permissions = this.store.getPermissions(pluginId);
    const versions = this.store.getVersions(pluginId).map((v) => v.version);
    const recentEvents = this.store.getEvents(pluginId, 10);
    const loadedPlugin = this.loader.getPlugin(pluginId);

    return {
      id: record.id,
      version: record.version,
      state: record.state,
      runtimeStatus: loadedPlugin ? loadedPlugin.status : undefined,
      trustLevel: record.trust_level,
      installedAt: record.installed_at,
      lastEnabled: record.last_enabled,
      config: record.config,
      capabilities,
      permissions,
      availableVersions: versions,
      recentEvents,
    };
  }

  /**
   * Lists all tracked plugins from SQLite.
   */
  public async list(options?: { enabledOnly?: boolean }): Promise<PluginRecord[]> {
    return this.store.listPlugins(
      options?.enabledOnly !== undefined ? { enabledOnly: options.enabledOnly } : undefined,
    );
  }

  /**
   * Startup sync: restores state from SQLite into live loader and capability registry.
   */
  public async syncOnStartup(): Promise<string[]> {
    return this.withLifecycleLock(() => this.syncOnStartupUnlocked());
  }

  private async syncOnStartupUnlocked(): Promise<string[]> {
    const tombstones = this.store.listPluginUninstallTombstones();
    const tombstonedPluginIds = new Set(tombstones.map((item) => item.pluginId));
    for (const tombstone of tombstones) {
      this.registry.quarantineProvider(tombstone.pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      this.loader.disableForHostSafety(tombstone.pluginId);
    }

    // Seed first-install defaults from exact host catalog entries. Startup
    // bootstrap leaves plugins unloaded so no lifecycle hook runs until this
    // durable state and every explicit user decision have been read.
    for (const entry of BUILT_IN_PLUGIN_ENTRIES) {
      if (tombstonedPluginIds.has(entry.manifest.id) || this.store.getPlugin(entry.manifest.id)) {
        continue;
      }
      const manifest = this.resolveManifest(entry.manifest.id, entry.manifest.version);
      if (manifest !== entry.manifest) continue;
      try {
        this.loader.authorizeManifest(manifest);
        await this.installUnlocked(manifest, undefined, "enabled");
      } catch (error) {
        this.registry.quarantineProvider(entry.manifest.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
        this.loader.disableForHostSafety(entry.manifest.id);
        console.error(
          `[modus] Startup sync: failed to persist built-in '${entry.manifest.id}':`,
          error,
        );
      }
    }

    const records = this.store.listPlugins();
    const startupManifestsById = new Map<string, PluginManifest>();
    for (const record of records) {
      const manifest = this.resolveManifest(record.id, record.version);
      if (manifest) startupManifestsById.set(record.id, manifest);
    }
    for (const loaded of this.loader.listPlugins()) {
      if (startupManifestsById.has(loaded.manifest.id)) continue;
      try {
        const hostEntry = this.loader.authorizeManifest(loaded.manifest);
        if (hostEntry.manifest === loaded.manifest) {
          startupManifestsById.set(loaded.manifest.id, loaded.manifest);
        }
      } catch {
        // Loaded state is never proof of host authorization. Keep an
        // unexpected preloaded provider out of dispatch and dependency data.
        this.registry.quarantineProvider(
          loaded.manifest.id,
          HOST_CAPABILITY_REGISTRATION_AUTHORITY,
        );
        this.loader.disableForHostSafety(loaded.manifest.id);
      }
    }
    this.dependencyGraph.rebuild([...startupManifestsById.values()]);
    const cyclicPluginIds = new Set(this.dependencyGraph.findCycles().flat());
    const restored: string[] = [];

    // Resolve every non-enabled durable decision before enabling any plugin.
    // Bootstrap may have activated built-ins before state was read, so startup
    // must apply the persisted host decision without executing plugin hooks.
    for (const record of records) {
      if (record.state !== "enabled" && this.loader.getPlugin(record.id)) {
        this.registry.quarantineProvider(record.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
        this.loader.disableForHostSafety(record.id);
      }
    }

    // Quarantine every cycle participant before a dependent is considered.
    // This also handles a cyclic host-loaded plugin that has no durable row.
    for (const pluginId of cyclicPluginIds) {
      this.registry.quarantineProvider(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      this.loader.disableForHostSafety(pluginId);
      const record = this.store.getPlugin(pluginId);
      if (record?.state === "enabled") {
        this.store.transaction(() => {
          this.store.updatePluginState(pluginId, "error");
          this.store.recordEvent(pluginId, "sync_error", {
            error: `Plugin '${pluginId}' participates in a dependency cycle`,
          });
        });
      }
    }

    const enabledRecordIds = new Set(
      records
        .filter((record) => record.state === "enabled" && !cyclicPluginIds.has(record.id))
        .map((record) => record.id),
    );
    const visitedEnabled = new Set<string>();
    const orderedEnabledIds: string[] = [];
    const visitEnabled = (pluginId: string): void => {
      if (visitedEnabled.has(pluginId) || cyclicPluginIds.has(pluginId)) return;
      const node = this.dependencyGraph.getPlugin(pluginId);
      for (const dependencyId of node?.dependencies ?? []) {
        if (enabledRecordIds.has(dependencyId)) visitEnabled(dependencyId);
      }
      visitedEnabled.add(pluginId);
      orderedEnabledIds.push(pluginId);
    };
    for (const record of records) {
      if (enabledRecordIds.has(record.id)) visitEnabled(record.id);
    }
    const recordsById = new Map(records.map((record) => [record.id, record]));
    const orderedEnabledRecords = [
      ...orderedEnabledIds.map((pluginId) => recordsById.get(pluginId)),
      ...records.filter(
        (record) => enabledRecordIds.has(record.id) && !visitedEnabled.has(record.id),
      ),
    ].filter((record): record is PluginRecord => record !== undefined);

    for (const record of orderedEnabledRecords) {
      this.registry.quarantineProvider(record.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      if (cyclicPluginIds.has(record.id)) continue;
      const manifest = this.resolveManifest(record.id, record.version);
      if (!manifest) {
        console.warn(
          `[modus] Startup sync: cannot find manifest for enabled plugin '${record.id}'`,
        );
        this.registry.quarantineProvider(record.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
        const loadedPlugin = this.loader.getPlugin(record.id);
        if (loadedPlugin && loadedPlugin.manifest.version !== record.version) {
          await this.loader.unload(record.id).catch(() => undefined);
        }
        this.store.transaction(() => {
          this.store.updatePluginState(record.id, "error");
          this.store.recordEvent(record.id, "sync_error", {
            error: `Plugin "${record.id}@${record.version}" is not available in the host catalog`,
          });
        });
        continue;
      }

      const safeMode = this.store.getSafeModeState();
      if (
        safeMode.level &&
        !this.allowedTrustLevels(safeMode.level).includes(
          this.loader.authorizeManifest(manifest).trustLevel,
        )
      ) {
        this.registry.quarantineProvider(record.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
        this.loader.disableForHostSafety(record.id);
        this.store.transaction(() => {
          this.store.updatePluginState(record.id, "disabled");
          this.store.recordEvent(record.id, "safe_mode_disabled", {
            level: safeMode.level,
            version: record.version,
          });
        });
        this.store.setSafeModeState({
          ...safeMode,
          disabledPlugins: [...new Set([...safeMode.disabledPlugins, record.id])],
        });
        continue;
      }

      try {
        // A loaded plugin with the same ID is not proof that it is the
        // catalog-authorized version persisted in state. Reconcile identity
        // as well as version before enabling it.
        const loadedPlugin = this.loader.getPlugin(record.id);
        if (loadedPlugin?.manifest === manifest && loadedPlugin.status === "enabled") {
          this.loader.checkDependencies(manifest);
          this.releaseQuarantineAfterDurableEnable(record.id, record.version);
          restored.push(record.id);
          continue;
        }
        if (
          loadedPlugin &&
          (loadedPlugin.manifest !== manifest ||
            loadedPlugin.manifest.id !== record.id ||
            loadedPlugin.manifest.version !== record.version)
        ) {
          this.registry.quarantineProvider(record.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
          await this.loader.unload(record.id);
        }
        if (!this.loader.getPlugin(record.id)) {
          await this.loader.load(manifest);
        } else {
          this.loader.checkDependencies(manifest);
        }
        await this.loader.enableFromHostLifecycle(manifest);
        this.releaseQuarantineAfterDurableEnable(record.id, record.version);
        restored.push(record.id);
      } catch (err) {
        console.error(`[modus] Startup sync: failed to enable plugin '${record.id}':`, err);
        this.registry.quarantineProvider(record.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
        this.loader.disableForHostSafety(record.id);
        this.store.transaction(() => {
          this.store.updatePluginState(record.id, "error");
          this.store.recordEvent(record.id, "sync_error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    const safeModeState = this.store.getSafeModeState();
    if (safeModeState.level === null && safeModeState.previouslyEnabled.length > 0) {
      let restoreOrder = safeModeState.previouslyEnabled;
      try {
        const cyclicIds = new Set(this.dependencyGraph.findCycles().flat());
        const topologicalOrder = this.dependencyGraph.topologicalSortExcluding(cyclicIds);
        restoreOrder = [...safeModeState.previouslyEnabled].sort(
          (left, right) => topologicalOrder.indexOf(left) - topologicalOrder.indexOf(right),
        );
      } catch {
        // Individual dependency checks below keep each restore fail-closed.
      }

      for (const pluginId of restoreOrder) {
        try {
          if (await this.restoreAfterSafeModeUnlocked(pluginId)) restored.push(pluginId);
          this.markSafeModePluginRestoredUnlocked(pluginId);
        } catch {
          // Preserve unresolved IDs for a later startup/manager retry.
        }
      }

      if (this.store.getSafeModeState().previouslyEnabled.length === 0) {
        this.finishSafeModeExitUnlocked();
      }
    }

    return restored;
  }
}
