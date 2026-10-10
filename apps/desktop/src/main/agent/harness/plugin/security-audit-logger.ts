/**
 * @file security-audit-logger.ts
 * Bounded, durable, cryptographically chained records for host security decisions.
 *
 * The hash chain makes accidental or partial changes detectable; it is not a
 * cryptographic signature or a boundary against a process with database access.
 */

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDatabase } from "../../../db/database";
import type { SecurityAuditEntry } from "./plugin-isolation-types";

export const GENESIS_HASH = "0".repeat(64);

const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 8_192;
const MAX_PLUGIN_ID_LENGTH = 128;
const MAX_ACTION_LENGTH = 128;
const MAX_RESOURCE_LENGTH = 4096;
const MAX_REASON_LENGTH = 2048;

export interface SecurityAuditFilter {
  pluginId?: string | undefined;
  decision?: "allow" | "deny" | undefined;
  action?: string | undefined;
  limit?: number | undefined;
}

export interface SecurityAuditLoggerOptions {
  /** Existing application SQLite connection; omitted only by the production singleton. */
  database?: DatabaseSync | undefined;
  /** Retained entries and in-memory snapshots. Defaults to and is capped at 10,000. */
  maxEntries?: number | undefined;
}

type StoredEntry = {
  sequence: number;
  entry: SecurityAuditEntry;
};

type AuditEntryRow = {
  sequence: number;
  id: string;
  timestamp: number;
  plugin_id: string;
  action: string;
  resource: string;
  decision: "allow" | "deny";
  reason: string;
  hash: string;
  previous_hash: string;
};

type AuditStateRow = {
  anchor_hash: string;
  latest_hash: string;
  next_sequence: number;
  revision: number;
};

type ChainVerification = { valid: true } | { valid: false; brokenAtIndex: number; reason: string };

function hashEntry(
  sequence: number,
  id: string,
  previousHash: string,
  timestamp: number,
  pluginId: string,
  action: string,
  resource: string,
  decision: "allow" | "deny",
  reason: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        sequence,
        id,
        previousHash,
        timestamp,
        pluginId,
        action,
        resource,
        decision,
        reason,
      ]),
    )
    .digest("hex");
}

function snapshot(entry: SecurityAuditEntry): SecurityAuditEntry {
  return Object.freeze({ ...entry });
}

function asEntry(row: AuditEntryRow): SecurityAuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    pluginId: row.plugin_id,
    action: row.action,
    resource: row.resource,
    decision: row.decision,
    ...(row.reason ? { reason: row.reason } : {}),
    hash: row.hash,
    previousHash: row.previous_hash,
  };
}

export class SecurityAuditLogger {
  private static instance: SecurityAuditLogger | null = null;
  private readonly database: DatabaseSync;
  private readonly maxEntries: number;
  private entries: StoredEntry[] = [];
  private anchorHash = GENESIS_HASH;
  private latestHash = GENESIS_HASH;
  private nextSequence = 1;
  private databaseVersion = 0;
  private auditRevision = 0;
  private integrityFailure: string | undefined;

  constructor(options: SecurityAuditLoggerOptions = {}) {
    this.database = options.database ?? getDatabase();
    const requestedLimit = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxEntries = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(DEFAULT_MAX_ENTRIES, Math.floor(requestedLimit)))
      : DEFAULT_MAX_ENTRIES;
    this.ensureSchema();
    this.hydrate();
  }

  public static getInstance(options?: SecurityAuditLoggerOptions): SecurityAuditLogger {
    if (!SecurityAuditLogger.instance) {
      SecurityAuditLogger.instance = new SecurityAuditLogger(options);
    }
    return SecurityAuditLogger.instance;
  }

  /** Drops only the in-process singleton. Durable audit records remain untouched. */
  public static resetInstance(): void {
    SecurityAuditLogger.instance = null;
  }

  public log(params: {
    pluginId: string;
    action: string;
    resource: string;
    decision: "allow" | "deny";
    reason?: string | undefined;
    timestamp?: number | undefined;
  }): SecurityAuditEntry {
    this.assertBoundedInput(params);
    if (this.integrityFailure) {
      throw new Error(`Security audit chain is unavailable: ${this.integrityFailure}`);
    }

    const timestamp = params.timestamp ?? Date.now();
    const reason = params.reason ?? "";
    const entryId = randomUUID();
    const sequence = this.nextSequence;
    const previousHash = this.latestHash;
    const hash = hashEntry(
      sequence,
      entryId,
      previousHash,
      timestamp,
      params.pluginId,
      params.action,
      params.resource,
      params.decision,
      reason,
    );

    this.database.exec("begin immediate");
    let anchorHash = this.anchorHash;
    let auditRevision = this.auditRevision;
    try {
      const databaseVersion = this.readDatabaseVersion();
      const state = this.readState();
      if (
        state.anchor_hash !== this.anchorHash ||
        state.latest_hash !== this.latestHash ||
        state.next_sequence !== this.nextSequence
      ) {
        const reason = "Audit log was changed by another writer; refusing to append.";
        this.integrityFailure = reason;
        throw new Error(reason);
      }
      if (databaseVersion !== this.databaseVersion || state.revision !== this.auditRevision) {
        const rows = this.readRows();
        const verification = SecurityAuditLogger.verifyRows(state, rows, this.maxEntries);
        if (!verification.valid) {
          this.integrityFailure = verification.reason;
          throw new Error(`Security audit chain is unavailable: ${verification.reason}`);
        }
      }

      this.database
        .prepare(
          `insert into security_audit_events
           (sequence, id, timestamp, plugin_id, action, resource, decision, reason, hash, previous_hash)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sequence,
          entryId,
          timestamp,
          params.pluginId,
          params.action,
          params.resource,
          params.decision,
          reason,
          hash,
          previousHash,
        );

      const countRow = this.database
        .prepare("select count(*) as count from security_audit_events")
        .get() as { count: number };
      const excess = countRow.count - this.maxEntries;
      if (excess > 0) {
        const prunedRows = this.database
          .prepare("select sequence, hash from security_audit_events order by sequence asc limit ?")
          .all(excess) as Array<{ sequence: number; hash: string }>;
        const checkpoint = prunedRows.at(-1);
        if (!checkpoint) throw new Error("Unable to establish audit retention checkpoint.");
        anchorHash = checkpoint.hash;
        this.database
          .prepare("delete from security_audit_events where sequence <= ?")
          .run(checkpoint.sequence);
      }

      this.database
        .prepare(
          `update security_audit_state
           set anchor_hash = ?, latest_hash = ?, next_sequence = ?
           where singleton = 1`,
        )
        .run(anchorHash, hash, sequence + 1);
      auditRevision = this.readState().revision;
      this.database.exec("commit");
      this.databaseVersion = databaseVersion;
    } catch (error) {
      try {
        this.database.exec("rollback");
      } catch {
        // Keep the original persistence error.
      }
      if (error instanceof Error && error.message.includes("changed by another writer")) {
        this.integrityFailure = error.message;
      }
      throw error;
    }

    const entry: SecurityAuditEntry = {
      id: entryId,
      timestamp,
      pluginId: params.pluginId,
      action: params.action,
      resource: params.resource,
      decision: params.decision,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      hash,
      previousHash,
    };
    this.anchorHash = anchorHash;
    this.latestHash = hash;
    this.nextSequence = sequence + 1;
    this.auditRevision = auditRevision;
    this.entries = this.entries.filter((stored) => stored.sequence > sequence - this.maxEntries);
    this.entries.push({ sequence, entry });
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    return snapshot(entry);
  }

  public getEntries(filter?: SecurityAuditFilter): SecurityAuditEntry[] {
    let result = this.entries.map(({ entry }) => entry);

    if (filter?.pluginId) {
      result = result.filter((entry) => entry.pluginId === filter.pluginId);
    }
    if (filter?.decision) {
      result = result.filter((entry) => entry.decision === filter.decision);
    }
    if (filter?.action) {
      result = result.filter((entry) => entry.action === filter.action);
    }
    if (filter?.limit !== undefined && Number.isFinite(filter.limit) && filter.limit > 0) {
      result = result.slice(-Math.min(this.maxEntries, Math.floor(filter.limit)));
    }

    return result.map(snapshot);
  }

  /** Verifies the retained chain from its durable checkpoint through the latest entry. */
  public verifyChain(): { valid: boolean; brokenAtIndex?: number; reason?: string } {
    this.database.exec("begin");
    let result: ChainVerification;
    try {
      const state = this.readState();
      const rows = this.readRows();
      result = SecurityAuditLogger.verifyRows(state, rows, this.maxEntries);
      this.database.exec("commit");
    } catch (error) {
      try {
        this.database.exec("rollback");
      } catch {
        // Preserve the verification failure.
      }
      throw error;
    }
    if (!result.valid) {
      this.integrityFailure = result.reason;
      return result;
    }
    return { valid: true };
  }

  private ensureSchema(): void {
    this.database.exec(`
      create table if not exists security_audit_state (
        singleton integer primary key check (singleton = 1),
        anchor_hash text not null,
        latest_hash text not null,
        next_sequence integer not null check (next_sequence >= 1),
        revision integer not null default 0 check (revision >= 0)
      );
      insert or ignore into security_audit_state
        (singleton, anchor_hash, latest_hash, next_sequence)
        values (1, '${GENESIS_HASH}', '${GENESIS_HASH}', 1);
      create table if not exists security_audit_events (
        sequence integer primary key,
        id text not null unique,
        timestamp integer not null,
        plugin_id text not null,
        action text not null,
        resource text not null,
        decision text not null check (decision in ('allow','deny')),
        reason text not null,
        hash text not null,
        previous_hash text not null
      );
    `);
    const stateColumns = this.database
      .prepare("pragma table_info(security_audit_state)")
      .all() as Array<{ name: string }>;
    if (!stateColumns.some((column) => column.name === "revision")) {
      this.database.exec(
        "alter table security_audit_state add column revision integer not null default 0 check (revision >= 0)",
      );
    }
    this.database.exec(`
      create trigger if not exists security_audit_events_revision_insert
      after insert on security_audit_events
      begin
        update security_audit_state set revision = revision + 1 where singleton = 1;
      end;
      create trigger if not exists security_audit_events_revision_update
      after update on security_audit_events
      begin
        update security_audit_state set revision = revision + 1 where singleton = 1;
      end;
      create trigger if not exists security_audit_events_revision_delete
      after delete on security_audit_events
      begin
        update security_audit_state set revision = revision + 1 where singleton = 1;
      end;
    `);
  }

  private hydrate(): void {
    this.database.exec("begin immediate");
    try {
      this.databaseVersion = this.readDatabaseVersion();
      const state = this.readState();
      const rows = this.readRows();
      this.anchorHash = state.anchor_hash;
      this.latestHash = state.latest_hash;
      this.nextSequence = state.next_sequence;
      this.auditRevision = state.revision;
      this.entries = rows.map((row) => ({ sequence: row.sequence, entry: asEntry(row) }));
      if (this.entries.length > this.maxEntries) {
        this.entries = this.entries.slice(-this.maxEntries);
      }

      const verification = SecurityAuditLogger.verifyRows(state, rows, this.maxEntries);
      if (!verification.valid) this.integrityFailure = verification.reason;
      this.database.exec("commit");
    } catch (error) {
      try {
        this.database.exec("rollback");
      } catch {
        // Preserve the schema or hydration failure.
      }
      throw error;
    }
  }

  private readDatabaseVersion(): number {
    const row = this.database.prepare("pragma data_version").get() as
      | { data_version: number }
      | undefined;
    if (!row || !Number.isSafeInteger(row.data_version)) {
      throw new Error("Unable to read security audit database version.");
    }
    return row.data_version;
  }

  private readState(): AuditStateRow {
    const state = this.database
      .prepare(
        `select anchor_hash, latest_hash, next_sequence, revision
         from security_audit_state where singleton = 1`,
      )
      .get() as AuditStateRow | undefined;
    if (!state) throw new Error("Security audit state is missing.");
    return state;
  }

  private readRows(): AuditEntryRow[] {
    const rows = this.database
      .prepare(
        `select sequence, id, timestamp, plugin_id, action, resource, decision, reason, hash, previous_hash
         from security_audit_events order by sequence desc limit ?`,
      )
      .all(this.maxEntries + 1) as AuditEntryRow[];
    return rows.reverse();
  }

  private assertBoundedInput(params: {
    pluginId: string;
    action: string;
    resource: string;
    decision: "allow" | "deny";
    reason?: string | undefined;
    timestamp?: number | undefined;
  }): void {
    if (
      typeof params.pluginId !== "string" ||
      !params.pluginId ||
      typeof params.action !== "string" ||
      params.pluginId.length > MAX_PLUGIN_ID_LENGTH ||
      !params.action ||
      params.action.length > MAX_ACTION_LENGTH ||
      typeof params.resource !== "string" ||
      params.resource.length > MAX_RESOURCE_LENGTH ||
      (params.reason !== undefined && typeof params.reason !== "string") ||
      (params.reason?.length ?? 0) > MAX_REASON_LENGTH ||
      !["allow", "deny"].includes(params.decision) ||
      (params.timestamp !== undefined && !Number.isSafeInteger(params.timestamp))
    ) {
      throw new Error("Security audit entry exceeds supported bounds.");
    }
    if (
      Buffer.byteLength(
        JSON.stringify([
          params.pluginId,
          params.action,
          params.resource,
          params.decision,
          params.reason ?? "",
        ]),
        "utf8",
      ) > MAX_ENTRY_BYTES
    ) {
      throw new Error("Security audit entry exceeds supported bounds.");
    }
  }

  private static verifyRows(
    state: AuditStateRow,
    rows: AuditEntryRow[],
    maxEntries: number,
  ): ChainVerification {
    if (rows.length > maxEntries) {
      return {
        valid: false,
        brokenAtIndex: maxEntries,
        reason: "Retained audit entries exceed the configured bound.",
      };
    }
    let previousHash = state.anchor_hash;
    let previousSequence: number | undefined;

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!row) continue;
      if (previousSequence !== undefined && row.sequence !== previousSequence + 1) {
        return {
          valid: false,
          brokenAtIndex: index,
          reason: `Audit sequence gap at retained entry ${index}.`,
        };
      }
      if (row.previous_hash !== previousHash) {
        return {
          valid: false,
          brokenAtIndex: index,
          reason: `Audit chain link mismatch at retained entry ${index}.`,
        };
      }
      const expectedHash = hashEntry(
        row.sequence,
        row.id,
        row.previous_hash,
        row.timestamp,
        row.plugin_id,
        row.action,
        row.resource,
        row.decision,
        row.reason,
      );
      if (row.hash !== expectedHash) {
        return {
          valid: false,
          brokenAtIndex: index,
          reason: `Audit entry integrity mismatch at retained entry ${index}.`,
        };
      }
      previousHash = row.hash;
      previousSequence = row.sequence;
    }

    if (previousHash !== state.latest_hash) {
      return {
        valid: false,
        brokenAtIndex: rows.length,
        reason: "Audit latest hash does not match persisted state.",
      };
    }
    if (previousSequence !== undefined && state.next_sequence !== previousSequence + 1) {
      return {
        valid: false,
        brokenAtIndex: rows.length,
        reason: "Audit next sequence does not follow the retained chain.",
      };
    }
    if (rows.length === 0 && state.anchor_hash !== state.latest_hash) {
      return {
        valid: false,
        brokenAtIndex: 0,
        reason: "Audit checkpoint does not match the latest hash.",
      };
    }
    return { valid: true };
  }
}
