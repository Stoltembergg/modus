import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let userData: string;
vi.mock("electron", () => ({ app: { getPath: () => userData } }));
const { getDatabase } = await import("../db/database");
const { recordAgentEvent } = await import("../agent/agent-event-store");
const { createAgentGroup, addAgentGroupMember, appendGroupMessage, removeAgentGroupMember } =
  await import("./group-store");
const {
  createGroupTask,
  bindGroupTaskRun,
  recordGroupTaskEvidence,
  reportGroupTaskProgress,
  getGroupTask,
  updateGroupTask,
} = await import("./group-task-store");
const {
  collectGroupTaskRunEvidence,
  resolveGroupTaskEvidence,
  verifyGroupTaskForTransition,
  findGroupTaskForWake,
} = await import("./group-task-evidence");
const { getGroupSourceFingerprint } = await import("../git/git-service");
const git = promisify(execFile);

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-task-evidence-"));
});
afterAll(async () => {
  await rm(userData, { recursive: true, force: true });
});

async function fixture(checks: Array<"tests" | "typecheck"> = ["tests"]) {
  const root = await mkdtemp(join(userData, "source-"));
  await git("git", ["init"], { cwd: root });
  await git("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await git("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "source.ts"), "base\n");
  await git("git", ["add", "."], { cwd: root });
  await git("git", ["commit", "-m", "base"], { cwd: root });
  const db = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "insert into workspaces (id, root_path, display_name, last_opened_at, created_at) values (?, ?, ?, ?, ?)",
  ).run(id, root, id, now, now);
  const owner = `${id}-owner`,
    reviewer = `${id}-reviewer`;
  for (const session of [owner, reviewer])
    db.prepare(
      "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, 'idle', ?, ?)",
    ).run(session, id, session, root, now, now);
  const group = createAgentGroup({ name: id, workspaceId: id });
  for (const session of [owner, reviewer])
    addAgentGroupMember({ groupId: group.id, sessionId: session });
  const task = createGroupTask({
    groupId: group.id,
    title: "QA",
    ownerSessionId: owner,
    reviewerSessionId: reviewer,
    status: "in_progress",
    kind: "code",
    priority: "normal",
    dependencyIds: [],
    criteria: [{ id: "criterion", description: "Verified", requiredCheckKinds: checks }],
    verificationPolicy: { mode: "required", requireReview: checks.length === 0 },
  });
  const executionId = appendGroupMessage({
    groupId: group.id,
    authorKind: "user",
    body: "Work",
  }).id;
  const sourceFingerprint = await getGroupSourceFingerprint(root);
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
    sourceFingerprint,
    expectedVersion: 1,
    operationId: crypto.randomUUID(),
  });
  const binding = {
    groupId: group.id,
    taskId: task.id,
    taskVersion: 1,
    criteriaVersion: 1,
    sessionId: owner,
    runId,
    executionId,
    role: "owner" as const,
    sourceFingerprint,
  };
  return { root, db, group, task, owner, reviewer, runId, binding, sourceFingerprint };
}

function qa(
  sessionId: string,
  runId: string,
  sourceFingerprint: string,
  checks: Array<{ checkName: string; status: string }> = [{ checkName: "tests", status: "passed" }],
) {
  return recordAgentEvent({
    type: "harness.qa",
    sessionId,
    runId,
    result: {
      required: true,
      status: "passed",
      reasonCode: "all_passed",
      sourceFingerprint,
      evidence: checks.map((item, index) => ({
        id: `e${index}`,
        kind: "check",
        status: item.status,
        label: item.checkName,
        checkName: item.checkName,
        runId,
      })),
    },
  } as Parameters<typeof recordAgentEvent>[0]);
}

describe("group task evidence", () => {
  it("binds only an unambiguous task in the same execution", async () => {
    const f = await fixture();
    f.db
      .prepare("update group_tasks set execution_id = ? where id = ?")
      .run(f.binding.executionId, f.task.id);
    expect(findGroupTaskForWake(f.group.id, f.owner, f.binding.executionId)?.taskId).toBe(
      f.task.id,
    );
    createGroupTask({
      groupId: f.group.id,
      title: "Second",
      ownerSessionId: f.owner,
      status: "in_progress",
      executionId: f.binding.executionId,
    });
    expect(findGroupTaskForWake(f.group.id, f.owner, f.binding.executionId)).toBeUndefined();
    await rm(f.root, { recursive: true, force: true });
  });
  it("rejects_other_run_or_group_evidence", async () => {
    const f = await fixture();
    const wrongRun = qa(f.owner, crypto.randomUUID(), f.sourceFingerprint);
    expect(collectGroupTaskRunEvidence(f.binding, wrongRun)).toEqual([]);
    const rightRow = qa(f.owner, f.runId, f.sourceFingerprint);
    expect(collectGroupTaskRunEvidence({ ...f.binding, groupId: "other" }, rightRow)).toEqual([]);
    const refs = collectGroupTaskRunEvidence(f.binding, rightRow);
    expect(refs).toMatchObject([
      {
        criterionId: "criterion",
        runId: f.runId,
        eventRowId: rightRow,
        sourceFingerprint: f.sourceFingerprint,
      },
    ]);
    const first = refs[0];
    if (!first) throw new Error("Expected a QA reference.");
    expect(() =>
      recordGroupTaskEvidence({
        groupId: f.group.id,
        taskId: f.task.id,
        actorSessionId: f.owner,
        expectedVersion: 1,
        operationId: crypto.randomUUID(),
        evidenceRefs: [{ ...first, eventRowId: wrongRun }],
      }),
    ).toThrow();
    expect(resolveGroupTaskEvidence(f.task, f.sourceFingerprint).criterionOutcomes).toMatchObject([
      { status: "missing" },
    ]);
    await rm(f.root, { recursive: true, force: true });
  });

  it("unchanged_head_with_edit_invalidates_evidence", async () => {
    const f = await fixture();
    const row = qa(f.owner, f.runId, f.sourceFingerprint);
    const refs = collectGroupTaskRunEvidence(f.binding, row);
    recordGroupTaskEvidence({
      groupId: f.group.id,
      taskId: f.task.id,
      actorSessionId: f.owner,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
      evidenceRefs: refs,
    });
    await writeFile(join(f.root, "source.ts"), "edited\n");
    const current = await getGroupSourceFingerprint(f.root);
    expect(current).not.toBe(f.sourceFingerprint);
    expect(
      resolveGroupTaskEvidence({ ...f.task, evidenceRefs: refs }, current).criterionOutcomes[0]
        ?.status,
    ).not.toBe("passed");
    await rm(f.root, { recursive: true, force: true });
  });

  it("criterion_without_checks_needs_scoped_review", async () => {
    const f = await fixture([]);
    expect(
      resolveGroupTaskEvidence(f.task, f.sourceFingerprint).criterionOutcomes[0]?.status,
    ).not.toBe("passed");
    const review = {
      reviewerSessionId: f.reviewer,
      verdict: "approve" as const,
      criteriaVersion: 1,
      sourceFingerprint: f.sourceFingerprint,
      eventId: crypto.randomUUID(),
      approvedCriterionIds: ["criterion"],
    };
    const snapshot = await verifyGroupTaskForTransition({
      taskId: f.task.id,
      expectedVersion: 1,
      action: "approve",
      review,
    });
    expect(snapshot.criterionOutcomes[0]?.status).toBe("review_approved");
    expect(snapshot.review).toEqual(review);
    await rm(f.root, { recursive: true, force: true });
  });

  it("missing_or_deleted_source_is_unavailable", async () => {
    const f = await fixture();
    await rm(f.root, { recursive: true, force: true });
    const snapshot = await verifyGroupTaskForTransition({
      taskId: f.task.id,
      expectedVersion: 1,
      action: "agree",
    });
    expect(snapshot.criterionOutcomes[0]?.status).toBe("unavailable");
    const proposed = await verifyGroupTaskForTransition({
      taskId: f.task.id,
      expectedVersion: 1,
      action: "approve",
      review: {
        reviewerSessionId: f.reviewer,
        verdict: "approve",
        criteriaVersion: 1,
        sourceFingerprint: f.sourceFingerprint,
        eventId: crypto.randomUUID(),
        approvedCriterionIds: ["criterion"],
      },
    });
    expect(proposed.criterionOutcomes[0]?.status).toBe("unavailable");
  });

  it("late_qa_cannot_verify_new_task_version", async () => {
    const f = await fixture();
    f.db
      .prepare("update group_tasks set criteria_version = criteria_version + 1 where id = ?")
      .run(f.task.id);
    const row = qa(f.owner, f.runId, f.sourceFingerprint);
    expect(collectGroupTaskRunEvidence(f.binding, row)).toEqual([]);
    await rm(f.root, { recursive: true, force: true });
  });

  it("requires every typed check and rejects user confirmation", async () => {
    const f = await fixture(["tests", "typecheck"]);
    const row = qa(f.owner, f.runId, f.sourceFingerprint, [
      { checkName: "tests", status: "passed" },
      { checkName: "typecheck", status: "user_confirmed" },
    ]);
    const refs = collectGroupTaskRunEvidence(f.binding, row);
    expect(refs).toHaveLength(2);
    expect(
      resolveGroupTaskEvidence({ ...f.task, evidenceRefs: refs }, f.sourceFingerprint)
        .criterionOutcomes[0]?.status,
    ).not.toBe("passed");
    await rm(f.root, { recursive: true, force: true });
  });

  it("keeps QA current after a stage-only progress update", async () => {
    const f = await fixture();
    const row = qa(f.owner, f.runId, f.sourceFingerprint);
    const refs = collectGroupTaskRunEvidence(f.binding, row);
    recordGroupTaskEvidence({
      groupId: f.group.id,
      taskId: f.task.id,
      actorSessionId: f.owner,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
      evidenceRefs: refs,
    });
    reportGroupTaskProgress({
      groupId: f.group.id,
      taskId: f.task.id,
      actorSessionId: f.owner,
      expectedVersion: 2,
      operationId: crypto.randomUUID(),
      stage: "verify",
    });
    expect(
      resolveGroupTaskEvidence(getGroupTask(f.task.id), f.sourceFingerprint).criterionOutcomes[0]
        ?.status,
    ).toBe("passed");
    await rm(f.root, { recursive: true, force: true });
  });

  it("preserves owner QA when only the reviewer is removed and replaced", async () => {
    const f = await fixture();
    const firstRow = qa(f.owner, f.runId, f.sourceFingerprint);
    const firstRefs = collectGroupTaskRunEvidence(f.binding, firstRow);
    recordGroupTaskEvidence({
      groupId: f.group.id,
      taskId: f.task.id,
      actorSessionId: f.owner,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
      evidenceRefs: firstRefs,
    });
    removeAgentGroupMember(f.group.id, f.reviewer);
    const replacement = `${f.owner}-new-reviewer`;
    const now = new Date().toISOString();
    f.db
      .prepare(
        "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, 'idle', ?, ?)",
      )
      .run(replacement, f.group.workspaceId ?? "", replacement, f.root, now, now);
    addAgentGroupMember({ groupId: f.group.id, sessionId: replacement });
    updateGroupTask(f.task.id, { reviewerSessionId: replacement });
    expect(
      resolveGroupTaskEvidence(getGroupTask(f.task.id), f.sourceFingerprint).criterionOutcomes[0]
        ?.status,
    ).toBe("passed");
    const lateRow = qa(f.owner, f.runId, f.sourceFingerprint);
    const lateRefs = collectGroupTaskRunEvidence(f.binding, lateRow);
    expect(lateRefs).toHaveLength(1);
    expect(
      recordGroupTaskEvidence({
        groupId: f.group.id,
        taskId: f.task.id,
        actorSessionId: f.owner,
        expectedVersion: getGroupTask(f.task.id).stateVersion ?? 0,
        operationId: crypto.randomUUID(),
        evidenceRefs: lateRefs,
      }).evidenceRefs,
    ).toEqual(lateRefs);
    await rm(f.root, { recursive: true, force: true });
  });

  it("preserves an owner binding across a legacy reviewer-removal event", async () => {
    const f = await fixture();
    const row = qa(f.owner, f.runId, f.sourceFingerprint);
    removeAgentGroupMember(f.group.id, f.reviewer);
    f.db
      .prepare(
        "update group_task_events set result_json = null where task_id = ? and action = 'member_removed'",
      )
      .run(f.task.id);
    expect(collectGroupTaskRunEvidence(f.binding, row)).toHaveLength(1);
    await rm(f.root, { recursive: true, force: true });
  });

  it("preserves reviewer QA when only the owner changes", async () => {
    const f = await fixture();
    const reviewTask = updateGroupTask(f.task.id, { status: "in_review" });
    const reviewerRun = crypto.randomUUID();
    const binding = {
      ...f.binding,
      taskVersion: reviewTask.stateVersion ?? 0,
      sessionId: f.reviewer,
      runId: reviewerRun,
      role: "reviewer" as const,
    };
    bindGroupTaskRun({
      ...binding,
      expectedVersion: binding.taskVersion,
      operationId: crypto.randomUUID(),
    });
    const replacement = `${f.owner}-replacement`;
    const now = new Date().toISOString();
    f.db
      .prepare(
        "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, 'idle', ?, ?)",
      )
      .run(replacement, f.group.workspaceId ?? "", replacement, f.root, now, now);
    addAgentGroupMember({ groupId: f.group.id, sessionId: replacement });
    updateGroupTask(f.task.id, { ownerSessionId: replacement });
    const row = qa(f.reviewer, reviewerRun, f.sourceFingerprint);
    const refs = collectGroupTaskRunEvidence(binding, row);
    expect(refs).toHaveLength(1);
    expect(
      recordGroupTaskEvidence({
        groupId: f.group.id,
        taskId: f.task.id,
        actorSessionId: f.reviewer,
        expectedVersion: getGroupTask(f.task.id).stateVersion ?? 0,
        operationId: crypto.randomUUID(),
        evidenceRefs: refs,
      }).evidenceRefs,
    ).toEqual(refs);
    expect(
      resolveGroupTaskEvidence(getGroupTask(f.task.id), f.sourceFingerprint).criterionOutcomes[0]
        ?.status,
    ).toBe("passed");
    await rm(f.root, { recursive: true, force: true });
  });

  it("preserves a binding across branch, status, and identical-owner updates", async () => {
    const f = await fixture();
    updateGroupTask(f.task.id, { branch: "feature/same" });
    updateGroupTask(f.task.id, { status: "in_progress" });
    updateGroupTask(f.task.id, { ownerSessionId: f.owner });
    const row = qa(f.owner, f.runId, f.sourceFingerprint);
    const refs = collectGroupTaskRunEvidence(f.binding, row);
    expect(refs).toHaveLength(1);
    expect(
      recordGroupTaskEvidence({
        groupId: f.group.id,
        taskId: f.task.id,
        actorSessionId: f.owner,
        expectedVersion: getGroupTask(f.task.id).stateVersion ?? 0,
        operationId: crypto.randomUUID(),
        evidenceRefs: refs,
      }).evidenceRefs,
    ).toEqual(refs);
    expect(
      resolveGroupTaskEvidence(getGroupTask(f.task.id), f.sourceFingerprint).criterionOutcomes[0]
        ?.status,
    ).toBe("passed");
    await rm(f.root, { recursive: true, force: true });
  });

  it("rejects owner QA after assignment moves away and returns", async () => {
    const f = await fixture();
    const row = qa(f.owner, f.runId, f.sourceFingerprint);
    const refs = collectGroupTaskRunEvidence(f.binding, row);
    expect(refs).toHaveLength(1);
    updateGroupTask(f.task.id, { ownerSessionId: f.reviewer });
    updateGroupTask(f.task.id, { ownerSessionId: f.owner });
    expect(collectGroupTaskRunEvidence(f.binding, row)).toEqual([]);
    expect(
      resolveGroupTaskEvidence(
        { ...getGroupTask(f.task.id), evidenceRefs: refs },
        f.sourceFingerprint,
      ).criterionOutcomes[0]?.status,
    ).not.toBe("passed");
    expect(() =>
      recordGroupTaskEvidence({
        groupId: f.group.id,
        taskId: f.task.id,
        actorSessionId: f.owner,
        expectedVersion: 3,
        operationId: crypto.randomUUID(),
        evidenceRefs: refs,
      }),
    ).toThrow();
    await rm(f.root, { recursive: true, force: true });
  });

  it("rejects reviewer QA after reviewer is removed and restored", async () => {
    const f = await fixture();
    const reviewTask = updateGroupTask(f.task.id, { status: "in_review" });
    const reviewerRun = crypto.randomUUID();
    bindGroupTaskRun({
      groupId: f.group.id,
      taskId: f.task.id,
      taskVersion: reviewTask.stateVersion ?? 0,
      criteriaVersion: reviewTask.criteriaVersion ?? 0,
      sessionId: f.reviewer,
      runId: reviewerRun,
      executionId: f.binding.executionId,
      role: "reviewer",
      sourceFingerprint: f.sourceFingerprint,
      expectedVersion: reviewTask.stateVersion ?? 0,
      operationId: crypto.randomUUID(),
    });
    const binding = {
      ...f.binding,
      taskVersion: reviewTask.stateVersion ?? 0,
      sessionId: f.reviewer,
      runId: reviewerRun,
      role: "reviewer" as const,
    };
    const row = qa(f.reviewer, reviewerRun, f.sourceFingerprint);
    const refs = collectGroupTaskRunEvidence(binding, row);
    expect(refs).toHaveLength(1);
    updateGroupTask(f.task.id, { reviewerSessionId: null });
    updateGroupTask(f.task.id, { reviewerSessionId: f.reviewer });
    expect(collectGroupTaskRunEvidence(binding, row)).toEqual([]);
    expect(
      resolveGroupTaskEvidence(
        { ...getGroupTask(f.task.id), evidenceRefs: refs },
        f.sourceFingerprint,
      ).criterionOutcomes[0]?.status,
    ).not.toBe("passed");
    expect(() =>
      recordGroupTaskEvidence({
        groupId: f.group.id,
        taskId: f.task.id,
        actorSessionId: f.reviewer,
        expectedVersion: 4,
        operationId: crypto.randomUUID(),
        evidenceRefs: refs,
      }),
    ).toThrow();
    await rm(f.root, { recursive: true, force: true });
  });
});
