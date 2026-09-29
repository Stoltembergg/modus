import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../../db/database";

const { userDataPath } = vi.hoisted(() => ({ userDataPath: { current: "" } }));

vi.mock("electron", () => ({ app: { getPath: () => userDataPath.current } }));

let root: string;
let db: DatabaseSync;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "modus-adaptive-slice2-"));
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

describe("adaptive slice 2 persistence", () => {
  it("migrates adaptive tables on a fresh database", () => {
    const isolated = new DatabaseSync(":memory:");
    migrateDatabase(isolated);
    const tables = (
      isolated
        .prepare(
          `select name from sqlite_master where type='table' and name in
           ('project_model_edges','project_model_snapshots','harness_failure_blacklist','harness_promotions')`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables.sort()).toEqual([
      "harness_failure_blacklist",
      "harness_promotions",
      "project_model_edges",
      "project_model_snapshots",
    ]);
  });

  it("upserts soft blacklist entries and clears/expires them", async () => {
    db.prepare(
      `insert or ignore into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values ('ws1', '/tmp/ws1', 'WS', 1, ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());

    const {
      upsertFailureBlacklistEntry,
      listActiveFailureBlacklist,
      clearFailureBlacklist,
      listAvoidedStrategyCodesFromBlacklist,
      expireStaleFailureBlacklist,
    } = await import("./failure-blacklist");

    const entry = upsertFailureBlacklistEntry({
      workspaceId: "ws1",
      strategyCode: "same_edit_retry",
      revision: "rev1",
      sourceRunId: "run1",
      now: "2026-01-01T00:00:00.000Z",
      ttlMs: 60_000,
    });
    expect(entry?.hitCount).toBe(1);
    expect(listAvoidedStrategyCodesFromBlacklist("ws1", "2026-01-01T00:00:30.000Z")).toEqual([
      "same_edit_retry",
    ]);
    upsertFailureBlacklistEntry({
      workspaceId: "ws1",
      strategyCode: "same_edit_retry",
      revision: "rev1",
      now: "2026-01-01T00:00:10.000Z",
      ttlMs: 60_000,
    });
    expect(listActiveFailureBlacklist("ws1", "2026-01-01T00:00:30.000Z")[0]?.hitCount).toBe(2);

    expect(expireStaleFailureBlacklist("ws1", "2026-01-01T00:02:00.000Z")).toBe(1);
    expect(listActiveFailureBlacklist("ws1", "2026-01-01T00:02:00.000Z")).toEqual([]);

    upsertFailureBlacklistEntry({
      workspaceId: "ws1",
      strategyCode: "blind_retry",
      now: "2026-01-02T00:00:00.000Z",
      ttlMs: 86_400_000,
    });
    expect(clearFailureBlacklist("ws1", { strategyCode: "blind_retry" })).toBe(1);
    expect(listActiveFailureBlacklist("ws1", "2026-01-02T00:00:01.000Z")).toEqual([]);
  });

  it("requires user confirmation for promotion and never writes skills", async () => {
    db.prepare(
      `insert or ignore into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values ('ws2', '/tmp/ws2', 'WS2', 1, ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());

    const { evaluatePromotionEligibility, promoteHarnessInsight, listHarnessPromotions } =
      await import("./harness-learning-promotion");

    const insight = {
      id: "insight-1",
      kind: "repeated_failures" as const,
      claim: "Same strategy fails repeatedly",
      recommendation: "Prefer reformulation after two failures",
      hypothesis: true as const,
      period: { since: "2026-01-01", until: "2026-01-08" },
      sampleCount: 5,
      confidence: "high" as const,
      limitations: ["local only"],
      sourceRefs: [{ runId: "r1" }, { runId: "r2" }, { runId: "r3" }],
    };

    expect(evaluatePromotionEligibility(insight).eligible).toBe(true);
    const denied = promoteHarnessInsight({
      workspaceId: "ws2",
      insight,
      confirmedByUser: false,
    });
    expect(denied.ok).toBe(false);

    const promoted = promoteHarnessInsight({
      workspaceId: "ws2",
      insight,
      confirmedByUser: true,
      now: "2026-01-09T00:00:00.000Z",
    });
    expect(promoted.ok).toBe(true);
    if (promoted.ok) expect(promoted.record.status).toBe("promoted");
    expect(listHarnessPromotions("ws2")[0]?.status).toBe("promoted");

    const setting = db
      .prepare(`select value from app_settings where key = ?`)
      .get("harness.promotion.repeated_failures:ws2") as { value: string } | undefined;
    expect(setting?.value).toContain("insight-1");
    const parsed = JSON.parse(setting?.value ?? "{}") as {
      policy?: { effects?: Array<{ op: string; codes?: string[] }> };
    };
    expect(parsed.policy?.effects?.[0]?.op).toBe("add_avoid_strategies");
    expect(parsed.policy?.effects?.[0]?.codes).toEqual(["same_edit_retry", "blind_retry"]);

    const { loadPromotedPolicies } = await import("./promoted-policy-store");
    const loaded = loadPromotedPolicies("ws2");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.kind).toBe("repeated_failures");
  });

  it("persists project model edges and uses them for impact", async () => {
    db.prepare(
      `insert or ignore into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values ('ws3', '/tmp/ws3', 'WS3', 1, ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());

    const {
      upsertProjectModelDiscoveries,
      upsertProjectModelChangedPaths,
      estimateProjectImpactWithStore,
      listProjectModelEdges,
    } = await import("./project-model-store");

    expect(
      upsertProjectModelDiscoveries({
        workspaceId: "ws3",
        revision: "abc",
        hits: [{ path: "apps/desktop/src/main/agent/runtime.ts", symbol: "prompt" }],
      }),
    ).toBe(1);
    upsertProjectModelChangedPaths({
      workspaceId: "ws3",
      revision: "abc",
      paths: ["apps/desktop/src/main/agent/runtime.ts"],
    });
    expect(listProjectModelEdges("ws3", "abc").length).toBeGreaterThanOrEqual(1);

    const estimate = estimateProjectImpactWithStore("ws3", {
      revision: "abc",
      changedPaths: [],
    });
    expect(estimate.reasonCodes).toContain("stored_edges_used");
    expect(estimate.blastRadius).not.toBe("unknown");
  });
});
