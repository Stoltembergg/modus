/**
 * Modus Harness Evolution — Fase 15: Rollback e Safe Mode
 * Plugin Version Manager for deterministic backups, version preservation and rollback operations.
 */

import type { PluginLifecycleService } from "./plugin-lifecycle-service";
import type { PluginBackup } from "./plugin-rollback-types";
import type { PluginStateStore } from "./plugin-state-store";
import { PluginLifecycleError } from "./plugin-types";

export class PluginVersionManager {
  private service: PluginLifecycleService;
  private store: PluginStateStore;
  private backups: Map<string, PluginBackup> = new Map();

  constructor(service: PluginLifecycleService, store: PluginStateStore) {
    this.service = service;
    this.store = store;
  }

  /**
   * Preserves a snapshot of a plugin version before an upgrade or change.
   */
  public async preserveVersion(
    pluginId: string,
    version?: string,
    customConfig?: Record<string, unknown>,
  ): Promise<PluginBackup> {
    const pluginRecord = this.store.getPlugin(pluginId);
    const targetVersion = version ?? pluginRecord?.version;

    if (!targetVersion) {
      throw new PluginLifecycleError(
        `Cannot preserve version for '${pluginId}': no version specified or installed`,
      );
    }

    const manifest = this.service.resolveManifest(pluginId, targetVersion);
    if (!manifest) {
      throw new PluginLifecycleError(
        `Cannot preserve version for '${pluginId}': manifest for version ${targetVersion} is not available in the host catalog`,
      );
    }

    const resolvedManifest = manifest;
    const now = new Date().toISOString();

    const backup: PluginBackup = {
      pluginId,
      version: targetVersion,
      manifest: resolvedManifest,
      config: customConfig ?? pluginRecord?.config ?? null,
      preservedAt: now,
    };

    const key = `${pluginId}@${targetVersion}`;
    this.backups.set(key, backup);

    // Ensure version record exists in durable SQLite storage
    this.store.saveVersion(pluginId, targetVersion, resolvedManifest, now);

    return backup;
  }

  /**
   * Loads a preserved backup for a plugin version.
   */
  public async loadBackup(pluginId: string, version: string): Promise<PluginBackup | null> {
    const key = `${pluginId}@${version}`;
    const cached = this.backups.get(key);
    if (cached) return cached;

    const verRecord = this.store.getVersion(pluginId, version);
    if (!verRecord) return null;

    const pluginRecord = this.store.getPlugin(pluginId);
    const backup: PluginBackup = {
      pluginId,
      version,
      manifest: verRecord.manifest,
      config: pluginRecord?.config ?? null,
      preservedAt: verRecord.installed_at,
    };

    this.backups.set(key, backup);
    return backup;
  }

  /**
   * Rolls back a plugin to a target version.
   */
  public async rollback(pluginId: string, targetVersion: string): Promise<void> {
    if (!this.service.resolveManifest(pluginId, targetVersion)) {
      throw new PluginLifecycleError(
        `Cannot rollback untrusted or unavailable version ${pluginId}@${targetVersion}`,
      );
    }
    const backup = await this.loadBackup(pluginId, targetVersion);
    if (!backup) {
      throw new PluginLifecycleError(
        `Cannot rollback plugin '${pluginId}' to '${targetVersion}': backup not found`,
      );
    }

    // Execute transactional downgrade
    if (!this.service.resolveManifest(pluginId, targetVersion)) {
      throw new PluginLifecycleError(
        `Cannot rollback untrusted or unavailable version ${pluginId}@${targetVersion}`,
      );
    }
    await this.service.downgrade(pluginId, targetVersion);
  }

  /**
   * Lists all preserved versions for a plugin, ordered latest first.
   */
  public async listVersions(pluginId: string): Promise<PluginBackup[]> {
    const dbVersions = this.store.getVersions(pluginId);
    const results: PluginBackup[] = [];
    const seen = new Set<string>();

    for (const v of dbVersions) {
      seen.add(v.version);
      results.push({
        pluginId,
        version: v.version,
        manifest: v.manifest,
        config: null,
        preservedAt: v.installed_at,
      });
    }

    for (const [key, b] of this.backups.entries()) {
      if (b.pluginId === pluginId && !seen.has(b.version)) {
        results.push(b);
      }
    }

    return results.sort(
      (a, b) => new Date(b.preservedAt).getTime() - new Date(a.preservedAt).getTime(),
    );
  }

  /**
   * Finds the latest backup prior to current or excluded version.
   */
  public async getLatestBackup(
    pluginId: string,
    excludeVersion?: string,
  ): Promise<PluginBackup | null> {
    const versions = await this.listVersions(pluginId);
    const candidates = excludeVersion
      ? versions.filter((v) => v.version !== excludeVersion)
      : versions;
    return candidates[0] ?? null;
  }
}
