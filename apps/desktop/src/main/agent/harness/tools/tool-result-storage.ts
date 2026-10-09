import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDatabase } from "../../../db/database";

export const TOOL_RESULT_SPILL_LIMITS = {
  maxEntries: 100,
  maxTotalBytes: 20 * 1024 * 1024,
  maxSingleResultBytes: 2 * 1024 * 1024,
  ttlMs: 2 * 60 * 60 * 1000,
  defaultRecoveryLines: 100,
  maxRecoveryLines: 200,
  defaultRecoveryBytes: 16 * 1024,
  maxRecoveryBytes: 32 * 1024,
  minRecoveryBytes: 512,
} as const;

export type ToolSpillReason = "byte_limit_exceeded" | "line_limit_exceeded";

export interface SpilledToolResult {
  id: string;
  sessionId: string;
  runId: string;
  workspaceId: string;
  toolName: string;
  fullContent: string;
  contentHash: string;
  sizeBytes: number;
  lineCount: number;
  spilledAt: string;
  lastAccessedAt: number;
  isError: boolean;
  spillReason: ToolSpillReason;
}

/** Host-derived identity only. Tool arguments must never populate this value. */
export interface SpillAuthorizationContext {
  sessionId: string;
  runId: string;
  workspaceId: string;
}

export interface SpillRetrievalOptions {
  offsetLine?: number | undefined;
  /** Absolute UTF-8 byte offset used to continue a long line. */
  offsetByte?: number | undefined;
  limitLines?: number | undefined;
  /** Maximum complete response size, including the tool's fixed header. */
  maxBytes?: number | undefined;
}

export interface SpillRetrievalResult {
  spill: SpilledToolResult;
  content: string;
  totalLines: number;
  offsetLine: number;
  linesReturned: number;
  hasMore: boolean;
  nextOffsetLine: number;
  nextOffsetByte: number;
  maxBytes: number;
}

export interface ToolResultStorageOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxSingleResultBytes?: number;
  ttlMs?: number;
  database?: DatabaseSync;
}

export type ToolResultStorageErrorCode =
  | "invalid_scope"
  | "invalid_content"
  | "result_too_large"
  | "invalid_quota"
  | "storage_unavailable";

export class ToolResultStorageError extends Error {
  constructor(readonly code: ToolResultStorageErrorCode) {
    super(`Tool result spill failed: ${code}.`);
    this.name = "ToolResultStorageError";
  }
}

type SpillRow = {
  id: string;
  session_id: string;
  run_id: string;
  workspace_id: string;
  tool_name: string;
  full_content: string;
  content_hash: string;
  size_bytes: number;
  line_count: number;
  is_error: number;
  spill_reason: ToolSpillReason;
  created_at: number;
  expires_at: number;
  last_accessed_at: number;
};

type SpillScopeRow = { session_id: string; run_id: string; workspace_id: string };
type SpillStatsRow = { total_entries: number; total_bytes: number; session_count: number };

function isSafeIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256;
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function lineCount(content: string): number {
  let count = 1;
  for (const char of content) {
    if (char === "\n") count += 1;
  }
  return count;
}

function countNewlines(bytes: Buffer, end: number): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 10) count += 1;
  }
  return count;
}

function offsetForLine(bytes: Buffer, requestedLine: number): number {
  if (requestedLine === 0) return 0;
  let line = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 10) {
      line += 1;
      if (line === requestedLine) return index + 1;
    }
  }
  return bytes.length;
}

function endForLineLimit(bytes: Buffer, start: number, limitLines: number): number {
  let lines = 0;
  for (let index = start; index < bytes.length; index += 1) {
    if (bytes[index] === 10) {
      lines += 1;
      if (lines === limitLines) return index + 1;
    }
  }
  return bytes.length;
}

/** Moves a byte offset back to a UTF-8 code point boundary. */
function safeUtf8End(bytes: Buffer, start: number, candidate: number): number {
  let end = Math.min(candidate, bytes.length);
  while (end > start && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return end;
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return (
    offset === bytes.length ||
    offset === 0 ||
    (((bytes[offset] ?? 0) & 0xc0) !== 0x80)
  );
}

function toSpilledToolResult(row: SpillRow): SpilledToolResult {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    toolName: row.tool_name,
    fullContent: row.full_content,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    lineCount: row.line_count,
    spilledAt: new Date(row.created_at).toISOString(),
    lastAccessedAt: row.last_accessed_at,
    isError: row.is_error === 1,
    spillReason: row.spill_reason,
  };
}

export class ToolResultStorage {
  private static instance: ToolResultStorage | null = null;

  private readonly database: DatabaseSync;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly maxSingleResultBytes: number;
  private readonly ttlMs: number;

  constructor(options?: ToolResultStorageOptions) {
    this.database = options?.database ?? getDatabase();
    this.maxEntries = options?.maxEntries ?? TOOL_RESULT_SPILL_LIMITS.maxEntries;
    this.maxTotalBytes = options?.maxTotalBytes ?? TOOL_RESULT_SPILL_LIMITS.maxTotalBytes;
    this.maxSingleResultBytes =
      options?.maxSingleResultBytes ?? TOOL_RESULT_SPILL_LIMITS.maxSingleResultBytes;
    this.ttlMs = options?.ttlMs ?? TOOL_RESULT_SPILL_LIMITS.ttlMs;

    if (
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      this.maxEntries > TOOL_RESULT_SPILL_LIMITS.maxEntries ||
      !Number.isSafeInteger(this.maxTotalBytes) ||
      this.maxTotalBytes < 1 ||
      this.maxTotalBytes > TOOL_RESULT_SPILL_LIMITS.maxTotalBytes ||
      !Number.isSafeInteger(this.maxSingleResultBytes) ||
      this.maxSingleResultBytes < 1 ||
      this.maxSingleResultBytes > TOOL_RESULT_SPILL_LIMITS.maxSingleResultBytes ||
      this.maxSingleResultBytes > this.maxTotalBytes ||
      !Number.isSafeInteger(this.ttlMs) ||
      this.ttlMs < 1 ||
      this.ttlMs > TOOL_RESULT_SPILL_LIMITS.ttlMs
    ) {
      throw new ToolResultStorageError("invalid_quota");
    }

    this.pruneExpired();
  }

  /** Production singleton backed by the application's existing SQLite database. */
  static getInstance(): ToolResultStorage {
    if (!ToolResultStorage.instance) {
      ToolResultStorage.instance = new ToolResultStorage();
    }
    return ToolResultStorage.instance;
  }

  /** Drops only the process cache; durable spill rows remain subject to TTL. */
  static resetInstance(): void {
    ToolResultStorage.instance = null;
  }

  private computeHash(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  private hasCurrentRun(scope: SpillAuthorizationContext): boolean {
    if (
      !isSafeIdentity(scope.sessionId) ||
      !isSafeIdentity(scope.runId) ||
      !isSafeIdentity(scope.workspaceId)
    ) {
      return false;
    }

    const row = this.database
      .prepare(
        `select 1 as valid
         from agent_sessions session
         join agent_runs run on run.session_id = session.id
         where session.id = ? and session.workspace_id = ? and run.id = ?
           and run.status in ('running', 'blocked')
         limit 1`,
      )
      .get(scope.sessionId, scope.workspaceId, scope.runId) as { valid: number } | undefined;
    return row?.valid === 1;
  }

  private deleteExpired(now: number): void {
    this.database.prepare("delete from tool_result_spills where expires_at <= ?").run(now);
  }

  private queryStats(): SpillStatsRow {
    return this.database
      .prepare(
        `select count(*) as total_entries,
                coalesce(sum(size_bytes), 0) as total_bytes,
                count(distinct session_id) as session_count
         from tool_result_spills`,
      )
      .get() as SpillStatsRow;
  }

  /** Purges absolute-TTL expirations. Access does not extend a record's lifetime. */
  pruneExpired(now = Date.now()): void {
    this.deleteExpired(now);
  }

  /** Stores original text atomically before any model-facing preview is created. */
  spillResult(input: {
    sessionId: string;
    runId: string;
    workspaceId: string;
    toolName: string;
    content: string;
    spillReason: ToolSpillReason;
    isError?: boolean;
  }): SpilledToolResult {
    if (
      typeof input.content !== "string" ||
      !isWellFormedUtf16(input.content) ||
      typeof input.toolName !== "string" ||
      input.toolName.length === 0 ||
      input.toolName.length > 128 ||
      (input.spillReason !== "byte_limit_exceeded" &&
        input.spillReason !== "line_limit_exceeded")
    ) {
      throw new ToolResultStorageError("invalid_content");
    }
    const sizeBytes = Buffer.byteLength(input.content, "utf8");
    if (sizeBytes > this.maxSingleResultBytes || sizeBytes > this.maxTotalBytes) {
      throw new ToolResultStorageError("result_too_large");
    }

    const now = Date.now();
    const id = `spill-${randomUUID()}`;
    const contentHash = this.computeHash(input.content);
    const lines = lineCount(input.content);
    const expiresAt = now + this.ttlMs;

    this.database.exec("begin immediate");
    try {
      if (!this.hasCurrentRun(input)) {
        throw new ToolResultStorageError("invalid_scope");
      }
      this.deleteExpired(now);

      let stats = this.queryStats();
      while (
        stats.total_entries + 1 > this.maxEntries ||
        stats.total_bytes + sizeBytes > this.maxTotalBytes
      ) {
        const oldest = this.database
          .prepare(
            `select id from tool_result_spills
             order by last_accessed_at asc, created_at asc, id asc limit 1`,
          )
          .get() as { id: string } | undefined;
        if (!oldest) throw new ToolResultStorageError("storage_unavailable");
        this.database.prepare("delete from tool_result_spills where id = ?").run(oldest.id);
        stats = this.queryStats();
      }

      this.database
        .prepare(
          `insert into tool_result_spills (
            id, session_id, run_id, workspace_id, tool_name, full_content,
            content_hash, size_bytes, line_count, is_error, spill_reason,
            created_at, expires_at, last_accessed_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          input.runId,
          input.workspaceId,
          input.toolName,
          input.content,
          contentHash,
          sizeBytes,
          lines,
          input.isError ? 1 : 0,
          input.spillReason,
          now,
          expiresAt,
          now,
        );
      this.database.exec("commit");
    } catch (error) {
      this.database.exec("rollback");
      if (error instanceof ToolResultStorageError) throw error;
      throw new ToolResultStorageError("storage_unavailable");
    }

    return {
      id,
      sessionId: input.sessionId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      fullContent: input.content,
      contentHash,
      sizeBytes,
      lineCount: lines,
      spilledAt: new Date(now).toISOString(),
      lastAccessedAt: now,
      isError: Boolean(input.isError),
      spillReason: input.spillReason,
    };
  }

  /**
   * Retrieves only for the host-authenticated session/workspace and an active
   * current run. Origin runs are accepted only when SQLite proves they belong
   * to that same session; this preserves prior-turn recovery after restart.
   */
  retrieveResult(
    spillId: string,
    scope: SpillAuthorizationContext,
    options?: SpillRetrievalOptions,
  ): SpillRetrievalResult | undefined {
    const offsetLine = options?.offsetLine ?? 0;
    const limitLines = options?.limitLines ?? TOOL_RESULT_SPILL_LIMITS.defaultRecoveryLines;
    const maxBytes = options?.maxBytes ?? TOOL_RESULT_SPILL_LIMITS.defaultRecoveryBytes;
    const offsetByte = options?.offsetByte;
    if (
      !Number.isSafeInteger(offsetLine) ||
      offsetLine < 0 ||
      (offsetByte !== undefined &&
        (!Number.isSafeInteger(offsetByte) || offsetByte < 0 || options?.offsetLine !== undefined)) ||
      !Number.isSafeInteger(limitLines) ||
      limitLines < 1 ||
      limitLines > TOOL_RESULT_SPILL_LIMITS.maxRecoveryLines ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < TOOL_RESULT_SPILL_LIMITS.minRecoveryBytes ||
      maxBytes > TOOL_RESULT_SPILL_LIMITS.maxRecoveryBytes ||
      typeof spillId !== "string" ||
      spillId.length > 64
    ) {
      throw new ToolResultStorageError("invalid_content");
    }

    const now = Date.now();
    const row = this.database
      .prepare(
        `select spill.*
         from tool_result_spills spill
         join agent_sessions owner
           on owner.id = spill.session_id and owner.workspace_id = spill.workspace_id
         join agent_runs source_run
           on source_run.id = spill.run_id and source_run.session_id = spill.session_id
         join agent_runs active_run
           on active_run.id = ? and active_run.session_id = ?
             and active_run.status in ('running', 'blocked')
         where spill.id = ? and spill.session_id = ? and spill.workspace_id = ?
           and spill.expires_at > ?
         limit 1`,
      )
      .get(scope.runId, scope.sessionId, spillId, scope.sessionId, scope.workspaceId, now) as
      | SpillRow
      | undefined;
    if (!row) {
      this.database.prepare("delete from tool_result_spills where id = ? and expires_at <= ?").run(
        spillId,
        now,
      );
      return undefined;
    }

    const fullContent = row.full_content;
    const contentBytes = Buffer.from(fullContent, "utf8");
    if (
      contentBytes.byteLength !== row.size_bytes ||
      this.computeHash(fullContent) !== row.content_hash ||
      lineCount(fullContent) !== row.line_count
    ) {
      return undefined;
    }

    const start =
      offsetByte === undefined ? offsetForLine(contentBytes, offsetLine) : offsetByte;
    if (start > contentBytes.length || !isUtf8Boundary(contentBytes, start)) {
      throw new ToolResultStorageError("invalid_content");
    }
    const startLine = countNewlines(contentBytes, start);
    const lineEnd = endForLineLimit(contentBytes, start, limitLines);
    const end = safeUtf8End(contentBytes, start, Math.min(lineEnd, start + maxBytes));
    const content = contentBytes.subarray(start, end).toString("utf8");
    const newlinesReturned = countNewlines(Buffer.from(content, "utf8"), Buffer.byteLength(content, "utf8"));
    const linesReturned =
      content.length === 0 ? 0 : newlinesReturned + (content.endsWith("\n") ? 0 : 1);
    const hasMore = end < contentBytes.length;
    this.database
      .prepare("update tool_result_spills set last_accessed_at = ? where id = ? and expires_at > ?")
      .run(now, spillId, now);

    return {
      spill: toSpilledToolResult({ ...row, last_accessed_at: now }),
      content,
      totalLines: row.line_count,
      offsetLine: startLine,
      linesReturned,
      hasMore,
      nextOffsetLine: startLine + newlinesReturned,
      nextOffsetByte: end,
      maxBytes,
    };
  }

  /** Lists metadata/content only for a host-authorized session and active run. */
  listSpills(scope: SpillAuthorizationContext): SpilledToolResult[] {
    if (!this.hasCurrentRun(scope)) return [];
    const rows = this.database
      .prepare(
        `select spill.*
         from tool_result_spills spill
         join agent_sessions owner
           on owner.id = spill.session_id and owner.workspace_id = spill.workspace_id
         join agent_runs source_run
           on source_run.id = spill.run_id and source_run.session_id = spill.session_id
         where spill.session_id = ? and spill.workspace_id = ? and spill.expires_at > ?
         order by spill.created_at asc`,
      )
      .all(scope.sessionId, scope.workspaceId, Date.now()) as SpillRow[];
    return rows
      .filter(
        (row) =>
          Buffer.byteLength(row.full_content, "utf8") === row.size_bytes &&
          this.computeHash(row.full_content) === row.content_hash &&
          lineCount(row.full_content) === row.line_count,
      )
      .map(toSpilledToolResult);
  }

  getSpillCount(): number {
    this.deleteExpired(Date.now());
    return this.queryStats().total_entries;
  }

  /** Explicit cleanup helpers; runtime release does not call these. */
  clearRun(sessionId: string, runId: string): void {
    this.database
      .prepare("delete from tool_result_spills where session_id = ? and run_id = ?")
      .run(sessionId, runId);
  }

  clearSession(sessionId: string): void {
    this.database.prepare("delete from tool_result_spills where session_id = ?").run(sessionId);
  }

  clearAll(): void {
    this.database.exec("delete from tool_result_spills");
  }

  getStats(): { totalEntries: number; totalBytes: number; sessionCount: number } {
    this.deleteExpired(Date.now());
    const stats = this.queryStats();
    return {
      totalEntries: stats.total_entries,
      totalBytes: stats.total_bytes,
      sessionCount: stats.session_count,
    };
  }
}
