import type { HarnessPolicyDocument } from "../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";
import { getDatabase } from "../../db/database";
import { parsePolicyDocument } from "./policy-dsl";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PREFERENCE_PREFIX = "harness.promotion.";

export type PromotedPreferenceBlob = {
  promotionId: string;
  insightId: string;
  recommendation?: string;
  promotedAt: string;
  version: 1;
  policy?: unknown;
};

function preferenceKey(kind: string, workspaceId: string): string {
  return `${PREFERENCE_PREFIX}${kind}:${workspaceId}`;
}

/**
 * Load active promoted policy documents for a workspace.
 * Reads preference blobs, requires matching harness_promotions status=promoted,
 * and fail-closes on unknown effect ops.
 */
export function loadPromotedPolicies(workspaceId: string): HarnessPolicyDocument[] {
  if (!SAFE_ID.test(workspaceId) || workspaceId === CHATS_WORKSPACE_ID) return [];
  const db = getDatabase();
  const rows = db
    .prepare(
      `select key, value from app_settings
       where key like ?
       order by key asc`,
    )
    .all(`${PREFERENCE_PREFIX}%:${workspaceId}`) as Array<{ key: string; value: string }>;

  const documents: HarnessPolicyDocument[] = [];
  for (const row of rows) {
    let blob: PromotedPreferenceBlob | undefined;
    try {
      blob = JSON.parse(row.value) as PromotedPreferenceBlob;
    } catch {
      continue;
    }
    if (blob?.version !== 1 || typeof blob.promotionId !== "string") continue;

    const promotion = db
      .prepare(
        `select status from harness_promotions
         where id = ? and workspace_id = ?`,
      )
      .get(blob.promotionId, workspaceId) as { status: string } | undefined;
    if (promotion?.status !== "promoted") continue;

    const policy = parsePolicyDocument(blob.policy);
    if (!policy) continue;
    if (policy.promotionId !== blob.promotionId) continue;
    documents.push(policy);
  }
  return documents;
}

/**
 * Clear a promoted preference + mark the promotion rejected so effects stop applying.
 */
export function clearPromotedPolicy(
  workspaceId: string,
  kind: string,
  reason = "policy_cleared",
  now = new Date().toISOString(),
): boolean {
  if (!SAFE_ID.test(workspaceId) || workspaceId === CHATS_WORKSPACE_ID) return false;
  if (!SAFE_ID.test(kind)) return false;
  const db = getDatabase();
  const key = preferenceKey(kind, workspaceId);
  const row = db.prepare(`select value from app_settings where key = ?`).get(key) as
    | { value: string }
    | undefined;
  let promotionId: string | undefined;
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as { promotionId?: string };
      if (typeof parsed.promotionId === "string") promotionId = parsed.promotionId;
    } catch {
      // ignore malformed preference; still delete the key
    }
  }
  const deleted = db.prepare(`delete from app_settings where key = ?`).run(key);
  if (promotionId && SAFE_ID.test(promotionId)) {
    db.prepare(
      `update harness_promotions
       set status = 'rejected', rejected_at = ?, rejection_reason = ?, updated_at = ?
       where id = ? and workspace_id = ? and status = 'promoted'`,
    ).run(now, reason.slice(0, 200), now, promotionId, workspaceId);
  }
  return Number(deleted.changes ?? 0) > 0 || Boolean(promotionId);
}
