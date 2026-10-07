import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupTaskReportInput } from "../../shared/group-work-state";

let userData: string;
const git = vi.hoisted(() => ({
  fingerprint: "source-1",
  onRead: undefined as (() => void) | undefined,
}));
vi.mock("electron", () => ({ app: { getPath: () => userData } }));
vi.mock("../git/git-service", () => ({
  getGroupSourceFingerprint: vi.fn(async () => {
    git.onRead?.();
    git.onRead = undefined;
    return git.fingerprint;
  }),
}));
const { getDatabase, migrateDatabase } = await import("../db/database");
const { createAgentGroup, addAgentGroupMember, appendGroupMessage, createGroupTask } = await import(
  "./group-store"
);
const store = await import("./group-task-store");
const { recordAgentEvent } = await import("../agent/agent-event-store");

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-report-store-"));
});
afterAll(async () => {
  await rm(userData, { recursive: true, force: true });
});
beforeEach(() => {
  git.fingerprint = "source-1";
  git.onRead = undefined;
});

function fixture() {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "insert into workspaces (id,root_path,display_name,last_opened_at,created_at) values (?,?,?,?,?)",
  ).run(id, id, id, now, now);
  const [owner, reviewer] = ["owner", "reviewer"].map((role) => {
    const session = `${id}-${role}`;
    db.prepare(
      "insert into agent_sessions (id,workspace_id,title,cwd,status,created_at,updated_at) values (?,?,?,?,'idle',?,?)",
    ).run(session, id, session, userData, now, now);
    return session;
  }) as [string, string];
  const group = createAgentGroup({ name: id, workspaceId: id });
  for (const sessionId of [owner, reviewer]) addAgentGroupMember({ groupId: group.id, sessionId });
  const task = createGroupTask({
    groupId: group.id,
    title: "Parser",
    description: "Handle quotes",
    status: "in_progress",
    ownerSessionId: owner,
    reviewerSessionId: reviewer,
    kind: "code",
    priority: "normal",
    dependencyIds: [],
    criteria: [{ id: "unit", description: "Pass", requiredCheckKinds: ["tests"] }],
    verificationPolicy: { mode: "required", requireReview: false },
  });
  const executionId = appendGroupMessage({
    groupId: group.id,
    authorKind: "user",
    body: "Implement parser",
  }).id;
  const runId = crypto.randomUUID();
  const binding = {
    groupId: group.id,
    taskId: task.id,
    taskVersion: 1,
    criteriaVersion: 1,
    sessionId: owner,
    runId,
    executionId,
    role: "owner" as const,
    sourceFingerprint: "source-1",
    expectedVersion: 1,
    operationId: crypto.randomUUID(),
  };
  store.bindGroupTaskRun(binding);
  const input: GroupTaskReportInput = {
    groupId: group.id,
    taskId: task.id,
    actorSessionId: owner,
    expectedVersion: 1,
    operationId: crypto.randomUUID(),
    summary: "Parser handles quoted values.",
    changedPaths: ["src/parser.ts"],
  };
  return { db, group, task, owner, reviewer, runId, executionId, binding, input };
}

describe("durable handoff reports", () => {
  it("captures owner run identity and immutable reports with idempotent writes", async () => {
    const { task, owner, runId, input, db } = fixture();
    const first = await store.recordGroupTaskReport(input);
    expect(first).toMatchObject({
      taskId: task.id,
      taskVersion: 1,
      criteriaVersion: 1,
      sessionId: owner,
      runId,
      sourceFingerprint: "source-1",
      summary: input.summary,
      changedPaths: input.changedPaths,
      qaEvidenceRefs: [],
    });
    expect(first.taskIntentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.recordGroupTaskReport(input)).toEqual(first);
    await expect(store.recordGroupTaskReport({ ...input, summary: "Different" })).rejects.toThrow(
      /operation/i,
    );
    const second = await store.recordGroupTaskReport({
      ...input,
      operationId: crypto.randomUUID(),
      summary: "Another handoff",
    });
    expect(second.id).not.toBe(first.id);
    expect(store.getLatestGroupTaskReport(task.id)).toEqual(second);
    expect(
      db.prepare("select count(*) as n from group_task_reports where task_id=?").get(task.id),
    ).toMatchObject({ n: 2 });
    first.changedPaths.push("mutated.ts");
    expect(store.getLatestGroupTaskReport(task.id)?.changedPaths).toEqual(input.changedPaths);
  });

  it("reports originating run version after progress-only version advancement", async () => {
    const { group, task, owner, input } = fixture();
    const next = store.reportGroupTaskProgress({
      groupId: group.id,
      taskId: task.id,
      actorSessionId: owner,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
      stage: "verify",
    });
    const report = await store.recordGroupTaskReport({
      ...input,
      expectedVersion: next.stateVersion ?? 0,
    });
    expect(report.taskVersion).toBe(1);
  });

  it("snapshots current evidence identities in main without trusting supplied QA or logs", async () => {
    const { group, task, owner, runId, input } = fixture();
    const evidence = {
      criterionId: "unit",
      checkName: "tests" as const,
      criteriaVersion: 1,
      sessionId: owner,
      runId,
      eventRowId: recordAgentEvent({
        type: "harness.qa",
        sessionId: owner,
        runId,
        result: {
          required: true,
          status: "passed",
          reasonCode: "checks_passed",
          sourceFingerprint: "source-1",
          evidence: [
            {
              id: "qa-1",
              kind: "check",
              status: "passed",
              label: "Pass",
              checkName: "tests",
              runId,
            },
          ],
        },
      }),
      evidenceId: "qa-1",
      sourceFingerprint: "source-1",
    };
    const next = store.recordGroupTaskEvidence({
      groupId: group.id,
      taskId: task.id,
      actorSessionId: owner,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
      evidenceRefs: [evidence],
    });
    const report = await store.recordGroupTaskReport({
      ...input,
      expectedVersion: next.stateVersion ?? 0,
    });
    expect(report.qaEvidenceRefs).toEqual([evidence]);
    await expect(
      store.recordGroupTaskReport({
        ...input,
        expectedVersion: next.stateVersion ?? 0,
        operationId: crypto.randomUUID(),
        qaEvidenceRefs: [],
        sessionId: "spoof",
        runId: "spoof",
      } as GroupTaskReportInput),
    ).rejects.toThrow(/field|identity/i);
    expect(store.getGroupTask(task.id).evidenceRefs).toEqual([evidence]);
  });

  it.each([
    ["title", "Changed"],
    ["description", "Different goal"],
    ["kind", "docs"],
    ["priority", "high"],
    ["dependency_ids_json", '["other"]'],
    ["verification_policy_json", '{"mode":"required","requireReview":true}'],
    ["criteria_json", '[{"id":"unit","description":"Different","requiredCheckKinds":["tests"]}]'],
  ])("rejects a run whose task intent changed: %s", async (column, value) => {
    const { db, task, input } = fixture();
    db.prepare(`update group_tasks set ${column}=?,state_version=state_version+1 where id=?`).run(
      value,
      task.id,
    );
    await expect(store.recordGroupTaskReport({ ...input, expectedVersion: 2 })).rejects.toThrow(
      /intent|changed/i,
    );
  });

  it("canonicalizes dependency and criterion ordering but includes all intent fields", () => {
    const { task } = fixture();
    const a = {
      ...task,
      dependencyIds: ["b", "a"],
      criteria: [
        { id: "b", description: "B", requiredCheckKinds: ["lint", "tests"] as const },
        { id: "a", description: "A", requiredCheckKinds: [] },
      ],
    };
    const b = {
      ...a,
      description: task.description,
      dependencyIds: ["a", "b"],
      criteria: [
        { id: "a", description: "A", requiredCheckKinds: [] },
        { id: "b", description: "B", requiredCheckKinds: ["tests", "lint"] },
      ],
    };
    expect(store.getGroupTaskIntentFingerprint(a as typeof task)).toEqual(
      store.getGroupTaskIntentFingerprint(b as typeof task),
    );
    expect(store.getGroupTaskIntentFingerprint({ ...task, title: "Other" })).not.toEqual(
      store.getGroupTaskIntentFingerprint(task),
    );
  });

  it.each([
    "legacy",
    "criteria",
    "source",
    "reviewer",
    "assignment",
    "execution",
  ])("fails closed for %s binding", async (mode) => {
    const { db, task, owner, reviewer, runId, executionId, input } = fixture();
    if (mode === "legacy")
      db.prepare("update group_task_runs set task_intent_fingerprint=null where run_id=?").run(
        runId,
      );
    if (mode === "criteria")
      db.prepare("update group_tasks set criteria_version=2 where id=?").run(task.id);
    if (mode === "source") git.fingerprint = "changed-source";
    if (mode === "reviewer")
      db.prepare("update group_task_runs set role='reviewer',session_id=? where run_id=?").run(
        reviewer,
        runId,
      );
    if (mode === "assignment") {
      store.updateGroupTask(task.id, { ownerSessionId: reviewer });
      store.updateGroupTask(task.id, { ownerSessionId: owner });
    }
    if (mode === "execution")
      db.prepare("update group_tasks set execution_id=? where id=?").run(
        `${executionId}-other`,
        task.id,
      );
    await expect(
      store.recordGroupTaskReport({
        ...input,
        expectedVersion: store.getGroupTask(task.id).stateVersion ?? 0,
      }),
    ).rejects.toThrow();
  });

  it("requires the current version and refuses unavailable Git source", async () => {
    const { input } = fixture();
    await expect(store.recordGroupTaskReport({ ...input, expectedVersion: 99 })).rejects.toThrow(
      /version/i,
    );
    git.fingerprint = "";
    await expect(store.recordGroupTaskReport(input)).rejects.toThrow(/source/i);
  });

  it("revalidates task version and exact run after Git resolves", async () => {
    const { task, binding, input } = fixture();
    git.onRead = () => store.updateGroupTask(task.id, { status: "blocked" });
    await expect(store.recordGroupTaskReport(input)).rejects.toThrow(/version|changed/i);
    const current = store.getGroupTask(task.id);
    const nextInput = { ...input, expectedVersion: current.stateVersion ?? 0 };
    git.onRead = () =>
      store.bindGroupTaskRun({
        ...binding,
        taskVersion: current.stateVersion ?? 0,
        expectedVersion: current.stateVersion ?? 0,
        runId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
      });
    await expect(store.recordGroupTaskReport(nextInput)).rejects.toThrow(/run|binding/i);
  });

  it.each([
    "/absolute.ts",
    "../escape.ts",
    "src/../escape.ts",
    "C:\\absolute.ts",
    "\\\\server\\share.ts",
    "src\\..\\escape.ts",
    "src\u0000bad.ts",
    ".",
    "src//file.ts",
  ])("rejects unsafe changed path %s", async (path) => {
    const { input } = fixture();
    await expect(store.recordGroupTaskReport({ ...input, changedPaths: [path] })).rejects.toThrow(
      /path/i,
    );
  });

  it("enforces UTF-8 summary/path bounds and unique path count", async () => {
    const { input } = fixture();
    await expect(
      store.recordGroupTaskReport({ ...input, summary: "é".repeat(1001) }),
    ).rejects.toThrow(/summary/i);
    await expect(store.recordGroupTaskReport({ ...input, summary: "  " })).rejects.toThrow(
      /summary/i,
    );
    await expect(
      store.recordGroupTaskReport({ ...input, changedPaths: ["é".repeat(257)] }),
    ).rejects.toThrow(/path/i);
    await expect(
      store.recordGroupTaskReport({
        ...input,
        changedPaths: Array.from({ length: 101 }, (_, i) => `${i}.ts`),
      }),
    ).rejects.toThrow(/path/i);
    const report = await store.recordGroupTaskReport({
      ...input,
      summary: "é".repeat(1000),
      changedPaths: ["file.ts", "file.ts"],
    });
    expect(report.changedPaths).toEqual(["file.ts"]);
  });

  it("rejects malformed persisted reports instead of exposing unbounded text or QA logs", async () => {
    const { db, task, input } = fixture();
    const report = await store.recordGroupTaskReport(input);
    db.prepare("update group_task_reports set report_json=? where id=?").run(
      JSON.stringify({ ...report, summary: "x".repeat(2001) }),
      report.id,
    );
    expect(() => store.getLatestGroupTaskReport(task.id)).toThrow(/shape|invalid/i);
    db.prepare("update group_task_reports set report_json=? where id=?").run(
      JSON.stringify({ ...report, stdout: "raw QA output" }),
      report.id,
    );
    await expect(store.recordGroupTaskReport(input)).rejects.toThrow(/shape|invalid/i);
  });

  it("requires an owner binding and derives the latest exact owner run", async () => {
    const { db, task, owner, reviewer, binding, input } = fixture();
    await expect(
      store.recordGroupTaskReport({ ...input, actorSessionId: reviewer }),
    ).rejects.toThrow(/owner/i);
    const newerRun = crypto.randomUUID();
    store.bindGroupTaskRun({ ...binding, runId: newerRun, operationId: crypto.randomUUID() });
    const report = await store.recordGroupTaskReport(input);
    expect(report).toMatchObject({ runId: newerRun, sessionId: owner });
    db.prepare("delete from group_task_runs where task_id=?").run(task.id);
    await expect(
      store.recordGroupTaskReport({ ...input, operationId: crypto.randomUUID() }),
    ).rejects.toThrow(/binding/i);
  });

  it("deletes reports when their task is deleted", async () => {
    const { db, task, input } = fixture();
    await store.recordGroupTaskReport(input);
    db.prepare("delete from group_tasks where id=?").run(task.id);
    expect(store.getLatestGroupTaskReport(task.id)).toBeUndefined();
  });

  it("migrates legacy run bindings without inventing intent or reports", () => {
    const { db, task, runId } = fixture();
    const legacy = new DatabaseSync(":memory:");
    try {
      migrateDatabase(legacy);
      legacy.exec(
        "drop table group_task_reports; alter table group_task_runs drop column task_intent_fingerprint;",
      );
      const tables = [
        "workspaces",
        "agent_sessions",
        "agent_groups",
        "group_tasks",
        "group_task_runs",
      ];
      for (const table of tables) {
        const rows = db.prepare(`select * from ${table}`).all();
        for (const row of rows) {
          const copy = { ...row };
          delete copy.task_intent_fingerprint;
          const keys = Object.keys(copy);
          legacy
            .prepare(
              `insert into ${table} (${keys.join(",")}) values (${keys.map(() => "?").join(",")})`,
            )
            .run(...Object.values(copy));
        }
      }
      migrateDatabase(legacy);
      migrateDatabase(legacy);
      expect(
        legacy
          .prepare("select task_intent_fingerprint from group_task_runs where run_id=?")
          .get(runId),
      ).toMatchObject({ task_intent_fingerprint: null });
      expect(
        legacy.prepare("select count(*) as n from group_task_reports where task_id=?").get(task.id),
      ).toMatchObject({ n: 0 });
    } finally {
      legacy.close();
    }
  });
});
