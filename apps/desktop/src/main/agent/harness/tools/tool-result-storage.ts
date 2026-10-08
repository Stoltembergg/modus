import { createHash, randomUUID } from "node:crypto";

export interface SpilledToolResult {
  id: string;
  sessionId: string;
  runId: string;
  toolName: string;
  fullContent: string;
  contentHash: string;
  sizeBytes: number;
  lineCount: number;
  spilledAt: string;
  lastAccessedAt: number;
  metadata?: Record<string, any> | undefined;
}

export interface SpillRetrievalOptions {
  offsetLine?: number | undefined;
  limitLines?: number | undefined;
}

export interface SpillRetrievalResult {
  spill: SpilledToolResult;
  content: string;
  totalLines: number;
  offsetLine: number;
  linesReturned: number;
  hasMore: boolean;
}

export interface ToolResultStorageOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
}

export class ToolResultStorage {
  private static instance: ToolResultStorage | null = null;
  private inMemoryStorage: Map<string, SpilledToolResult> = new Map();
  private sessionIndex: Map<string, Set<string>> = new Map();
  private totalBytes: number = 0;

  private maxEntries: number = 100;
  private maxTotalBytes: number = 20 * 1024 * 1024; // 20 MB ceiling
  private ttlMs: number = 2 * 60 * 60 * 1000; // 2 hours TTL

  constructor(options?: ToolResultStorageOptions) {
    if (options?.maxEntries !== undefined) this.maxEntries = options.maxEntries;
    if (options?.maxTotalBytes !== undefined) this.maxTotalBytes = options.maxTotalBytes;
    if (options?.ttlMs !== undefined) this.ttlMs = options.ttlMs;
  }

  /**
   * Singleton accessor for global tool storage.
   */
  static getInstance(): ToolResultStorage {
    if (!ToolResultStorage.instance) {
      ToolResultStorage.instance = new ToolResultStorage();
    }
    return ToolResultStorage.instance;
  }

  /**
   * Resets the singleton instance (useful for clean testing).
   */
  static resetInstance(): void {
    if (ToolResultStorage.instance) {
      ToolResultStorage.instance.clearAll();
      ToolResultStorage.instance = null;
    }
  }

  /**
   * Computes SHA-256 hash of tool output.
   */
  private computeHash(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  /**
   * Evicts expired or least recently used entries to remain strictly within bounds.
   */
  private evictIfNecessary(incomingBytes: number = 0): void {
    const now = Date.now();

    // 1. Remove expired entries by TTL
    for (const [id, record] of Array.from(this.inMemoryStorage.entries())) {
      if (now - record.lastAccessedAt > this.ttlMs) {
        this.deleteRecord(id);
      }
    }

    // 2. If exceeding maxEntries or maxTotalBytes, evict LRU
    if (
      this.inMemoryStorage.size < this.maxEntries &&
      this.totalBytes + incomingBytes <= this.maxTotalBytes
    ) {
      return;
    }

    // Sort by lastAccessedAt ascending (oldest first)
    const sorted = Array.from(this.inMemoryStorage.values()).sort(
      (a, b) => a.lastAccessedAt - b.lastAccessedAt
    );

    for (const record of sorted) {
      if (
        this.inMemoryStorage.size < this.maxEntries &&
        this.totalBytes + incomingBytes <= this.maxTotalBytes
      ) {
        break;
      }
      this.deleteRecord(record.id);
    }
  }

  private deleteRecord(id: string): void {
    const record = this.inMemoryStorage.get(id);
    if (!record) return;

    this.inMemoryStorage.delete(id);
    this.totalBytes = Math.max(0, this.totalBytes - record.sizeBytes);

    const sessionSpills = this.sessionIndex.get(record.sessionId);
    if (sessionSpills) {
      sessionSpills.delete(id);
      if (sessionSpills.size === 0) {
        this.sessionIndex.delete(record.sessionId);
      }
    }
  }

  /**
   * Saves a spilled tool result with bounded memory and LRU eviction.
   */
  spillResult(input: {
    sessionId: string;
    runId: string;
    toolName: string;
    content: string;
    metadata?: Record<string, any> | undefined;
  }): SpilledToolResult {
    const sizeBytes = Buffer.byteLength(input.content, "utf8");
    this.evictIfNecessary(sizeBytes);

    const id = `spill-${randomUUID().slice(0, 12)}`;
    const lineCount = input.content.split("\n").length;
    const contentHash = this.computeHash(input.content);
    const now = Date.now();
    const spilledAt = new Date(now).toISOString();

    const record: SpilledToolResult = {
      id,
      sessionId: input.sessionId,
      runId: input.runId,
      toolName: input.toolName,
      fullContent: input.content,
      contentHash,
      sizeBytes,
      lineCount,
      spilledAt,
      lastAccessedAt: now,
      metadata: input.metadata,
    };

    this.inMemoryStorage.set(id, record);
    this.totalBytes += sizeBytes;

    let sessionSpills = this.sessionIndex.get(input.sessionId);
    if (!sessionSpills) {
      sessionSpills = new Set<string>();
      this.sessionIndex.set(input.sessionId, sessionSpills);
    }
    sessionSpills.add(id);

    return record;
  }

  /**
   * Retrieves a spilled result, optionally slicing by line range, updating LRU access time.
   */
  retrieveResult(
    spillId: string,
    options?: SpillRetrievalOptions
  ): SpillRetrievalResult | undefined {
    const record = this.inMemoryStorage.get(spillId);
    if (!record) return undefined;

    record.lastAccessedAt = Date.now();

    const lines = record.fullContent.split("\n");
    const totalLines = lines.length;

    const offset = Math.max(0, options?.offsetLine ?? 0);
    const limit = options?.limitLines !== undefined ? Math.max(1, options.limitLines) : totalLines;

    const slicedLines = lines.slice(offset, offset + limit);
    const linesReturned = slicedLines.length;
    const hasMore = offset + linesReturned < totalLines;

    return {
      spill: record,
      content: slicedLines.join("\n"),
      totalLines,
      offsetLine: offset,
      linesReturned,
      hasMore,
    };
  }

  /**
   * Lists all spilled results for a specific session.
   */
  listSpills(sessionId: string): SpilledToolResult[] {
    const ids = this.sessionIndex.get(sessionId);
    if (!ids) return [];
    const results: SpilledToolResult[] = [];
    for (const id of ids) {
      const rec = this.inMemoryStorage.get(id);
      if (rec) results.push(rec);
    }
    return results;
  }

  /**
   * Returns current count of stored spills.
   */
  getSpillCount(): number {
    return this.inMemoryStorage.size;
  }

  /**
   * Deletes all spilled results associated with a run.
   */
  clearRun(sessionId: string, runId: string): void {
    const ids = this.sessionIndex.get(sessionId);
    if (!ids) return;

    for (const id of Array.from(ids)) {
      const rec = this.inMemoryStorage.get(id);
      if (rec && rec.runId === runId) {
        this.deleteRecord(id);
      }
    }
  }

  /**
   * Deletes all spilled results associated with a session.
   */
  clearSession(sessionId: string): void {
    const ids = this.sessionIndex.get(sessionId);
    if (!ids) return;

    for (const id of Array.from(ids)) {
      this.deleteRecord(id);
    }
  }

  /**
   * Clears all storage across all sessions.
   */
  clearAll(): void {
    this.inMemoryStorage.clear();
    this.sessionIndex.clear();
    this.totalBytes = 0;
  }

  /**
   * Returns current statistics for monitoring and debugging.
   */
  getStats(): { totalEntries: number; totalBytes: number; sessionCount: number } {
    return {
      totalEntries: this.inMemoryStorage.size,
      totalBytes: this.totalBytes,
      sessionCount: this.sessionIndex.size,
    };
  }
}
