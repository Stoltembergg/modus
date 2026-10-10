import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDatabase } from "../../../db/database";

export type GroupMessage = {
  id: string;
  groupId: string;
  from: string;
  to: string;
  content: string;
  revision: number;
  sentAt: string;
  ackedAt?: string | undefined;
  dedupeHash: string;
};

export type GroupMailboxConfig = {
  /** Retention for acknowledged messages. Default: 7 days. */
  ackRetentionMs: number;
  /** Retention for unacknowledged messages. Default: 30 days. */
  unackRetentionMs: number;
  /** Maximum stored messages per recipient agent (FIFO purge). Default: 1000. */
  maxMessagesPerAgent: number;
  /** Deduplication window in ms. Default: 24h. */
  dedupeWindowMs: number;
};

export const DEFAULT_MAILBOX_CONFIG: GroupMailboxConfig = {
  ackRetentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  unackRetentionMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  maxMessagesPerAgent: 1000,
  dedupeWindowMs: 24 * 60 * 60 * 1000, // 24 hours
};

type GroupMailboxRow = {
  id: string;
  group_id: string;
  from_agent: string;
  to_agent: string;
  content: string;
  revision: number;
  sent_at: string;
  acked_at: string | null;
  dedupe_hash: string;
};

type MailboxPersistenceStatements = {
  findDuplicate: ReturnType<DatabaseSync["prepare"]>;
  insertMessage: ReturnType<DatabaseSync["prepare"]>;
  enforceCapacity: ReturnType<DatabaseSync["prepare"]>;
  purgeExpired: ReturnType<DatabaseSync["prepare"]>;
  hasExpiredGlobally: ReturnType<DatabaseSync["prepare"]>;
  hasExpiredForGroup: ReturnType<DatabaseSync["prepare"]>;
  hasOverCapacityForGroup: ReturnType<DatabaseSync["prepare"]>;
  purgeExpiredForGroup: ReturnType<DatabaseSync["prepare"]>;
  normalizeCapacityForGroup: ReturnType<DatabaseSync["prepare"]>;
};

function messageFromRow(row: GroupMailboxRow): GroupMessage {
  return {
    id: row.id,
    groupId: row.group_id,
    from: row.from_agent,
    to: row.to_agent,
    content: row.content,
    revision: row.revision,
    sentAt: row.sent_at,
    ackedAt: row.acked_at ?? undefined,
    dedupeHash: row.dedupe_hash,
  };
}

export function computeMessageDedupeHash(
  from: string,
  to: string,
  content: string,
  groupId: string = "",
): string {
  return createHash("sha256")
    .update(JSON.stringify([groupId, from, to, content.trim()]))
    .digest("hex");
}

export class GroupMailbox {
  private static instance: GroupMailbox | null = null;
  private readonly persistenceStatements = new WeakMap<
    DatabaseSync,
    MailboxPersistenceStatements
  >();
  private config: GroupMailboxConfig;

  constructor(
    config: Partial<GroupMailboxConfig> = {},
    private readonly dbProvider: () => DatabaseSync = getDatabase,
  ) {
    this.config = { ...DEFAULT_MAILBOX_CONFIG, ...config };
  }

  private requireDb(): DatabaseSync {
    try {
      return this.dbProvider();
    } catch (cause) {
      throw new Error("Group mailbox durable storage is unavailable.", { cause });
    }
  }

  private getPersistenceStatements(db: DatabaseSync): MailboxPersistenceStatements {
    const existing = this.persistenceStatements.get(db);
    if (existing) return existing;

    const statements: MailboxPersistenceStatements = {
      findDuplicate: db.prepare(
        `select id, sent_at from harness_group_messages
          where dedupe_hash = ? order by sent_at desc, rowid desc limit 1`,
      ),
      insertMessage: db.prepare(
        `insert into harness_group_messages
         (id, group_id, from_agent, to_agent, content, revision, sent_at, acked_at, dedupe_hash)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      enforceCapacity: db.prepare(
        `delete from harness_group_messages
          where id in (
            select id from harness_group_messages
             where group_id = ? and to_agent = ?
             order by sent_at desc, rowid desc
             limit -1 offset ?
          )`,
      ),
      purgeExpired: db.prepare(
        `delete from harness_group_messages
          where (acked_at is not null and acked_at < ?)
             or (acked_at is null and sent_at < ?)`,
      ),
      hasExpiredGlobally: db.prepare(
        `select 1 from harness_group_messages
          where acked_at is not null and acked_at < ?
         union all
         select 1 from harness_group_messages
          where acked_at is null and sent_at < ?
         limit 1`,
      ),
      hasExpiredForGroup: db.prepare(
        `select 1 from harness_group_messages
          where group_id = ? and acked_at is not null and acked_at < ?
         union all
         select 1 from harness_group_messages
          where group_id = ? and acked_at is null and sent_at < ?
         limit 1`,
      ),
      hasOverCapacityForGroup: db.prepare(
        `select 1 from harness_group_messages
          where group_id = ?
          group by to_agent having count(*) > ? limit 1`,
      ),
      purgeExpiredForGroup: db.prepare(
        `delete from harness_group_messages
          where group_id = ?
            and ((acked_at is not null and acked_at < ?)
              or (acked_at is null and sent_at < ?))`,
      ),
      normalizeCapacityForGroup: db.prepare(
        `delete from harness_group_messages
          where rowid in (
            select rowid from (
              select rowid, row_number() over (
                partition by to_agent order by sent_at desc, rowid desc
              ) as position
              from harness_group_messages where group_id = ?
            ) ranked where position > ?
          )`,
      ),
    };
    this.persistenceStatements.set(db, statements);
    return statements;
  }

  public static getInstance(
    config?: Partial<GroupMailboxConfig>,
    dbProvider?: () => DatabaseSync,
  ): GroupMailbox {
    if (!GroupMailbox.instance) {
      GroupMailbox.instance = new GroupMailbox(config, dbProvider);
    }
    return GroupMailbox.instance;
  }

  public static resetInstance(): void {
    GroupMailbox.instance = null;
  }

  /**
   * Checks whether a message with identical (from, to, content) was sent within dedupeWindowMs.
   */
  public isDuplicate(
    message: Pick<GroupMessage, "from" | "to" | "content"> & { groupId?: string },
    nowIso?: string,
  ): boolean {
    const hash = computeMessageDedupeHash(
      message.from,
      message.to,
      message.content,
      message.groupId ?? "",
    );
    const existing = this.findInDatabaseByDedupeHash(hash);
    if (!existing) return false;
    const now = nowIso ? Date.parse(nowIso) : Date.now();
    const sentTime = Date.parse(existing.sentAt);
    return now - sentTime <= this.config.dedupeWindowMs;
  }

  /**
   * Sends a message into the mailbox. Returns the message ID.
   * If a duplicate is detected within dedupeWindowMs, returns the existing message ID (idempotent).
   */
  public send(
    messageInput: Omit<GroupMessage, "id" | "dedupeHash" | "sentAt"> & {
      sentAt?: string | undefined;
    },
    nowIso?: string,
  ): string {
    const db = this.requireDb();
    const sentAt = messageInput.sentAt || nowIso || new Date().toISOString();
    const dedupeHash = computeMessageDedupeHash(
      messageInput.from,
      messageInput.to,
      messageInput.content,
      messageInput.groupId,
    );

    const id = randomUUID();
    const message: GroupMessage = {
      ...messageInput,
      id,
      sentAt,
      dedupeHash,
      ackedAt: messageInput.ackedAt,
    };

    // Durability precedes reporting success. A failed write is never exposed
    // as a successful send to the caller.
    return this.persistToDatabase(message, db);
  }

  /**
   * Receives unacknowledged messages for the recipient agent (including broadcasts).
   */
  public receive(agentId: string, limit: number = 50, groupId?: string): GroupMessage[] {
    if (!groupId) return [];
    const db = this.requireDb();
    this.cleanupExpiredAndCapacity(db, Date.now(), groupId);
    const pageSize = Number.isFinite(limit) ? Math.max(0, Math.min(1000, Math.floor(limit))) : 50;
    const rows = db
      .prepare(
        `select m.id, m.group_id, m.from_agent, m.to_agent, m.content, m.revision,
                m.sent_at, m.acked_at, m.dedupe_hash
           from harness_group_messages m
          where ((m.to_agent = ? and m.group_id = ? and m.acked_at is null)
            or (m.to_agent = '*' and m.group_id = ? and m.from_agent <> ? and not exists (
              select 1 from harness_group_message_acks a
               where a.message_id = m.id and a.agent_id = ?
            )))
          order by m.sent_at asc, m.rowid asc limit ?`,
      )
      .all(agentId, groupId, groupId, agentId, agentId, pageSize) as GroupMailboxRow[];
    return rows.map(messageFromRow);
  }

  /**
   * Acknowledges receipt of a message by agentId.
   */
  public ack(messageId: string, agentId: string, nowIso?: string, groupId?: string): boolean {
    return this.ackMany([messageId], agentId, groupId, nowIso).success;
  }

  /** Atomically acknowledges a set of messages visible to one group member. */
  public ackMany(
    messageIds: string[],
    agentId: string,
    groupId?: string,
    nowIso?: string,
  ): { success: boolean; ackedCount: number } {
    if (!groupId) return { success: false, ackedCount: 0 };
    const db = this.requireDb();
    const ackTime = nowIso || new Date().toISOString();
    const ackTimestamp = Date.parse(ackTime);
    if (!Number.isFinite(ackTimestamp)) return { success: false, ackedCount: 0 };
    const ackExpiryIso = new Date(ackTimestamp - this.config.ackRetentionMs).toISOString();
    const unackExpiryIso = new Date(ackTimestamp - this.config.unackRetentionMs).toISOString();
    let transactionStarted = false;
    try {
      db.exec("begin immediate");
      transactionStarted = true;
      let ackedCount = 0;
      for (const messageId of new Set(messageIds)) {
        const row = db
          .prepare(
            `select group_id, to_agent, sent_at, acked_at
               from harness_group_messages where id = ?`,
          )
          .get(messageId) as
          | { group_id: string; to_agent: string; sent_at: string; acked_at: string | null }
          | undefined;
        if (
          !row ||
          row.group_id !== groupId ||
          (row.to_agent !== "*" && row.to_agent !== agentId)
        ) {
          db.exec("rollback");
          transactionStarted = false;
          return { success: false, ackedCount: 0 };
        }
        const expired = row.acked_at ? row.acked_at < ackExpiryIso : row.sent_at < unackExpiryIso;
        if (expired) {
          db.exec("rollback");
          transactionStarted = false;
          return { success: false, ackedCount: 0 };
        }

        if (row.to_agent === "*") {
          db.prepare(
            `insert or ignore into harness_group_message_acks (message_id, agent_id, acked_at)
             values (?, ?, ?)`,
          ).run(messageId, agentId, ackTime);
        } else if (!row.acked_at) {
          const result = db
            .prepare(
              `update harness_group_messages set acked_at = ?
                where id = ? and group_id = ? and to_agent = ? and acked_at is null`,
            )
            .run(ackTime, messageId, groupId, agentId);
          if (Number(result.changes) === 0) {
            const current = db
              .prepare(`select acked_at from harness_group_messages where id = ?`)
              .get(messageId) as { acked_at: string | null } | undefined;
            if (!current?.acked_at) {
              db.exec("rollback");
              transactionStarted = false;
              return { success: false, ackedCount: 0 };
            }
          }
        }
        ackedCount++;
      }

      db.exec("commit");
      transactionStarted = false;
      return { success: true, ackedCount };
    } catch (error) {
      if (transactionStarted) {
        try {
          db.exec("rollback");
        } catch {
          // Preserve the ACK failure that caused the rollback.
        }
      }
      throw new Error("Group mailbox acknowledgement persistence failed.", { cause: error });
    }
  }

  /**
   * Returns count of pending unacknowledged messages for agentId.
   */
  public getPendingCount(agentId: string, groupId?: string): number {
    if (!groupId) return 0;
    const db = this.requireDb();
    this.cleanupExpiredAndCapacity(db, Date.now(), groupId);
    const row = db
      .prepare(
        `select count(*) as count
           from harness_group_messages m
          where (m.to_agent = ? and m.group_id = ? and m.acked_at is null)
             or (m.to_agent = '*' and m.group_id = ? and m.from_agent <> ? and not exists (
               select 1 from harness_group_message_acks a
                where a.message_id = m.id and a.agent_id = ?
             ))`,
      )
      .get(agentId, groupId, groupId, agentId, agentId) as { count: number };
    return row.count;
  }

  /**
   * Returns all stored messages for an agent (both acked and unacked).
   */
  public getMessages(agentId: string, groupId?: string): GroupMessage[] {
    if (!groupId) return [];
    const db = this.requireDb();
    this.cleanupExpiredAndCapacity(db, Date.now(), groupId);
    const rows = db
      .prepare(
        `select id, group_id, from_agent, to_agent, content, revision, sent_at, acked_at, dedupe_hash
           from harness_group_messages
          where (to_agent = ? and group_id = ?) or
                (to_agent = '*' and group_id = ? and from_agent <> ?)
          order by sent_at asc, rowid asc`,
      )
      .all(agentId, groupId, groupId, agentId) as GroupMailboxRow[];
    return rows.map(messageFromRow);
  }

  /**
   * Purges messages past retention limits:
   * - Acked messages > ackRetentionMs (7 days default)
   * - Unacked messages > unackRetentionMs (30 days default)
   */
  public purgeExpired(nowIso?: string): number {
    const now = nowIso ? Date.parse(nowIso) : Date.now();
    const db = this.requireDb();
    const ackExpiryIso = new Date(now - this.config.ackRetentionMs).toISOString();
    const unackExpiryIso = new Date(now - this.config.unackRetentionMs).toISOString();
    let transactionStarted = false;
    try {
      const statements = this.getPersistenceStatements(db);
      if (!statements.hasExpiredGlobally.get(ackExpiryIso, unackExpiryIso)) return 0;
      db.exec("begin immediate");
      transactionStarted = true;
      const result = statements.purgeExpired.run(ackExpiryIso, unackExpiryIso);
      db.exec("commit");
      transactionStarted = false;
      return Number(result.changes);
    } catch (error) {
      if (transactionStarted) {
        try {
          db.exec("rollback");
        } catch {
          // Preserve the cleanup failure that caused the rollback.
        }
      }
      throw new Error("Group mailbox expiration cleanup failed.", { cause: error });
    }
  }

  private cleanupExpiredAndCapacity(
    db: DatabaseSync,
    now: number = Date.now(),
    groupId: string,
  ): number {
    const ackExpiryIso = new Date(now - this.config.ackRetentionMs).toISOString();
    const unackExpiryIso = new Date(now - this.config.unackRetentionMs).toISOString();
    let transactionStarted = false;
    try {
      const statements = this.getPersistenceStatements(db);
      const capacity = Math.max(1, Math.floor(this.config.maxMessagesPerAgent));
      if (groupId) {
        const hasExpired = statements.hasExpiredForGroup.get(
          groupId,
          ackExpiryIso,
          groupId,
          unackExpiryIso,
        );
        const overCapacity = statements.hasOverCapacityForGroup.get(groupId, capacity);
        if (!hasExpired && !overCapacity) return 0;
      }
      db.exec("begin immediate");
      transactionStarted = true;
      const result = statements.purgeExpiredForGroup.run(groupId, ackExpiryIso, unackExpiryIso);
      statements.normalizeCapacityForGroup.run(groupId, capacity);
      db.exec("commit");
      transactionStarted = false;
      return Number(result.changes);
    } catch (error) {
      if (transactionStarted) {
        try {
          db.exec("rollback");
        } catch {
          // Preserve the cleanup failure that caused the rollback.
        }
      }
      throw new Error("Group mailbox expiration and capacity cleanup failed.", { cause: error });
    }
  }

  // --- Durable SQLite helpers ---

  private persistToDatabase(msg: GroupMessage, db: DatabaseSync): string {
    let transactionStarted = false;
    try {
      const statements = this.getPersistenceStatements(db);
      db.exec("begin immediate");
      transactionStarted = true;
      const existing = statements.findDuplicate.get(msg.dedupeHash) as
        | { id: string; sent_at: string }
        | undefined;
      if (
        existing &&
        Date.parse(msg.sentAt) - Date.parse(existing.sent_at) <= this.config.dedupeWindowMs
      ) {
        db.exec("commit");
        transactionStarted = false;
        return existing.id;
      }
      statements.insertMessage.run(
        msg.id,
        msg.groupId,
        msg.from,
        msg.to,
        msg.content,
        msg.revision,
        msg.sentAt,
        msg.ackedAt ?? null,
        msg.dedupeHash,
      );
      const capacity = Math.max(1, Math.floor(this.config.maxMessagesPerAgent));
      statements.enforceCapacity.run(msg.groupId, msg.to, capacity);
      db.exec("commit");
      transactionStarted = false;
      return msg.id;
    } catch (error) {
      if (transactionStarted) {
        try {
          db.exec("rollback");
        } catch {
          // Preserve the persistence failure that caused the rollback.
        }
      }
      throw new Error("Group mailbox durable persistence failed.", { cause: error });
    }
  }

  private findInDatabaseByDedupeHash(hash: string): GroupMessage | undefined {
    const row = this.requireDb()
      .prepare(
        `select id, group_id, from_agent, to_agent, content, revision, sent_at, acked_at, dedupe_hash
           from harness_group_messages
          where dedupe_hash = ? order by sent_at desc, rowid desc limit 1`,
      )
      .get(hash) as GroupMailboxRow | undefined;
    return row ? messageFromRow(row) : undefined;
  }
}
