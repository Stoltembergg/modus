import { createHash, randomUUID } from "node:crypto";
import type { HarnessInsight, HarnessInsightConfidence } from "../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";
import { getDatabase } from "../../db/database";
import { MIN_COMPARABLE_EPISODES } from "./harness-insights-service";

export type HarnessPromotionStatus = "proposed" | "validated" | "promoted" | "rejected" | "expired";

export type HarnessPromotionRecord = {
  id: string;
  workspaceId: string;
  insightId: string;
  kind: string;
  claim: string;
  recommendation: string;
  confidence: HarnessInsightConfidence;
  sampleCount: number;
  status: HarnessPromotionStatus;
  evidenceRunIds: string[];
  createdAt: string;
  updatedAt: string;
  promotedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
};

export type PromoteHarnessInsightInput = {
  workspaceId: string;
  insight: HarnessInsight;
  /** Explicit user confirmation from Settings. */
  confirmedByUser: boolean;
  now?: string;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CLAIM = 500;
const MAX_RECOMMENDATION = 800;

/**
 * Guarded promotion gate. Never silently mutates skills/prompts/routing.
 * Requires: high confidence OR sampleCount >= MIN_COMPARABLE_EPISODES,
 * plus either explicit user confirm OR multi-run evidence (>= MIN).
 */
export function evaluatePromotionEligibility(insight: HarnessInsight): {
  eligible: boolean;
  reasonCodes: string[];
} {
  const reasonCodes: string[] = [];
  if (insight.sampleCount < MIN_COMPARABLE_EPISODES) {
    reasonCodes.push("insufficient_comparable_episodes");
  }
  if (insight.confidence === "low") reasonCodes.push("low_confidence");
  if (insight.limitations.length > 6) reasonCodes.push("too_many_limitations");
  const evidenceRuns = new Set(insight.sourceRefs.map((ref) => ref.runId));
  if (evidenceRuns.size < MIN_COMPARABLE_EPISODES) {
    reasonCodes.push("insufficient_distinct_runs");
  }
  const strongEvidence =
    insight.confidence === "high" && evidenceRuns.size >= MIN_COMPARABLE_EPISODES;
  const eligible =
    insight.sampleCount >= MIN_COMPARABLE_EPISODES &&
    insight.confidence !== "low" &&
    (strongEvidence || evidenceRuns.size >= MIN_COMPARABLE_EPISODES);
  if (eligible) reasonCodes.push("evidence_gate_passed");
  return { eligible, reasonCodes };
}

export function proposeHarnessPromotion(
  workspaceId: string,
  insight: HarnessInsight,
  now = new Date().toISOString(),
): HarnessPromotionRecord | undefined {
  if (!SAFE_ID.test(workspaceId) || workspaceId === CHATS_WORKSPACE_ID) return undefined;
  if (!SAFE_ID.test(insight.id)) return undefined;
  const eligibility = evaluatePromotionEligibility(insight);
  const id = createHash("sha256")
    .update(`${workspaceId}:${insight.id}:${insight.kind}`)
    .digest("hex")
    .slice(0, 40);
  const record: HarnessPromotionRecord = {
    id,
    workspaceId,
    insightId: insight.id,
    kind: insight.kind,
    claim: insight.claim.slice(0, MAX_CLAIM),
    recommendation: insight.recommendation.slice(0, MAX_RECOMMENDATION),
    confidence: insight.confidence,
    sampleCount: insight.sampleCount,
    status: eligibility.eligible ? "validated" : "proposed",
    evidenceRunIds: [
      ...new Set(insight.sourceRefs.map((ref) => ref.runId).filter((id) => SAFE_ID.test(id))),
    ].slice(0, 24),
    createdAt: now,
    updatedAt: now,
  };
  const db = getDatabase();
  db.prepare(
    `insert into harness_promotions
      (id, workspace_id, insight_id, kind, claim, recommendation, confidence, sample_count,
       status, evidence_run_ids_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
       claim = excluded.claim,
       recommendation = excluded.recommendation,
       confidence = excluded.confidence,
       sample_count = excluded.sample_count,
       status = case
         when harness_promotions.status in ('promoted', 'rejected') then harness_promotions.status
         else excluded.status
       end,
       evidence_run_ids_json = excluded.evidence_run_ids_json,
       updated_at = excluded.updated_at`,
  ).run(
    record.id,
    record.workspaceId,
    record.insightId,
    record.kind,
    record.claim,
    record.recommendation,
    record.confidence,
    record.sampleCount,
    record.status,
    JSON.stringify(record.evidenceRunIds),
    record.createdAt,
    record.updatedAt,
  );
  return record;
}

export function promoteHarnessInsight(
  input: PromoteHarnessInsightInput,
): { ok: true; record: HarnessPromotionRecord } | { ok: false; reasonCodes: string[] } {
  const eligibility = evaluatePromotionEligibility(input.insight);
  if (!eligibility.eligible) {
    return { ok: false, reasonCodes: eligibility.reasonCodes };
  }
  if (!input.confirmedByUser) {
    return { ok: false, reasonCodes: ["user_confirmation_required", ...eligibility.reasonCodes] };
  }
  const now = input.now ?? new Date().toISOString();
  const proposed = proposeHarnessPromotion(input.workspaceId, input.insight, now);
  if (!proposed) return { ok: false, reasonCodes: ["invalid_workspace_or_insight"] };

  // Persist a versioned preference flag only — never rewrite skills/prompts.
  const preferenceKey = `harness.promotion.${proposed.kind}`;
  getDatabase()
    .prepare(
      `insert into app_settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(
      `${preferenceKey}:${input.workspaceId}`,
      JSON.stringify({
        promotionId: proposed.id,
        insightId: proposed.insightId,
        recommendation: proposed.recommendation,
        promotedAt: now,
        version: 1,
      }),
      now,
    );

  getDatabase()
    .prepare(
      `update harness_promotions
       set status = 'promoted', promoted_at = ?, updated_at = ?
       where id = ?`,
    )
    .run(now, now, proposed.id);

  return {
    ok: true,
    record: { ...proposed, status: "promoted", promotedAt: now, updatedAt: now },
  };
}

export function rejectHarnessPromotion(
  workspaceId: string,
  promotionId: string,
  reason = "user_rejected",
  now = new Date().toISOString(),
): boolean {
  if (!SAFE_ID.test(workspaceId) || !SAFE_ID.test(promotionId)) return false;
  const result = getDatabase()
    .prepare(
      `update harness_promotions
       set status = 'rejected', rejected_at = ?, rejection_reason = ?, updated_at = ?
       where id = ? and workspace_id = ? and status != 'promoted'`,
    )
    .run(now, reason.slice(0, 200), now, promotionId, workspaceId);
  return Number(result.changes ?? 0) > 0;
}

export function listHarnessPromotions(workspaceId: string, limit = 50): HarnessPromotionRecord[] {
  if (!SAFE_ID.test(workspaceId) || workspaceId === CHATS_WORKSPACE_ID) return [];
  const rows = getDatabase()
    .prepare(
      `select id, workspace_id, insight_id, kind, claim, recommendation, confidence, sample_count,
              status, evidence_run_ids_json, created_at, updated_at, promoted_at, rejected_at,
              rejection_reason
       from harness_promotions
       where workspace_id = ?
       order by updated_at desc
       limit ?`,
    )
    .all(workspaceId, Math.min(Math.max(limit, 1), 100)) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    let evidenceRunIds: string[] = [];
    try {
      evidenceRunIds = JSON.parse(String(row.evidence_run_ids_json ?? "[]")) as string[];
    } catch {
      evidenceRunIds = [];
    }
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      insightId: String(row.insight_id),
      kind: String(row.kind),
      claim: String(row.claim),
      recommendation: String(row.recommendation),
      confidence: row.confidence as HarnessInsightConfidence,
      sampleCount: Number(row.sample_count ?? 0),
      status: row.status as HarnessPromotionStatus,
      evidenceRunIds,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(typeof row.promoted_at === "string" ? { promotedAt: row.promoted_at } : {}),
      ...(typeof row.rejected_at === "string" ? { rejectedAt: row.rejected_at } : {}),
      ...(typeof row.rejection_reason === "string"
        ? { rejectionReason: row.rejection_reason }
        : {}),
    };
  });
}

/** Test helper: create a synthetic promotion id. */
export function newPromotionId(): string {
  return randomUUID();
}
