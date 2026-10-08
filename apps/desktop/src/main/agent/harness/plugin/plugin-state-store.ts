/**
 * Modus Harness Evolution — Fase 11: Plugin Lifecycle
 * SQLite State Storage for plugin tracking, version history, provisions, permissions, and audit trail.
 */

import { DatabaseSync } from 'node:sqlite';
import type { TrustLevel } from '../capability/capability-types';
import type { PluginManifest } from './plugin-types';

export type PersistentPluginState = 'installed' | 'enabled' | 'disabled' | 'error';

export interface PluginRecord {
  id: string;
  version: string;
  state: PersistentPluginState;
  trust_level: TrustLevel;
  installed_at: string;
  last_enabled: string | null;
  config: Record<string, unknown> | null;
}

export interface PluginVersionRecord {
  plugin_id: string;
  version: string;
  manifest: PluginManifest;
  installed_at: string;
}

export interface PluginCapabilityRecord {
  plugin_id: string;
  capability_id: string;
  api_version: string;
}

export interface PluginPermissionRecord {
  plugin_id: string;
  permissions: unknown;
}

export interface PluginEventRecord {
  id: number;
  plugin_id: string;
  event_type: string;
  timestamp: string;
  details: Record<string, unknown> | null;
}

export class PluginStateStore {
  private db: DatabaseSync;
  private inTransaction = false;

  constructor(dbOrPath?: DatabaseSync | string) {
    if (typeof dbOrPath === 'string') {
      this.db = new DatabaseSync(dbOrPath);
    } else {
      this.db = dbOrPath ?? new DatabaseSync(':memory:');
    }
    // The schema declares FOREIGN KEYs: enforce them (node:sqlite leaves
    // foreign_keys OFF by default). All multi-table writes delete children
    // before parents, so this only forbids orphan rows, never legit flows.
    this.db.exec('PRAGMA foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('installed', 'enabled', 'disabled', 'error')),
        trust_level TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        last_enabled TEXT,
        config TEXT
      );

      CREATE TABLE IF NOT EXISTS plugin_versions (
        plugin_id TEXT NOT NULL,
        version TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, version),
        FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS plugin_capabilities (
        plugin_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        api_version TEXT NOT NULL,
        PRIMARY KEY (plugin_id, capability_id),
        FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS plugin_permissions (
        plugin_id TEXT PRIMARY KEY,
        permissions_json TEXT NOT NULL,
        FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS plugin_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        details_json TEXT,
        FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_plugin_events_plugin_id ON plugin_events(plugin_id);
    `);
  }

  public getDatabase(): DatabaseSync {
    return this.db;
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore if already closed
    }
  }

  /**
   * Re-entrant transaction wrapper (synchronous bodies only).
   */
  public transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn();
    }
    this.inTransaction = true;
    this.db.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      if (result instanceof Promise) {
        // An async body would COMMIT before its statements run and lose
        // atomicity silently: roll back and refuse loudly instead.
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Ignored
        }
        throw new Error('PluginStateStore.transaction() does not support async callbacks');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  // --- Plugins ---

  public savePlugin(record: PluginRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO plugins (id, version, state, trust_level, installed_at, last_enabled, config)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        state = excluded.state,
        trust_level = excluded.trust_level,
        installed_at = excluded.installed_at,
        last_enabled = excluded.last_enabled,
        config = excluded.config
    `);

    stmt.run(
      record.id,
      record.version,
      record.state,
      record.trust_level,
      record.installed_at,
      record.last_enabled,
      record.config ? JSON.stringify(record.config) : null,
    );
  }

  public getPlugin(id: string): PluginRecord | null {
    const stmt = this.db.prepare('SELECT * FROM plugins WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: row.id as string,
      version: row.version as string,
      state: row.state as PersistentPluginState,
      trust_level: row.trust_level as TrustLevel,
      installed_at: row.installed_at as string,
      last_enabled: (row.last_enabled as string | null) ?? null,
      config: row.config ? JSON.parse(row.config as string) : null,
    };
  }

  public listPlugins(options?: { enabledOnly?: boolean }): PluginRecord[] {
    const query = options?.enabledOnly
      ? "SELECT * FROM plugins WHERE state = 'enabled' ORDER BY id ASC"
      : 'SELECT * FROM plugins ORDER BY id ASC';

    const rows = this.db.prepare(query).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      version: row.version as string,
      state: row.state as PersistentPluginState,
      trust_level: row.trust_level as TrustLevel,
      installed_at: row.installed_at as string,
      last_enabled: (row.last_enabled as string | null) ?? null,
      config: row.config ? JSON.parse(row.config as string) : null,
    }));
  }

  public updatePluginState(id: string, state: PersistentPluginState): void {
    const stmt = this.db.prepare('UPDATE plugins SET state = ? WHERE id = ?');
    stmt.run(state, id);
  }

  public updatePluginLastEnabled(id: string, timestamp: string): void {
    const stmt = this.db.prepare('UPDATE plugins SET last_enabled = ? WHERE id = ?');
    stmt.run(timestamp, id);
  }

  public deletePlugin(id: string): void {
    const stmt = this.db.prepare('DELETE FROM plugins WHERE id = ?');
    stmt.run(id);
  }

  // --- Plugin Versions ---

  public saveVersion(
    pluginId: string,
    version: string,
    manifest: PluginManifest,
    installedAt?: string,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO plugin_versions (plugin_id, version, manifest_json, installed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_id, version) DO UPDATE SET
        manifest_json = excluded.manifest_json,
        installed_at = excluded.installed_at
    `);

    stmt.run(
      pluginId,
      version,
      JSON.stringify(manifest),
      installedAt ?? new Date().toISOString(),
    );
  }

  public getVersion(pluginId: string, version: string): PluginVersionRecord | null {
    const stmt = this.db.prepare(
      'SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ?',
    );
    const row = stmt.get(pluginId, version) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      plugin_id: row.plugin_id as string,
      version: row.version as string,
      manifest: JSON.parse(row.manifest_json as string),
      installed_at: row.installed_at as string,
    };
  }

  public getVersions(pluginId: string): PluginVersionRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM plugin_versions WHERE plugin_id = ? ORDER BY installed_at DESC, rowid DESC',
    );
    const rows = stmt.all(pluginId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      plugin_id: row.plugin_id as string,
      version: row.version as string,
      manifest: JSON.parse(row.manifest_json as string),
      installed_at: row.installed_at as string,
    }));
  }

  // --- Plugin Capabilities ---

  public saveCapabilities(
    pluginId: string,
    caps: Array<{ capability: string; apiVersion: string }>,
  ): void {
    const delStmt = this.db.prepare('DELETE FROM plugin_capabilities WHERE plugin_id = ?');
    delStmt.run(pluginId);

    const insStmt = this.db.prepare(`
      INSERT INTO plugin_capabilities (plugin_id, capability_id, api_version)
      VALUES (?, ?, ?)
    `);

    for (const c of caps) {
      insStmt.run(pluginId, c.capability, c.apiVersion);
    }
  }

  public getCapabilities(pluginId: string): PluginCapabilityRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM plugin_capabilities WHERE plugin_id = ? ORDER BY capability_id ASC',
    );
    const rows = stmt.all(pluginId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      plugin_id: row.plugin_id as string,
      capability_id: row.capability_id as string,
      api_version: row.api_version as string,
    }));
  }

  // --- Plugin Permissions ---

  public savePermissions(pluginId: string, permissions: unknown): void {
    const stmt = this.db.prepare(`
      INSERT INTO plugin_permissions (plugin_id, permissions_json)
      VALUES (?, ?)
      ON CONFLICT(plugin_id) DO UPDATE SET
        permissions_json = excluded.permissions_json
    `);
    stmt.run(pluginId, JSON.stringify(permissions ?? null));
  }

  public getPermissions(pluginId: string): unknown | null {
    const stmt = this.db.prepare(
      'SELECT permissions_json FROM plugin_permissions WHERE plugin_id = ?',
    );
    const row = stmt.get(pluginId) as { permissions_json: string } | undefined;
    if (!row || !row.permissions_json) return null;
    return JSON.parse(row.permissions_json);
  }

  // --- Plugin Events ---

  public recordEvent(
    pluginId: string,
    eventType: string,
    details?: Record<string, unknown> | null,
  ): PluginEventRecord {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO plugin_events (plugin_id, event_type, timestamp, details_json)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(
      pluginId,
      eventType,
      now,
      details ? JSON.stringify(details) : null,
    );

    return {
      id: Number(result.lastInsertRowid),
      plugin_id: pluginId,
      event_type: eventType,
      timestamp: now,
      details: details ?? null,
    };
  }

  public getEvents(pluginId: string, limit = 50): PluginEventRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM plugin_events WHERE plugin_id = ? ORDER BY id DESC LIMIT ?
    `);
    const rows = stmt.all(pluginId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as number,
      plugin_id: row.plugin_id as string,
      event_type: row.event_type as string,
      timestamp: row.timestamp as string,
      details: row.details_json ? JSON.parse(row.details_json as string) : null,
    }));
  }
}
