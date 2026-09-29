import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";

const { userDataPath } = vi.hoisted(() => ({ userDataPath: { current: "" } }));

vi.mock("electron", () => ({ app: { getPath: () => userDataPath.current } }));

let root: string;
let db: DatabaseSync;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "modus-promoted-policy-"));
  userDataPath.current = join(root, "userData");
  mkdirSync(userDataPath.current, { recursive: true });
  const { getDatabase } = await import("../../db/database");
  db = getDatabase();
});

afterAll(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  rmSync(root, { recursive: true, force: true });
});

function seedWorkspace(id: string): void {
  db.prepare(
    `insert or ignore into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
     values (?, ?, ?, 1, ?, ?)`,
  ).run(id, `/tmp/${id}`, id, new Date().toISOString(), new Date().toISOString());
}

describe("promoted-policy-store", () => {
  it("loads promoted policies and ignores rejected / chats workspace", async () => {
    seedWorkspace("ws-policy");
    const { promoteHarnessInsight, rejectHarnessPromotion } = await import(
      "./harness-learning-promotion"
    );
    const { loadPromotedPolicies, clearPromotedPolicy } = await import("./promoted-policy-store");

    const insight = {
      id: "insight-policy-1",
      kind: "missing_verification" as const,
      claim: "Verification often missing",
      recommendation: "Raise verification floor",
      hypothesis: true as const,
      period: { since: "2026-01-01", until: "2026-01-08" },
      sampleCount: 5,
      confidence: "high" as const,
      limitations: [],
      sourceRefs: [{ runId: "r1" }, { runId: "r2" }, { runId: "r3" }],
    };

    const promoted = promoteHarnessInsight({
      workspaceId: "ws-policy",
      insight,
      confirmedByUser: true,
      now: "2026-01-09T00:00:00.000Z",
    });
    expect(promoted.ok).toBe(true);

    const loaded = loadPromotedPolicies("ws-policy");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.effects[0]).toEqual({
      op: "raise_min_verification",
      level: "standard",
    });
    expect(loadPromotedPolicies(CHATS_WORKSPACE_ID)).toEqual([]);

    if (promoted.ok) {
      expect(rejectHarnessPromotion("ws-policy", promoted.record.id)).toBe(true);
    }
    expect(loadPromotedPolicies("ws-policy")).toEqual([]);

    // Re-promote then clear by kind
    const again = promoteHarnessInsight({
      workspaceId: "ws-policy",
      insight: { ...insight, id: "insight-policy-2" },
      confirmedByUser: true,
      now: "2026-01-10T00:00:00.000Z",
    });
    expect(again.ok).toBe(true);
    expect(loadPromotedPolicies("ws-policy")).toHaveLength(1);
    expect(clearPromotedPolicy("ws-policy", "missing_verification")).toBe(true);
    expect(loadPromotedPolicies("ws-policy")).toEqual([]);
  });

  it("ignores preference blobs with unknown effect ops (fail closed)", async () => {
    seedWorkspace("ws-bad");
    const { loadPromotedPolicies } = await import("./promoted-policy-store");
    const now = "2026-01-11T00:00:00.000Z";
    db.prepare(
      `insert into harness_promotions
        (id, workspace_id, insight_id, kind, claim, recommendation, confidence, sample_count,
         status, evidence_run_ids_json, created_at, updated_at, promoted_at)
       values ('promo-bad', 'ws-bad', 'i-bad', 'repeated_failures', 'c', 'r', 'high', 5,
               'promoted', '[]', ?, ?, ?)`,
    ).run(now, now, now);
    db.prepare(`insert into app_settings (key, value, updated_at) values (?, ?, ?)`).run(
      "harness.promotion.repeated_failures:ws-bad",
      JSON.stringify({
        promotionId: "promo-bad",
        insightId: "i-bad",
        promotedAt: now,
        version: 1,
        policy: {
          version: 1,
          promotionId: "promo-bad",
          insightId: "i-bad",
          kind: "repeated_failures",
          source: "promoted_insight",
          promotedAt: now,
          effects: [{ op: "enable_execute_everywhere" }],
        },
      }),
      now,
    );
    expect(loadPromotedPolicies("ws-bad")).toEqual([]);
  });
});
