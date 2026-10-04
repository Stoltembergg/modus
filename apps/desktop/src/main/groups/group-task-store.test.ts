import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let userData: string;
vi.mock("electron", () => ({ app: { getPath: () => userData } }));
const { getDatabase, migrateDatabase } = await import("../db/database");
const {
  createAgentGroup,
  addAgentGroupMember,
  createGroupTask,
  claimGroupTask,
  assignGroupTask,
  releaseGroupTask,
  requestGroupTaskReview,
  reviewGroupTask,
  completeGroupTaskForAgreement,
  setAgentGroupLead,
  appendGroupMessage,
  removeAgentGroupMember,
  listGroupTasks,
} = await import("./group-store");
const {
  reportGroupTaskProgress,
  recordGroupTaskEvidence,
  bindGroupTaskRun,
  getGroupTaskRunBinding,
  listGroupTaskTransitions,
} = await import("./group-task-store");
const { recordAgentEvent } = await import("../agent/agent-event-store");

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-task-store-"));
});
afterAll(async () => {
  await rm(userData, { recursive: true, force: true });
});

function fixture() {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "insert into workspaces (id, root_path, display_name, last_opened_at, created_at) values (?, ?, ?, ?, ?)",
  ).run(id, id, id, now, now);
  const members = ["owner", "reviewer"].map((role) => {
    const session = `${id}-${role}`;
    db.prepare(
      "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, 'idle', ?, ?)",
    ).run(session, id, session, id, now, now);
    return session;
  });
  const group = createAgentGroup({ name: id, workspaceId: id });
  for (const session of members) addAgentGroupMember({ groupId: group.id, sessionId: session });
  const owner = members[0] ?? "";
  const reviewer = members[1] ?? "";
  const task = createGroupTask({
    groupId: group.id,
    title: "Work",
    ownerSessionId: owner,
    reviewerSessionId: reviewer,
    status: "in_progress",
  });
  const executionId = appendGroupMessage({ groupId: group.id, authorKind: "user", body: "Ask" }).id;
  return { db, group, task, owner, reviewer, executionId };
}

describe("group task migration", () => {
  it("preserves old rows, foreign keys, execution, branch, status and timestamps while projecting defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "modus-task-migrate-"));
    const db = new DatabaseSync(join(dir, "old.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(db);
      db.exec(`drop table group_tasks;
        create table group_tasks (
          id text primary key, group_id text not null references agent_groups(id) on delete cascade,
          title text not null, description text,
          status text not null default 'open' check (status in ('open','in_progress','in_review','done','cancelled')),
          owner_session_id text references agent_sessions(id) on delete set null,
          created_by_session_id text references agent_sessions(id) on delete set null,
          reviewer_session_id text references agent_sessions(id) on delete set null,
          branch text, execution_id text, created_at text not null, updated_at text not null
        );`);
      const stamp = "2020-01-02T03:04:05.000Z";
      db.prepare(
        "insert into workspaces (id, root_path, display_name, last_opened_at, created_at) values ('w','w','w',?,?)",
      ).run(stamp, stamp);
      db.prepare(
        "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values ('s','w','s','w','idle',?,?)",
      ).run(stamp, stamp);
      db.prepare(
        "insert into agent_groups (id,name,workspace_id,mode,created_at,updated_at) values ('g','g','w','free',?,?)",
      ).run(stamp, stamp);
      db.prepare(
        "insert into group_messages (id,group_id,author_kind,body,created_at) values ('e','g','user','ask',?)",
      ).run(stamp);
      db.prepare(
        "insert into group_tasks (id,group_id,title,status,owner_session_id,created_by_session_id,reviewer_session_id,branch,execution_id,created_at,updated_at) values ('t','g','legacy','in_review','s','s','s','feature/x','e',?,?)",
      ).run(stamp, stamp);
      migrateDatabase(db);
      migrateDatabase(db);
      const row = db.prepare("select * from group_tasks where id = 't'").get() as Record<
        string,
        unknown
      >;
      expect(row).toMatchObject({
        id: "t",
        group_id: "g",
        status: "in_review",
        owner_session_id: "s",
        reviewer_session_id: "s",
        branch: "feature/x",
        execution_id: "e",
        created_at: stamp,
        updated_at: stamp,
        kind: "legacy",
        priority: "normal",
        criteria_version: 1,
        state_version: 1,
      });
      expect(JSON.parse(row.dependency_ids_json as string)).toEqual([]);
      expect(JSON.parse(row.criteria_json as string)).toEqual([]);
      expect(JSON.parse(row.verification_policy_json as string)).toEqual({
        mode: "none",
        requireReview: false,
      });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("select count(*) as n from group_task_events").get()).toEqual({ n: 0 });
      db.prepare("update group_tasks set status = 'blocked' where id = 't'").run();
      db.prepare("delete from agent_sessions where id = 's'").run();
      expect(db.prepare("select owner_session_id from group_tasks where id = 't'").get()).toEqual({
        owner_session_id: null,
      });
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("versioned task state", () => {
  it("persists structured criteria, dependencies and verification policy", () => {
    const { group, task } = fixture();
    const created = createGroupTask({
      groupId: group.id,
      title: "Verify",
      kind: "code",
      priority: "high",
      dependencyIds: [task.id],
      criteria: [{ id: "qa", description: "Checks pass", requiredCheckKinds: ["tests"] }],
      verificationPolicy: { mode: "required", requireReview: true },
    });
    expect(created).toMatchObject({
      kind: "code",
      priority: "high",
      dependencyIds: [task.id],
      criteriaVersion: 1,
      stateVersion: 1,
      verificationPolicy: { mode: "required", requireReview: true },
    });
    expect(listGroupTasks(group.id).find((item) => item.id === created.id)?.criteria).toEqual([
      { id: "qa", description: "Checks pass", requiredCheckKinds: ["tests"] },
    ]);
    expect(() =>
      createGroupTask({
        groupId: group.id,
        title: "Bad",
        kind: "code",
        priority: "normal",
        dependencyIds: ["missing"],
        criteria: [],
        verificationPolicy: { mode: "none", requireReview: false },
      }),
    ).toThrow();
  });

  it("rejects a stale version without a write and replays one operation without another event", () => {
    const { db, group, task, owner } = fixture();
    const operationId = crypto.randomUUID();
    const input = {
      groupId: group.id,
      taskId: task.id,
      actorSessionId: owner,
      expectedVersion: 1,
      operationId,
      stage: "implement" as const,
    };
    const first = reportGroupTaskProgress(input);
    expect(first).toMatchObject({ stage: "implement", stateVersion: 2 });
    expect(reportGroupTaskProgress(input)).toEqual(first);
    expect(
      reportGroupTaskProgress({
        operationId,
        stage: "implement",
        expectedVersion: 1,
        actorSessionId: owner,
        taskId: task.id,
        groupId: group.id,
      }),
    ).toEqual(first);
    expect(listGroupTaskTransitions(task.id)).toHaveLength(1);
    expect(() =>
      reportGroupTaskProgress({ ...input, operationId: crypto.randomUUID(), stage: "verify" }),
    ).toThrow();
    expect(listGroupTaskTransitions(task.id)).toHaveLength(1);
    expect(db.prepare("select state_version from group_tasks where id = ?").get(task.id)).toEqual({
      state_version: 2,
    });
  });

  it("blocks and resolves with owner authority; validates evidence criterion scope", () => {
    const { group, task, owner, reviewer } = fixture();
    expect(() =>
      reportGroupTaskProgress({
        groupId: group.id,
        taskId: task.id,
        actorSessionId: reviewer,
        expectedVersion: 1,
        operationId: crypto.randomUUID(),
        blockedReason: "waiting",
      }),
    ).toThrow();
    const blocked = reportGroupTaskProgress({
      groupId: group.id,
      taskId: task.id,
      actorSessionId: owner,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
      blockedReason: "waiting",
    });
    expect(blocked).toMatchObject({ status: "blocked", blockedReason: "waiting", stateVersion: 2 });
    const resumed = reportGroupTaskProgress({
      groupId: group.id,
      taskId: task.id,
      actorSessionId: owner,
      expectedVersion: 2,
      operationId: crypto.randomUUID(),
      blockedReason: null,
    });
    expect(resumed).toMatchObject({ status: "in_progress", stateVersion: 3 });
    expect(() =>
      recordGroupTaskEvidence({
        groupId: group.id,
        taskId: task.id,
        actorSessionId: owner,
        expectedVersion: 3,
        operationId: crypto.randomUUID(),
        evidenceRefs: [
          {
            criterionId: "unknown",
            criteriaVersion: 1,
            sessionId: owner,
            runId: "r",
            eventRowId: 1,
            evidenceId: "x",
            sourceFingerprint: "sha",
          },
        ],
      }),
    ).toThrow();
  });

  it("records scoped evidence for a matching durable run", () => {
    const { group, owner, executionId } = fixture();
    const task = createGroupTask({
      groupId: group.id,
      title: "QA",
      ownerSessionId: owner,
      status: "in_progress",
      kind: "code",
      priority: "normal",
      dependencyIds: [],
      criteria: [{ id: "check", description: "Pass", requiredCheckKinds: ["tests"] }],
      verificationPolicy: { mode: "required", requireReview: false },
    });
    const runId = crypto.randomUUID();
    bindGroupTaskRun({
      groupId: group.id,
      taskId: task.id,
      taskVersion: 1,
      criteriaVersion: 1,
      sessionId: owner,
      runId,
      executionId,
      role: "owner",
      sourceFingerprint: "sha",
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
    });
    const evidenceRefs = [
      {
        criterionId: "check",
        checkName: "tests" as const,
        criteriaVersion: 1,
        sessionId: owner,
        runId,
        evidenceId: "qa",
        sourceFingerprint: "final-sha",
        eventRowId: recordAgentEvent({
          type: "harness.qa",
          sessionId: owner,
          runId,
          result: {
            required: true,
            status: "passed",
            reasonCode: "checks_passed",
            sourceFingerprint: "final-sha",
            evidence: [
              {
                id: "qa",
                kind: "check",
                status: "passed",
                label: "Tests",
                checkName: "tests",
                runId,
              },
            ],
          },
        }),
      },
    ];
    const input = {
      groupId: group.id,
      taskId: task.id,
      actorSessionId: owner,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
      evidenceRefs,
    };
    const stored = recordGroupTaskEvidence(input);
    expect(stored).toMatchObject({ evidenceRefs, stateVersion: 2 });
    expect(recordGroupTaskEvidence(input)).toEqual(stored);
    expect(listGroupTaskTransitions(task.id)).toHaveLength(1);
  });

  it("binds a run once and rejects reassignment; keeps binding and events after member removal", () => {
    const { group, task, owner, executionId } = fixture();
    const input = {
      groupId: group.id,
      taskId: task.id,
      taskVersion: 1,
      criteriaVersion: 1,
      sessionId: owner,
      runId: crypto.randomUUID(),
      executionId,
      role: "owner" as const,
      sourceFingerprint: "sha",
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
    };
    bindGroupTaskRun(input);
    bindGroupTaskRun(input);
    expect(getGroupTaskRunBinding(owner, input.runId)).toEqual({
      groupId: group.id,
      taskId: task.id,
      taskVersion: 1,
      criteriaVersion: 1,
      sessionId: owner,
      runId: input.runId,
      executionId,
      role: "owner",
      sourceFingerprint: "sha",
    });
    expect(() =>
      bindGroupTaskRun({ ...input, taskVersion: 2, operationId: crypto.randomUUID() }),
    ).toThrow();
    reportGroupTaskProgress({
      groupId: group.id,
      taskId: task.id,
      actorSessionId: owner,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
      stage: "verify",
    });
    removeAgentGroupMember(group.id, owner);
    expect(listGroupTasks(group.id)[0]).toMatchObject({ status: "open", stateVersion: 3 });
    expect(listGroupTaskTransitions(task.id)).toHaveLength(2);
    expect(getGroupTaskRunBinding(owner, input.runId)?.taskId).toBe(task.id);
  });

  it("rejects a saved operation key for another bound run and a fresh key for an existing run", () => {
    const { group, task, owner, executionId } = fixture();
    const first = {
      groupId: group.id,
      taskId: task.id,
      taskVersion: 1,
      criteriaVersion: 1,
      sessionId: owner,
      runId: crypto.randomUUID(),
      executionId,
      role: "owner" as const,
      sourceFingerprint: "sha",
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
    };
    const second = { ...first, runId: crypto.randomUUID(), operationId: crypto.randomUUID() };
    bindGroupTaskRun(first);
    bindGroupTaskRun(second);
    expect(() => bindGroupTaskRun({ ...second, operationId: first.operationId })).toThrow();
    expect(() => bindGroupTaskRun({ ...first, operationId: crypto.randomUUID() })).toThrow();
    expect(getGroupTaskRunBinding(owner, first.runId)?.taskId).toBe(task.id);
    expect(getGroupTaskRunBinding(owner, second.runId)?.taskId).toBe(task.id);
  });

  it("rejects run bindings to a foreign or missing group execution without writing", () => {
    const { db, group, task, owner } = fixture();
    const foreignGroup = createAgentGroup({ name: crypto.randomUUID() });
    const foreignExecution = appendGroupMessage({
      groupId: foreignGroup.id,
      authorKind: "user",
      body: "Foreign ask",
    });
    const binding = {
      groupId: group.id,
      taskId: task.id,
      taskVersion: 1,
      criteriaVersion: 1,
      sessionId: owner,
      executionId: foreignExecution.id,
      role: "owner" as const,
      sourceFingerprint: "sha",
      expectedVersion: 1,
    };
    const foreignRunId = crypto.randomUUID();
    expect(() =>
      bindGroupTaskRun({ ...binding, runId: foreignRunId, operationId: crypto.randomUUID() }),
    ).toThrow();
    expect(getGroupTaskRunBinding(owner, foreignRunId)).toBeUndefined();
    const missingRunId = crypto.randomUUID();
    expect(() =>
      bindGroupTaskRun({
        ...binding,
        executionId: "missing",
        runId: missingRunId,
        operationId: crypto.randomUUID(),
      }),
    ).toThrow();
    expect(getGroupTaskRunBinding(owner, missingRunId)).toBeUndefined();
    expect(
      db.prepare("select count(*) as n from group_task_runs where task_id = ?").get(task.id),
    ).toEqual({ n: 0 });
  });

  it("records concrete legacy actions and actors, including same-status reassignment", () => {
    const { group, task, owner, reviewer } = fixture();
    const open = createGroupTask({ groupId: group.id, title: "Review path" });
    claimGroupTask(group.id, open.id, owner);
    releaseGroupTask(group.id, open.id, owner);
    claimGroupTask(group.id, open.id, owner);
    requestGroupTaskReview(group.id, open.id, owner, reviewer);
    reviewGroupTask(group.id, open.id, reviewer, "changes");
    requestGroupTaskReview(group.id, open.id, owner, reviewer);
    reviewGroupTask(group.id, open.id, reviewer, "approve");
    expect(
      listGroupTaskTransitions(open.id).map(({ action, actorSessionId }) => [
        action,
        actorSessionId,
      ]),
    ).toEqual([
      ["claim", owner],
      ["release", owner],
      ["claim", owner],
      ["request_review", owner],
      ["review", reviewer],
      ["request_review", owner],
      ["review", reviewer],
    ]);
    completeGroupTaskForAgreement(group.id, task.id, reviewer);
    expect(listGroupTaskTransitions(task.id)[0]).toMatchObject({
      action: "agreement",
      actorSessionId: reviewer,
    });
    setAgentGroupLead(group.id, owner);
    const reassigned = createGroupTask({
      groupId: group.id,
      title: "Reassign",
      status: "in_progress",
      ownerSessionId: owner,
    });
    assignGroupTask(group.id, reassigned.id, owner, reviewer);
    expect(listGroupTaskTransitions(reassigned.id)[0]).toMatchObject({
      action: "assign",
      actorSessionId: owner,
      fromStatus: "in_progress",
      toStatus: "in_progress",
    });
  });

  it("does not reuse an event operation key for a run or lose reviewer history", () => {
    const { db, group, task, owner, reviewer, executionId } = fixture();
    const operationId = crypto.randomUUID();
    reportGroupTaskProgress({
      groupId: group.id,
      taskId: task.id,
      actorSessionId: owner,
      expectedVersion: 1,
      operationId,
      stage: "verify",
    });
    expect(() =>
      bindGroupTaskRun({
        groupId: group.id,
        taskId: task.id,
        taskVersion: 2,
        criteriaVersion: 1,
        sessionId: owner,
        runId: crypto.randomUUID(),
        executionId,
        role: "owner",
        sourceFingerprint: "sha",
        expectedVersion: 2,
        operationId,
      }),
    ).toThrow();
    removeAgentGroupMember(group.id, reviewer);
    expect(listGroupTaskTransitions(task.id).map((event) => event.action)).toEqual([
      "progress",
      "member_removed",
    ]);
    expect(
      db.prepare("select reviewer_session_id from group_tasks where id = ?").get(task.id),
    ).toEqual({ reviewer_session_id: null });
  });

  it("rejects malformed persisted JSON rather than projecting it as task state", () => {
    const { db, group, task } = fixture();
    expect(() =>
      db.prepare("update group_tasks set criteria_json = '{}' where id = ?").run(task.id),
    ).toThrow();
    expect(listGroupTasks(group.id)[0]?.criteria).toEqual([]);
    db.prepare("update group_tasks set verification_policy_json = '{}' where id = ?").run(task.id);
    expect(() => listGroupTasks(group.id)).toThrow();
  });
});
