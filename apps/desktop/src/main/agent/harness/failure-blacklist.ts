import { createHash } from "node:crypto";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";
import { getDatabase } from "../../db/database";
import { failureAttemptSignature } from "./failure-intelligence";

export const DEFAULT_BLACKLIST_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_BLACKLIST_ENTRIES = 500;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,95}$/;

export type FailureBlacklistEntry = {
  id: string;
  workspaceId: string;
  signature: string;
  strategyCode: string;
  hypothesisCode?: string;
  hitCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt: string;
  status: "active" | "cleared" | "expired";
  sourceRunId?: string;
};

export type UpsertFailureBlacklistInput = {
  workspaceId: string;
  strategyCode: string;
  hypothesisCode?: string;
  revision?: string;
  sourceRunId?: string;
  ttlMs?: number;
  now?: string;
};

function normalizeCode(value: string): string | undefined {
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!trimmed || !SAFE_CODE.test(trimmed)) return undefined;
  return trimmed;
}

/** Cross-session discouraged strategies. Soft block — never permanent without evidence refresh. */
export function upsertFailureBlacklistEntry(
  input: UpsertFailureBlacklistInput,
): FailureBlacklistEntry | undefined {
  if (!SAFE_ID.test(input.workspaceId) || input.workspaceId === CHATS_WORKSPACE_ID) {
    return undefined;
  }
  const strategyCode = normalizeCode(input.strategyCode);
  if (!strategyCode) return undefined;
  const hypothesisCode = input.hypothesisCode ? normalizeCode(input.hypothesisCode) : undefined;
  const signature = failureAttemptSignature({
    strategyCode,
    ...(hypothesisCode ? { hypothesisCode } : {}),
    ...(input.revision && SAFE_ID.test(input.revision) ? { revision: input.revision } : {}),
  });
  const now = input.now ?? new Date().toISOString();
  const ttl = Math.min(Math.max(input.ttlMs ?? DEFAULT_BLACKLIST_TTL_MS, 60_000), 90 * 86400_000);
  const expiresAt = new Date(Date.parse(now) + ttl).toISOString();
  const id = createHash("sha256")
    .update(`${input.workspaceId}:${signature}`)
    .digest("hex")
    .slice(0, 40);
  const db = getDatabase();
  const existing = db
    .prepare(
      `select id, hit_count, first_seen_at, status from harness_failure_blacklist where id = ?`,
    )
    .get(id) as
    | { id: string; hit_count: number; first_seen_at: string; status: string }
    | undefined;
  if (existing) {
    db.prepare(
      `update harness_failure_blacklist
       set hit_count = ?, last_seen_at = ?, expires_at = ?, status = 'active',
           source_run_id = coalesce(?, source_run_id)
       where id = ?`,
    ).run(
      existing.hit_count + 1,
      now,
      expiresAt,
      input.sourceRunId && SAFE_ID.test(input.sourceRunId) ? input.sourceRunId : null,
      id,
    );
    return {
      id,
      workspaceId: input.workspaceId,
      signature,
      strategyCode,
      ...(hypothesisCode ? { hypothesisCode } : {}),
      hitCount: existing.hit_count + 1,
      firstSeenAt: existing.first_seen_at,
      lastSeenAt: now,
      expiresAt,
      status: "active",
      ...(input.sourceRunId && SAFE_ID.test(input.sourceRunId)
        ? { sourceRunId: input.sourceRunId }
        : {}),
    };
  }
  db.prepare(
    `insert into harness_failure_blacklist
      (id, workspace_id, signature, strategy_code, hypothesis_code, hit_count,
       first_seen_at, last_seen_at, expires_at, status, source_run_id)
     values (?, ?, ?, ?, ?, 1, ?, ?, ?, 'active', ?)`,
  ).run(
    id,
    input.workspaceId,
    signature,
    strategyCode,
    hypothesisCode ?? null,
    now,
    now,
    expiresAt,
    input.sourceRunId && SAFE_ID.test(input.sourceRunId) ? input.sourceRunId : null,
  );
  return {
    id,
    workspaceId: input.workspaceId,
    signature,
    strategyCode,
    ...(hypothesisCode ? { hypothesisCode } : {}),
    hitCount: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    expiresAt,
    status: "active",
    ...(input.sourceRunId && SAFE_ID.test(input.sourceRunId)
      ? { sourceRunId: input.sourceRunId }
      : {}),
  };
}

export function expireStaleFailureBlacklist(
  workspaceId: string,
  now = new Date().toISOString(),
): number {
  if (!SAFE_ID.test(workspaceId) || workspaceId === CHATS_WORKSPACE_ID) return 0;
  const result = getDatabase()
    .prepare(
      `update harness_failure_blacklist
       set status = 'expired'
       where workspace_id = ? and status = 'active' and expires_at <= ?`,
    )
    .run(workspaceId, now);
  return Number(result.changes ?? 0);
}

export function listActiveFailureBlacklist(
  workspaceId: string,
  now = new Date().toISOString(),
): FailureBlacklistEntry[] {
  if (!SAFE_ID.test(workspaceId) || workspaceId === CHATS_WORKSPACE_ID) return [];
  expireStaleFailureBlacklist(workspaceId, now);
  const rows = getDatabase()
    .prepare(
      `select id, workspace_id, signature, strategy_code, hypothesis_code, hit_count,
              first_seen_at, last_seen_at, expires_at, status, source_run_id
       from harness_failure_blacklist
       where workspace_id = ? and status = 'active' and expires_at > ?
       order by last_seen_at desc
       limit ?`,
    )
    .all(workspaceId, now, MAX_BLACKLIST_ENTRIES) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    signature: String(row.signature),
    strategyCode: String(row.strategy_code),
    ...(typeof row.hypothesis_code === "string" ? { hypothesisCode: row.hypothesis_code } : {}),
    hitCount: Number(row.hit_count ?? 1),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    expiresAt: String(row.expires_at),
    status: "active" as const,
    ...(typeof row.source_run_id === "string" ? { sourceRunId: row.source_run_id } : {}),
  }));
}

export function listAvoidedStrategyCodesFromBlacklist(
  workspaceId: string,
  now = new Date().toISOString(),
): string[] {
  return [
    ...new Set(listActiveFailureBlacklist(workspaceId, now).map((entry) => entry.strategyCode)),
  ];
}

export function clearFailureBlacklist(
  workspaceId: string,
  options?: { strategyCode?: string; clearAll?: boolean },
): number {
  if (!SAFE_ID.test(workspaceId) || workspaceId === CHATS_WORKSPACE_ID) return 0;
  const db = getDatabase();
  if (options?.clearAll) {
    return Number(
      db
        .prepare(
          `update harness_failure_blacklist set status = 'cleared'
           where workspace_id = ? and status = 'active'`,
        )
        .run(workspaceId).changes ?? 0,
    );
  }
  const strategyCode = options?.strategyCode ? normalizeCode(options.strategyCode) : undefined;
  if (!strategyCode) return 0;
  return Number(
    db
      .prepare(
        `update harness_failure_blacklist set status = 'cleared'
         where workspace_id = ? and strategy_code = ? and status = 'active'`,
      )
      .run(workspaceId, strategyCode).changes ?? 0,
  );
}
