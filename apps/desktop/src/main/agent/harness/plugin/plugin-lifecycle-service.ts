/**
 * Modus Harness Evolution — Fase 11, 14 & 15: Plugin Lifecycle, Dependency Intelligence & Resilience
 * Service for transactional plugin lifecycle operations (install, enable, disable, upgrade, downgrade, uninstall, status, safe mode, recovery).
 */

import type { CapabilityRegistry } from '../capability/capability-registry';
import { HOST_CAPABILITY_REGISTRATION_AUTHORITY } from '../capability/capability-registration-authority';
import { AutoRollbackManager } from './auto-rollback';
import { DependencyGraph } from './dependency-graph';
import type { PluginLoader } from './plugin-loader';
import { PluginRecoveryManager } from './plugin-recovery';
import { PluginSafeModeManager } from './safe-mode';
import type {
  PersistentPluginState,
  PluginCapabilityRecord,
  PluginEventRecord,
  PluginRecord,
  PluginStateStore,
  PluginVersionRecord,
} from './plugin-state-store';
import {
  PluginLifecycleError,
  type PluginManifest,
  type PluginStatus,
} from './plugin-types';
import { PluginVersionManager } from './version-manager';
import { WasmCapabilityHost } from './wasm/wasm-capability-host';

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

export class PluginLifecycleService {
  private store: PluginStateStore;
  private loader: PluginLoader;
  private registry: CapabilityRegistry;
  private dependencyGraph: DependencyGraph = new DependencyGraph();
  private versionManager?: PluginVersionManager | undefined;
  private safeModeManager?: PluginSafeModeManager | undefined;
  private recoveryManager?: PluginRecoveryManager | undefined;
  private autoRollbackManager?: AutoRollbackManager | undefined;
  private wasmHost?: WasmCapabilityHost | undefined;

  constructor(
    store: PluginStateStore,
    loader: PluginLoader,
    registry: CapabilityRegistry,
  ) {
    this.store = store;
    this.loader = loader;
    this.registry = registry;

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
      this.autoRollbackManager = new AutoRollbackManager(
        this,
        this.getVersionManager(),
      );
    }
    return this.autoRollbackManager;
  }

  public getWasmHost(): WasmCapabilityHost {
    if (!this.wasmHost) {
      this.wasmHost = new WasmCapabilityHost();
    }
    return this.wasmHost;
  }

  /**
   * Registers a manifest in the live catalog so its implementations are available across lifecycle transitions.
   */
  public registerManifest(manifest: PluginManifest): void {
    this.loader.authorizeManifest(manifest);
    this.dependencyGraph.addPlugin(manifest);
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
  public async install(
    manifest: PluginManifest,
    config?: Record<string, unknown>,
  ): Promise<PluginRecord> {
    const hostEntry = this.loader.authorizeManifest(manifest);
    this.loader.validateManifest(manifest);
    this.registerManifest(manifest);

    const now = new Date().toISOString();
    const existing = this.store.getPlugin(manifest.id);

    this.store.transaction(() => {
      const record: PluginRecord = {
        id: manifest.id,
        version: manifest.version,
        state: 'installed',
        trust_level: hostEntry.trustLevel,
        installed_at: existing ? existing.installed_at : now,
        last_enabled: existing ? existing.last_enabled : null,
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

      // 3. Record audit event
      this.store.recordEvent(manifest.id, 'installed', {
        version: manifest.version,
        trustLevel: manifest.trustLevel,
      });
    });

    return this.store.getPlugin(manifest.id)!;
  }

  /**
   * Enables an installed or disabled plugin.
   */
  public async enable(pluginId: string): Promise<void> {
    const pluginRecord = this.store.getPlugin(pluginId);
    if (!pluginRecord) {
      throw new PluginLifecycleError(`Cannot enable plugin '${pluginId}': not installed`);
    }

    const manifest = this.resolveManifest(pluginId, pluginRecord.version);
    if (!manifest) {
      throw new PluginLifecycleError(`Manifest not found for plugin '${pluginId}' version ${pluginRecord.version}`);
    }

    this.registry.quarantineProvider(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

    // Ensure it is loaded in PluginLoader, at the recorded version: a stale
    // loaded manifest (e.g. after upgrading while disabled) is reloaded.
    const loadedPlugin = this.loader.getPlugin(pluginId);
    if (!loadedPlugin || loadedPlugin.manifest.version !== pluginRecord.version) {
      if (loadedPlugin) {
        await this.loader.unload(pluginId);
      }
      await this.loader.load(manifest);
    }

    try {
      await this.loader.enableFromHostLifecycle(manifest);
      const now = new Date().toISOString();
      this.store.transaction(() => {
        this.store.updatePluginState(pluginId, 'enabled');
        this.store.updatePluginLastEnabled(pluginId, now);
        this.store.recordEvent(pluginId, 'enabled', { version: pluginRecord.version });
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
  public async disable(pluginId: string): Promise<void> {
    const pluginRecord = this.store.getPlugin(pluginId);
    if (!pluginRecord) {
      throw new PluginLifecycleError(`Cannot disable plugin '${pluginId}': not installed`);
    }

    if (this.loader.getPlugin(pluginId)) {
      await this.loader.disable(pluginId);
    }

    this.store.transaction(() => {
      this.store.updatePluginState(pluginId, 'disabled');
      this.store.recordEvent(pluginId, 'disabled', { version: pluginRecord.version });
    });
  }

  /**
   * Upgrades a plugin to a new manifest / version.
   */
  public async upgrade(newManifest: PluginManifest): Promise<void> {
    const hostEntry = this.loader.authorizeManifest(newManifest);
    this.loader.validateManifest(newManifest);
    const existing = this.store.getPlugin(newManifest.id);
    if (!existing) {
      throw new PluginLifecycleError(`Cannot upgrade plugin '${newManifest.id}': plugin is not installed`);
    }

    const oldVersion = existing.version;
    this.registerManifest(newManifest);

    const now = new Date().toISOString();
    const wasEnabled = existing.state === 'enabled';

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

        this.store.recordEvent(newManifest.id, 'upgraded', {
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
    if (!previous) throw new PluginLifecycleError(`Cannot restore ${pluginId}@${version}: catalog manifest unavailable`);
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
    if (!record || record.version !== version || record.state !== 'enabled' || !manifest ||
      loaded?.manifest !== manifest || loaded.status !== 'enabled') {
      throw new PluginLifecycleError(`Cannot recover quarantine for ${pluginId}@${version}: durable state or exact loaded manifest mismatch`);
    }
    this.registry.clearProviderQuarantine(pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
    for (const provision of manifest.provides) {
      try { this.registry.activateProvider(provision.capability, pluginId); } catch { /* non-replaceable provider */ }
    }
  }

  /**
   * Downgrades a plugin to a previously preserved version.
   */
  public async downgrade(pluginId: string, targetVersion: string): Promise<void> {
    const existing = this.store.getPlugin(pluginId);
    if (!existing) {
      throw new PluginLifecycleError(`Cannot downgrade plugin '${pluginId}': plugin is not installed`);
    }

    const targetManifest = this.resolveManifest(pluginId, targetVersion);
    if (!targetManifest) {
      throw new PluginLifecycleError(
        `Cannot downgrade plugin '${pluginId}' to '${targetVersion}': version is not available in the host catalog`,
      );
    }
    const hostEntry = this.loader.authorizeManifest(targetManifest);
    this.loader.validateManifest(targetManifest);

    const oldVersion = existing.version;
    const wasEnabled = existing.state === 'enabled';

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

        this.store.recordEvent(pluginId, 'downgraded', {
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
  public async uninstall(pluginId: string, options?: { force?: boolean }): Promise<void> {
    const existing = this.store.getPlugin(pluginId);
    if (!existing) {
      return; // Idempotent
    }

    if (!options?.force) {
      const blast = this.dependencyGraph.calculateBlastRadius(pluginId);
      if (blast.directDependents.length > 0) {
        throw new PluginLifecycleError(
          `Cannot uninstall plugin '${pluginId}': it is required by ${blast.directDependents.join(', ')}. Use --force to override.`,
        );
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
    });

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
    const records = this.store.listPlugins();
    const restored: string[] = [];

    for (const record of records) {
      if (record.state === 'enabled') {
        this.registry.quarantineProvider(record.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
        const manifest = this.resolveManifest(record.id, record.version);
        if (!manifest) {
          console.warn(`[modus] Startup sync: cannot find manifest for enabled plugin '${record.id}'`);
          this.registry.quarantineProvider(record.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
          const loadedPlugin = this.loader.getPlugin(record.id);
          if (loadedPlugin && loadedPlugin.manifest.version !== record.version) {
            await this.loader.unload(record.id).catch(() => undefined);
          }
          this.store.transaction(() => {
            this.store.updatePluginState(record.id, 'error');
            this.store.recordEvent(record.id, 'sync_error', {
              error: `Plugin "${record.id}@${record.version}" is not available in the host catalog`,
            });
          });
          continue;
        }

        try {
          // A loaded plugin with the same ID is not proof that it is the
          // catalog-authorized version persisted in state. Reconcile identity
          // as well as version before enabling it.
          const loadedPlugin = this.loader.getPlugin(record.id);
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
          }
          await this.loader.enableFromHostLifecycle(manifest);
          this.releaseQuarantineAfterDurableEnable(record.id, record.version);
          restored.push(record.id);
        } catch (err) {
          console.error(`[modus] Startup sync: failed to enable plugin '${record.id}':`, err);
          this.registry.quarantineProvider(record.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
          this.store.transaction(() => {
            this.store.updatePluginState(record.id, 'error');
            this.store.recordEvent(record.id, 'sync_error', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    }

    return restored;
  }
}
