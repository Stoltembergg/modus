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

export function computeMessageDedupeHash(
  from: string,
  to: string,
  content: string,
  groupId: string = "",
): string {
  return createHash("sha256")
    .update(`${groupId}:${from}:${to}:${content.trim()}`)
    .digest("hex");
}

export class GroupMailbox {
  private static instance: GroupMailbox | null = null;
  private config: GroupMailboxConfig;

  // In-memory store: id -> GroupMessage
  private messages = new Map<string, GroupMessage>();
  // Index: toAgent -> messageIds (ordered by arrival)
  private agentIndex = new Map<string, string[]>();
  // Deduplication index: dedupeHash -> GroupMessage
  private dedupeIndex = new Map<string, GroupMessage>();
  // Broadcast acks: messageId -> Set of agentIds that acked
  private broadcastAcks = new Map<string, Set<string>>();
  // Whether SQLite was already rehydrated into the in-memory indexes.
  private hydrated = false;

  constructor(
    config: Partial<GroupMailboxConfig> = {},
    private readonly dbProvider: () => DatabaseSync = getDatabase,
  ) {
    this.config = { ...DEFAULT_MAILBOX_CONFIG, ...config };
  }

  private getDb(): DatabaseSync | undefined {
    try {
      return this.dbProvider();
    } catch {
      // Fail-open: no database (unit tests, unmigrated store) -> memory only.
      return undefined;
    }
  }

  public static getInstance(config?: Partial<GroupMailboxConfig>): GroupMailbox {
    if (!GroupMailbox.instance) {
      GroupMailbox.instance = new GroupMailbox(config);
    }
    return GroupMailbox.instance;
  }

  public static resetInstance(): void {
    if (GroupMailbox.instance) {
      GroupMailbox.instance.clear();
      GroupMailbox.instance = null;
    }
  }

  /**
   * Loads persisted messages into the in-memory indexes exactly once.
   *
   * The mailbox used to be write-only against SQLite: after a restart every
   * inbox silently came back empty even though `send()` had persisted the
   * rows. Hydration runs on first read/write so durability survives a
   * process restart, which is the whole point of the "dual persistence"
   * claim. Fail-open: if the table is missing we keep serving memory state.
   */
  private ensureHydrated(): void {
    if (this.hydrated) return;
    const db = this.getDb();
    if (!db) return;

    try {
      const rows = db
        .prepare(
          `select id, group_id, from_agent, to_agent, content, revision, sent_at, acked_at, dedupe_hash
           from harness_group_messages order by sent_at asc limit 20000`,
        )
        .all() as {
        id: string;
        group_id: string;
        from_agent: string;
        to_agent: string;
        content: string;
        revision: number;
        sent_at: string;
        acked_at: string | null;
        dedupe_hash: string;
      }[];

      for (const row of rows) {
        if (this.messages.has(row.id)) continue;
        const message: GroupMessage = {
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
        this.messages.set(message.id, message);
        // Rows arrive oldest first, so the newest duplicate wins the slot.
        this.dedupeIndex.set(message.dedupeHash, message);
        const list = this.agentIndex.get(message.to);
        if (list) {
          list.push(message.id);
        } else {
          this.agentIndex.set(message.to, [message.id]);
        }
      }
      this.hydrated = true;
    } catch {
      // Table not migrated yet; retry on the next call.
    }
  }

  /**
   * Removes a dedupe slot only when it still belongs to this message.
   * Purging/capping an old duplicate must not evict the entry of a newer
   * live message that happens to share the same hash.
   */
  private releaseDedupeEntry(id: string, dedupeHash: string): void {
    const indexed = this.dedupeIndex.get(dedupeHash);
    if (indexed && indexed.id === id) {
      this.dedupeIndex.delete(dedupeHash);
    }
  }

  /**
   * Checks whether a message with identical (from, to, content) was sent within dedupeWindowMs.
   */
  public isDuplicate(
    message: Pick<GroupMessage, "from" | "to" | "content"> & { groupId?: string },
    nowIso?: string,
  ): boolean {
    this.ensureHydrated();
    const hash = computeMessageDedupeHash(
      message.from,
      message.to,
      message.content,
      message.groupId ?? "",
    );
    const existing = this.dedupeIndex.get(hash);
    if (!existing) {
      // Check database if available
      const dbMatch = this.findInDatabaseByDedupeHash(hash);
      if (!dbMatch) return false;
      const now = nowIso ? Date.parse(nowIso) : Date.now();
      const sentTime = Date.parse(dbMatch.sentAt);
      return now - sentTime <= this.config.dedupeWindowMs;
    }

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
    this.ensureHydrated();
    const sentAt = messageInput.sentAt || nowIso || new Date().toISOString();
    const dedupeHash = computeMessageDedupeHash(
      messageInput.from,
      messageInput.to,
      messageInput.content,
      messageInput.groupId,
    );

    // Idempotent duplicate check
    if (this.isDuplicate({ ...messageInput, groupId: messageInput.groupId }, sentAt)) {
      const existing =
        this.dedupeIndex.get(dedupeHash) ??
        this.findInDatabaseByDedupeHash(dedupeHash);
      if (existing) {
        return existing.id;
      }
    }

    const id = randomUUID();
    const message: GroupMessage = {
      ...messageInput,
      id,
      sentAt,
      dedupeHash,
      ackedAt: messageInput.ackedAt,
    };

    // Store in-memory
    this.messages.set(id, message);
    this.dedupeIndex.set(dedupeHash, message);

    const target = message.to;
    if (!this.agentIndex.has(target)) {
      this.agentIndex.set(target, []);
    }
    this.agentIndex.get(target)!.push(id);

    // Enforce max capacity per agent
    if (target !== "*") {
      this.enforceMaxCapacity(target);
    }

    // Persist to database if available
    this.persistToDatabase(message);

    return id;
  }

  /**
   * Receives unacknowledged messages for the recipient agent (including broadcasts).
   */
  public receive(agentId: string, limit: number = 50): GroupMessage[] {
    this.ensureHydrated();
    const results: GroupMessage[] = [];

    // 1. Direct messages targeted to this agent
    const directIds = this.agentIndex.get(agentId) ?? [];
    for (const msgId of directIds) {
      const msg = this.messages.get(msgId);
      if (msg && !msg.ackedAt) {
        results.push(msg);
      }
    }

    // 2. Broadcast messages targeted to '*'
    const broadcastIds = this.agentIndex.get("*") ?? [];
    for (const msgId of broadcastIds) {
      const msg = this.messages.get(msgId);
      if (msg && msg.from !== agentId) {
        const acks = this.broadcastAcks.get(msgId);
        if (!acks || !acks.has(agentId)) {
          results.push(msg);
        }
      }
    }

    // Sort by sentAt ascending
    results.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));

    return results.slice(0, limit);
  }

  /**
   * Acknowledges receipt of a message by agentId.
   */
  public ack(messageId: string, agentId: string, nowIso?: string): boolean {
    this.ensureHydrated();
    const msg = this.messages.get(messageId);
    const ackTime = nowIso || new Date().toISOString();

    if (!msg) {
      // Row unknown to memory: verify the DB row is addressed to this agent.
      const row = this.findRecipientInDatabase(messageId);
      if (!row || (row.to_agent !== "*" && row.to_agent !== agentId)) {
        return false;
      }
      return this.ackInDatabase(messageId, ackTime);
    }

    if (msg.to === "*") {
      // Broadcast ack
      if (!this.broadcastAcks.has(messageId)) {
        this.broadcastAcks.set(messageId, new Set());
      }
      this.broadcastAcks.get(messageId)!.add(agentId);
      return true;
    }

    // Only the addressed recipient may acknowledge a direct message.
    if (msg.to !== agentId) {
      return false;
    }

    msg.ackedAt = ackTime;
    this.ackInDatabase(messageId, ackTime);
    return true;
  }

  /**
   * Returns count of pending unacknowledged messages for agentId.
   */
  public getPendingCount(agentId: string): number {
    // Not capped by the default receive() page: a busy mailbox must not
    // silently report "50" when 60+ messages are actually waiting.
    return this.receive(agentId, Number.MAX_SAFE_INTEGER).length;
  }

  /**
   * Returns all stored messages for an agent (both acked and unacked).
   */
  public getMessages(agentId: string): GroupMessage[] {
    this.ensureHydrated();
    const directIds = this.agentIndex.get(agentId) ?? [];
    const direct = directIds
      .map((id) => this.messages.get(id))
      .filter((m): m is GroupMessage => m !== undefined);

    const broadcastIds = this.agentIndex.get("*") ?? [];
    const broadcast = broadcastIds
      .map((id) => this.messages.get(id))
      .filter((m): m is GroupMessage => m !== undefined && m.from !== agentId);

    return [...direct, ...broadcast].sort(
      (a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt),
    );
  }

  /**
   * Purges messages past retention limits:
   * - Acked messages > ackRetentionMs (7 days default)
   * - Unacked messages > unackRetentionMs (30 days default)
   */
  public purgeExpired(nowIso?: string): number {
    this.ensureHydrated();
    const now = nowIso ? Date.parse(nowIso) : Date.now();
    let purgedCount = 0;

    for (const [id, msg] of Array.from(this.messages.entries())) {
      const sentTime = Date.parse(msg.sentAt);
      const ackedTime = msg.ackedAt ? Date.parse(msg.ackedAt) : undefined;

      let shouldPurge = false;
      if (ackedTime !== undefined) {
        if (now - ackedTime > this.config.ackRetentionMs) {
          shouldPurge = true;
        }
      } else {
        if (now - sentTime > this.config.unackRetentionMs) {
          shouldPurge = true;
        }
      }

      if (shouldPurge) {
        this.messages.delete(id);
        this.releaseDedupeEntry(id, msg.dedupeHash);
        this.broadcastAcks.delete(id);

        const list = this.agentIndex.get(msg.to);
        if (list) {
          const idx = list.indexOf(id);
          if (idx !== -1) list.splice(idx, 1);
        }
        purgedCount++;
      }
    }

    // Also purge expired in database
    purgedCount += this.purgeDatabaseExpired(now);

    return purgedCount;
  }

  /**
   * Clears in-memory messages, optionally scoped to agentId.
   */
  public clear(agentId?: string): void {
    if (!agentId) {
      this.messages.clear();
      this.agentIndex.clear();
      this.dedupeIndex.clear();
      this.broadcastAcks.clear();
      return;
    }

    const ids = this.agentIndex.get(agentId) ?? [];
    for (const id of ids) {
      const msg = this.messages.get(id);
      if (msg) {
        this.releaseDedupeEntry(id, msg.dedupeHash);
        this.messages.delete(id);
      }
    }
    this.agentIndex.delete(agentId);
  }

  private enforceMaxCapacity(agentId: string): void {
    const ids = this.agentIndex.get(agentId);
    if (!ids || ids.length <= this.config.maxMessagesPerAgent) return;

    const excess = ids.length - this.config.maxMessagesPerAgent;
    const removedIds = ids.splice(0, excess);

    for (const id of removedIds) {
      const msg = this.messages.get(id);
      if (msg) {
        this.releaseDedupeEntry(id, msg.dedupeHash);
        this.messages.delete(id);
      }
    }
  }

  // --- Database Durability Helpers (Fail-Open / Best Effort) ---

  private persistToDatabase(msg: GroupMessage): void {
    try {
      const db = this.getDb();
      if (!db) return;
      db.prepare(
        `insert or replace into harness_group_messages
         (id, group_id, from_agent, to_agent, content, revision, sent_at, acked_at, dedupe_hash)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
    } catch {
      // In-memory fallback handles everything if DB table is not yet migrated or in unit tests
    }
  }

  private findInDatabaseByDedupeHash(hash: string): GroupMessage | undefined {
    try {
      const db = this.getDb();
      if (!db) return undefined;
      const row = db
        .prepare(
          `select id, group_id, from_agent, to_agent, content, revision, sent_at, acked_at, dedupe_hash
           from harness_group_messages where dedupe_hash = ? order by sent_at desc limit 1`,
        )
        .get(hash) as
        | {
            id: string;
            group_id: string;
            from_agent: string;
            to_agent: string;
            content: string;
            revision: number;
            sent_at: string;
            acked_at: string | null;
            dedupe_hash: string;
          }
        | undefined;

      if (!row) return undefined;
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
    } catch {
      return undefined;
    }
  }

  private findRecipientInDatabase(
    messageId: string,
  ): { to_agent: string } | undefined {
    try {
      const db = this.getDb();
      if (!db) return undefined;
      return db
        .prepare(`select to_agent from harness_group_messages where id = ?`)
        .get(messageId) as { to_agent: string } | undefined;
    } catch {
      return undefined;
    }
  }

  private ackInDatabase(messageId: string, ackTime: string): boolean {
    try {
      const db = this.getDb();
      if (!db) return false;
      const result = db
        .prepare(
          `update harness_group_messages set acked_at = ? where id = ? and acked_at is null`,
        )
        .run(ackTime, messageId);
      return Number(result.changes) > 0;
    } catch {
      return false;
    }
  }

  private purgeDatabaseExpired(nowMs: number): number {
    try {
      const db = this.getDb();
      if (!db) return 0;
      const ackExpiryIso = new Date(
        nowMs - this.config.ackRetentionMs,
      ).toISOString();
      const unackExpiryIso = new Date(
        nowMs - this.config.unackRetentionMs,
      ).toISOString();

      const result = db
        .prepare(
          `delete from harness_group_messages
           where (acked_at is not null and acked_at < ?)
              or (acked_at is null and sent_at < ?)`,
        )
        .run(ackExpiryIso, unackExpiryIso);
      return Number(result.changes);
    } catch {
      return 0;
    }
  }
}
