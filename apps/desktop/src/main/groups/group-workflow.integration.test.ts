import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentEvent, GroupRuntimeEvent } from "../../shared/contracts";
import type { PromptAgentInput, PromptTurnResult } from "../agent/runtime";

let userData: string;
vi.mock("electron", () => ({ app: { getPath: () => userData } }));
const sourceLookup = vi.hoisted(() => ({ wait: undefined as undefined | (() => Promise<void>) }));
vi.mock("./group-task-details", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./group-task-details")>();
  return {
    ...actual,
    getGroupTaskDetails: async (...args: Parameters<typeof actual.getGroupTaskDetails>) => {
      await sourceLookup.wait?.();
      return actual.getGroupTaskDetails(...args);
    },
  };
});

const { getDatabase } = await import("../db/database");
const { createAgentSessionRecord, updateAgentSessionWorktree } = await import(
  "../agent/agent-store"
);
const { getRunToolEvidence, recordAgentEvent } = await import("../agent/agent-event-store");
const { runGroupTool, runGroupVerifiedTool } = await import("../agent/tools/group-tools");
const {
  appendGroupMessage,
  assignGroupTask,
  createAgentGroupWithMembers,
  createGroupTask,
  listGroupTaskTransitions,
  removeAgentGroupMember,
  requestGroupTaskReview,
} = await import("./group-store");
const { bindGroupTaskRun, getGroupTask, getGroupTaskRunBinding, recordGroupTaskEvidence } =
  await import("./group-task-store");
const { collectGroupTaskRunEvidence } = await import("./group-task-evidence");
const {
  getGroupProactivityMode,
  getGroupActionBySource,
  listGroupActions,
  setGroupProactivityMode,
} = await import("./group-proactivity-store");
const { GroupRuntime } = await import("./group-runtime");
const { getHarnessQAEventByRowId } = await import("../agent/agent-event-store");
const { summarizeRunQA } = await import("../agent/harness/qa-evidence");
const { createGroupIntegrationService } = await import("./group-integration-service");
const { getGroupSourceFingerprint } = await import("../git/git-service");
const git = promisify(execFile);
const runtimeInstances: Array<InstanceType<typeof GroupRuntime>> = [];

afterEach(() => {
  sourceLookup.wait = undefined;
  for (const runtime of runtimeInstances.splice(0)) runtime.dispose();
  getDatabase().prepare("delete from group_jobs").run();
  getDatabase().prepare("delete from group_proactivity_actions").run();
});

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-group-workflow-"));
});

afterAll(async () => {
  getDatabase().close();
  await rm(userData, { recursive: true, force: true });
});

async function gitAt(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await git("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

function recordPassingCheckEvent(
  sessionId: string,
  runId: string,
): ReturnType<typeof summarizeRunQA>["evidence"][number] & { id: string; eventId: string } {
  const toolCallId = crypto.randomUUID();
  recordAgentEvent({
    type: "tool.started",
    sessionId,
    runId,
    toolCallId,
    toolName: "terminal_run",
    args: { command: "vitest run" },
  });
  recordAgentEvent({
    type: "tool.ended",
    sessionId,
    runId,
    toolCallId,
    toolName: "terminal_run",
    isError: false,
    exitCode: 0,
  });
  const result = summarizeRunQA({
    sessionId,
    runId,
    changedPaths: [],
    requiredChecks: ["tests"],
    events: getRunToolEvidence(sessionId, runId),
  });
  const evidence = result.evidence[0];
  if (result.status !== "passed" || !evidence?.id || !evidence.eventId) {
    throw new Error("Missing passed QA from persisted check events.");
  }
  return { ...evidence, id: evidence.id, eventId: evidence.eventId };
}

function runtimeSquad() {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "insert into workspaces (id, root_path, display_name, last_opened_at, created_at) values (?, ?, ?, ?, ?)",
  ).run(id, id, id, now, now);
  const sessions = ["Lead", "Owner", "Reviewer"].map((title) => {
    const sessionId = crypto.randomUUID();
    db.prepare(
      "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, 'idle', ?, ?)",
    ).run(sessionId, id, title, id, now, now);
    return sessionId;
  });
  const lead = sessions[0];
  const owner = sessions[1];
  const reviewer = sessions[2];
  if (!lead || !owner || !reviewer) throw new Error("Runtime Group fixture is incomplete.");
  const group = createAgentGroupWithMembers({
    name: id,
    workspaceId: id,
    mode: "coordinator",
    leadSessionId: lead,
    members: sessions.map((sessionId) => ({ sessionId })),
  });
  return { db, group, lead, owner, reviewer };
}

function runtime(windowAvailable = false) {
  let available = windowAvailable;
  const calls: Array<{ input: PromptAgentInput; resolve: (result: PromptTurnResult) => void }> = [];
  const listeners = new Set<(event: AgentEvent) => void>();
  const engine = {
    prompt: (_window: unknown, input: PromptAgentInput) =>
      new Promise<PromptTurnResult>((resolve) => calls.push({ input, resolve })),
    abort: async () => {},
    isSessionStreaming: () => false,
    onTurnSettled: () => () => {},
    onQuestionPending: () => () => {},
    onEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const events: GroupRuntimeEvent[] = [];
  const groups = new GroupRuntime({
    runtime: engine,
    host: {
      getWindow: () => (available ? ({} as never) : undefined),
      isUpdatePending: () => false,
      emit: (event) => events.push(event),
    },
  });
  runtimeInstances.push(groups);
  return {
    groups,
    calls,
    events,
    emit: (event: AgentEvent) => {
      for (const listener of listeners) listener(event);
    },
    setWindowAvailable: (value: boolean) => {
      available = value;
    },
  };
}

async function flushRuntime(): Promise<void> {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}

async function sourceTaskFixture() {
  const root = await mkdtemp(join(userData, "evidence-project-"));
  await gitAt(root, ["init", "-b", "main"]);
  await gitAt(root, ["config", "user.email", "test@example.com"]);
  await gitAt(root, ["config", "user.name", "Modus Test"]);
  await writeFile(join(root, "source.ts"), "base\n");
  await gitAt(root, ["add", "source.ts"]);
  await gitAt(root, ["commit", "-m", "base"]);

  const db = getDatabase();
  const workspaceId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at) values (?, ?, ?, 1, ?, ?)",
  ).run(workspaceId, root, workspaceId, now, now);
  const sessions = {
    lead: `${workspaceId}-lead`,
    owner: `${workspaceId}-owner`,
    reviewer: `${workspaceId}-reviewer`,
  };
  for (const [title, id] of Object.entries(sessions))
    createAgentSessionRecord({ id, workspaceId, title, cwd: root });
  const group = createAgentGroupWithMembers({
    name: workspaceId,
    workspaceId,
    mode: "coordinator",
    leadSessionId: sessions.lead,
    members: Object.values(sessions).map((sessionId) => ({ sessionId })),
  });
  const execution = appendGroupMessage({
    groupId: group.id,
    authorKind: "user",
    body: "Verify the source.",
  });
  const task = createGroupTask({
    groupId: group.id,
    title: "Verified source",
    status: "in_progress",
    ownerSessionId: sessions.owner,
    executionId: execution.id,
    kind: "code",
    priority: "normal",
    dependencyIds: [],
    criteria: [{ id: "tests", description: "Tests pass", requiredCheckKinds: ["tests"] }],
    verificationPolicy: { mode: "required", requireReview: true },
  });
  const fingerprint = await getGroupSourceFingerprint(root);
  const runId = crypto.randomUUID();
  bindGroupTaskRun({
    groupId: group.id,
    taskId: task.id,
    taskVersion: task.stateVersion ?? 1,
    criteriaVersion: task.criteriaVersion ?? 1,
    sessionId: sessions.owner,
    runId,
    executionId: execution.id,
    role: "owner",
    sourceFingerprint: fingerprint,
    expectedVersion: task.stateVersion ?? 1,
    operationId: crypto.randomUUID(),
  });
  const checkEvidence = recordPassingCheckEvent(sessions.owner, runId);
  const qaRowId = recordAgentEvent({
    type: "harness.qa",
    sessionId: sessions.owner,
    runId,
    result: {
      required: true,
      status: "passed",
      reasonCode: "all_passed",
      sourceFingerprint: fingerprint,
      evidence: [checkEvidence],
    },
  });
  const binding = getGroupTaskRunBinding(sessions.owner, runId);
  if (!binding) throw new Error("The task run binding was not persisted.");
  recordGroupTaskEvidence({
    groupId: group.id,
    taskId: task.id,
    actorSessionId: sessions.owner,
    expectedVersion: task.stateVersion ?? 1,
    operationId: `qa:${qaRowId}`,
    evidenceRefs: collectGroupTaskRunEvidence(binding, qaRowId),
  });
  const inReview = requestGroupTaskReview(group.id, task.id, sessions.owner, sessions.reviewer);
  return { root, db, group, sessions, task, inReview, binding, runId, qaRowId, fingerprint };
}

describe("verified Group task workflow", () => {
  it("keeps exact QA and review provenance through confirmed no-commit integration", async () => {
    const root = await mkdtemp(join(userData, "project-"));
    let source = "";
    try {
      await gitAt(root, ["init", "-b", "main"]);
      await gitAt(root, ["config", "user.email", "test@example.com"]);
      await gitAt(root, ["config", "user.name", "Modus Test"]);
      await writeFile(join(root, "shared.txt"), "base\n");
      await gitAt(root, ["add", "shared.txt"]);
      await gitAt(root, ["commit", "-m", "base"]);
      await writeFile(join(root, ".git", "info", "exclude"), ".modus/worktrees/\n");

      const db = getDatabase();
      const workspaceId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
         values (?, ?, ?, 1, ?, ?)`,
      ).run(workspaceId, root, workspaceId, now, now);
      const memberIds = {
        lead: `${workspaceId}-lead`,
        owner: `${workspaceId}-owner`,
        reviewer: `${workspaceId}-reviewer`,
      };
      for (const [role, id] of Object.entries(memberIds))
        createAgentSessionRecord({ id, workspaceId, title: role, cwd: root });
      const group = createAgentGroupWithMembers({
        name: workspaceId,
        workspaceId,
        mode: "coordinator",
        leadSessionId: memberIds.lead,
        members: Object.values(memberIds).map((sessionId) => ({ sessionId })),
      });

      source = join(root, ".modus", "worktrees", "owner");
      const branch = `group/${group.id}/owner`;
      await gitAt(root, ["worktree", "add", "-b", branch, source, "HEAD"]);
      const baseSha = await gitAt(source, ["rev-parse", "HEAD"]);
      await writeFile(join(source, "shared.txt"), "verified change\n");
      await gitAt(source, ["add", "shared.txt"]);
      await gitAt(source, ["commit", "-m", "verified change"]);
      updateAgentSessionWorktree(
        memberIds.owner,
        { path: source, branch, baseSha, integrationStatus: "running" },
        { cwd: source },
      );

      const prerequisite = createGroupTask({
        groupId: group.id,
        title: "Prerequisite",
        status: "done",
      });
      const execution = appendGroupMessage({
        groupId: group.id,
        authorKind: "user",
        body: "Implement and verify the change.",
      });
      const created = createGroupTask({
        groupId: group.id,
        title: "Verified change",
        createdBySessionId: memberIds.lead,
        executionId: execution.id,
        kind: "code",
        priority: "normal",
        dependencyIds: [prerequisite.id],
        criteria: [{ id: "tests-pass", description: "Tests pass", requiredCheckKinds: ["tests"] }],
        verificationPolicy: { mode: "required", requireReview: true },
      });
      expect(
        runGroupTool(
          "group_assign_task",
          { sessionId: memberIds.lead, groupId: group.id },
          {
            taskId: created.id,
            memberId: memberIds.owner,
            expectedVersion: created.stateVersion ?? 1,
            operationId: "task:assign-owner",
          },
        ),
      ).toContain("Assigned task");
      const assigned = getGroupTask(created.id);
      expect(assigned.branch).toBe(branch);
      const fingerprint = await getGroupSourceFingerprint(source);
      const runId = crypto.randomUUID();
      bindGroupTaskRun({
        groupId: group.id,
        taskId: assigned.id,
        taskVersion: assigned.stateVersion ?? 1,
        criteriaVersion: assigned.criteriaVersion ?? 1,
        sessionId: memberIds.owner,
        runId,
        executionId: execution.id,
        role: "owner",
        sourceFingerprint: fingerprint,
        expectedVersion: assigned.stateVersion ?? 1,
        operationId: crypto.randomUUID(),
      });
      const checkEvidence = recordPassingCheckEvent(memberIds.owner, runId);
      const qaRowId = recordAgentEvent({
        type: "harness.qa",
        sessionId: memberIds.owner,
        runId,
        result: {
          required: true,
          status: "passed",
          reasonCode: "all_passed",
          sourceFingerprint: fingerprint,
          evidence: [checkEvidence],
        },
      });
      const binding = getGroupTaskRunBinding(memberIds.owner, runId);
      if (!binding) throw new Error("The task run binding was not persisted.");
      const evidenceRefs = collectGroupTaskRunEvidence(binding, qaRowId);
      expect(evidenceRefs).toMatchObject([
        {
          criterionId: "tests-pass",
          criteriaVersion: assigned.criteriaVersion,
          sessionId: memberIds.owner,
          runId,
          eventRowId: qaRowId,
          sourceFingerprint: fingerprint,
        },
      ]);
      const evidenced = recordGroupTaskEvidence({
        groupId: group.id,
        taskId: assigned.id,
        actorSessionId: memberIds.owner,
        expectedVersion: assigned.stateVersion ?? 1,
        operationId: `qa:${qaRowId}`,
        evidenceRefs,
      });
      expect(
        runGroupTool(
          "group_request_review",
          { sessionId: memberIds.owner, groupId: group.id },
          {
            id: assigned.id,
            reviewer: memberIds.reviewer,
            expectedVersion: evidenced.stateVersion ?? 1,
            operationId: "task:request-review",
          },
        ),
      ).toContain("Review requested from");
      const inReview = getGroupTask(assigned.id);
      const reviewResult = await runGroupVerifiedTool(
        "group_review_task",
        { sessionId: memberIds.reviewer, groupId: group.id, toolCallId: "approve" },
        {
          id: inReview.id,
          verdict: "approve",
          approvedCriterionIds: ["tests-pass"],
          expectedVersion: inReview.stateVersion ?? 1,
          operationId: "review:approve",
        },
      );
      expect(reviewResult).toContain("Approved: task");
      expect(getGroupTask(assigned.id)).toMatchObject({
        status: "done",
        ownerSessionId: memberIds.owner,
        reviewerSessionId: memberIds.reviewer,
        dependencyIds: [prerequisite.id],
        evidenceRefs: [expect.objectContaining({ eventRowId: qaRowId, runId })],
        review: expect.objectContaining({
          reviewerSessionId: memberIds.reviewer,
          criteriaVersion: assigned.criteriaVersion,
          sourceFingerprint: fingerprint,
          eventId: "review:approve",
          approvedCriterionIds: ["tests-pass"],
        }),
      });

      const transitions = listGroupTaskTransitions(assigned.id);
      expect(transitions.map((event) => event.action)).toEqual([
        "group_assign_task",
        "evidence",
        "group_request_review",
        "group_review_task",
      ]);
      expect(transitions.map((event) => event.taskVersion)).toEqual([2, 3, 4, 5]);
      expect(
        transitions.every((event) => event.groupId === group.id && event.taskId === assigned.id),
      ).toBe(true);
      const evidenceEvent = transitions[1];
      if (!evidenceEvent) throw new Error("Evidence transition was not persisted.");
      expect(evidenceEvent?.executionId).toBe(execution.id);
      const evidenceRecord = db
        .prepare("select operation_id, result_json from group_task_events where id = ?")
        .get(evidenceEvent.id) as { operation_id: string; result_json: string };
      expect(evidenceRecord.operation_id).toBe(`qa:${qaRowId}`);
      expect(JSON.parse(evidenceRecord.result_json)).toMatchObject({
        input: { evidenceRefs: [expect.objectContaining({ eventRowId: qaRowId, runId })] },
      });
      expect(evidenced.stateVersion).toBe(3);
      expect(
        db
          .prepare(
            "select operation_id from group_task_events where task_id = ? and action = 'group_assign_task'",
          )
          .get(assigned.id),
      ).toEqual({ operation_id: "task:assign-owner" });
      expect(
        db
          .prepare(
            "select operation_id from group_task_events where task_id = ? and action = 'group_request_review'",
          )
          .get(assigned.id),
      ).toEqual({ operation_id: "task:request-review" });

      const targetHead = await gitAt(root, ["rev-parse", "HEAD"]);
      const permissionRequests: Array<{ sessionId: string; action: string; target: string }> = [];
      const integration = createGroupIntegrationService({
        requestPermission: async (request) => {
          permissionRequests.push(request);
          return { decision: "allow-once" };
        },
        emitPermissionEvent: () => {},
      });
      const preview = await integration.previewGroupTaskIntegration(assigned.id);
      expect(preview).toMatchObject({
        groupId: group.id,
        taskId: assigned.id,
        sourceBranch: branch,
        targetBranch: "main",
      });
      expect(preview.changedFiles).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "shared.txt" })]),
      );
      const record = await integration.applyGroupTaskIntegration({
        taskId: assigned.id,
        previewId: preview.id,
        confirmedByUser: true,
      });
      expect(record).toMatchObject({
        status: "applied",
        id: expect.any(String),
        mergeHeadSha: preview.sourceSha,
      });
      expect(
        await integration.applyGroupTaskIntegration({
          taskId: assigned.id,
          previewId: preview.id,
          confirmedByUser: true,
        }),
      ).toEqual(record);
      expect(permissionRequests).toEqual([
        expect.objectContaining({ sessionId: memberIds.owner, action: "git.write" }),
      ]);
      expect(await gitAt(root, ["rev-parse", "HEAD"])).toBe(targetHead);
      expect(await gitAt(root, ["rev-parse", "MERGE_HEAD"])).toBe(preview.sourceSha);
      const integrationEvents = db
        .prepare(
          "select integration_id, version from group_integration_events where task_id = ? order by rowid",
        )
        .all(assigned.id) as Array<{ integration_id: string; version: number }>;
      expect(integrationEvents).toEqual([
        { integration_id: record.id, version: 1 },
        { integration_id: record.id, version: 2 },
        { integration_id: record.id, version: 3 },
      ]);
    } finally {
      if (source) {
        await gitAt(root, ["merge", "--abort"]).catch(() => undefined);
        await gitAt(root, ["worktree", "remove", "--force", source]).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("proactive task event workflow", () => {
  it("keeps suggestions pending for explicit acceptance and dispatches opt-in once", async () => {
    for (const mode of ["suggest", "opt_in_auto"] as const) {
      const { db, group, lead, owner } = runtimeSquad();
      if (mode === "opt_in_auto") setGroupProactivityMode(group.id, mode);
      expect(getGroupProactivityMode(group.id)).toBe(mode);
      const env = runtime();
      const root = env.groups.postUserMessage({ groupId: group.id, body: "Work on the task." });
      const task = createGroupTask({
        groupId: group.id,
        title: `Task ${mode}`,
        executionId: root.id,
      });
      const chainBeforeAssignment = env.groups.chainSnapshot(root.id);
      const assigned = assignGroupTask(group.id, task.id, lead, owner).task;
      const transition = listGroupTaskTransitions(task.id).at(-1);
      if (!transition) throw new Error("Task assignment transition was not persisted.");
      await flushRuntime();

      const [action] = listGroupActions(group.id);
      expect(action).toMatchObject({
        groupId: group.id,
        taskId: task.id,
        taskVersion: assigned.stateVersion,
        executionId: root.id,
        sourceEventId: transition.id,
        decision: {
          taskId: task.id,
          sourceEventId: transition.id,
          idempotencyKey: expect.any(String),
        },
      });
      expect(getGroupActionBySource(group.id, transition.id)?.id).toBe(action?.id);
      expect(listGroupActions(group.id)).toHaveLength(1);

      if (mode === "suggest") {
        expect(action?.deliveryState).toBe("suggested");
        expect(env.groups.chainSnapshot(root.id).wakesByMember).toEqual(
          chainBeforeAssignment.wakesByMember,
        );
        expect(
          db.prepare("select count(*) as n from group_jobs where group_id = ?").get(group.id),
        ).toEqual({ n: 1 });
        const suggestion = env.groups
          .listSuggestions(group.id)
          .find((item) => item.actionId === action?.id);
        if (!suggestion) throw new Error("The stored suggestion was not visible.");
        await env.groups.resolveGroupSuggestion({
          actionId: suggestion.actionId,
          decision: "accept",
          expectedVersion: suggestion.version,
          targetSessionId: owner,
        });
        expect(listGroupActions(group.id)).toMatchObject([{ deliveryState: "dispatched" }]);
      } else {
        expect(action).toMatchObject({
          deliveryState: "dispatched",
          decision: { targetSessionId: owner },
        });
        if (!action?.wakeMessageId) throw new Error("Opt-in action has no durable wake message.");
        expect(env.groups.chainSnapshot(root.id).wakesByMember[owner]).toBe(1);
        expect(
          db
            .prepare("select count(*) as n from group_jobs where group_id = ? and session_id = ?")
            .get(group.id, owner),
        ).toEqual({ n: 1 });
        env.groups.handleTaskTransition(transition);
        await flushRuntime();
        expect(listGroupActions(group.id)).toHaveLength(1);
        expect(
          db
            .prepare("select count(*) as n from group_messages where id = ?")
            .get(action.wakeMessageId),
        ).toEqual({ n: 1 });
      }
    }
  });

  it("discards a delayed assignment after Stop or a newer task version supersedes it", async () => {
    for (const interruption of ["stop", "supersede"] as const) {
      const { group, lead, owner, reviewer } = runtimeSquad();
      setGroupProactivityMode(group.id, "opt_in_auto");
      const env = runtime();
      const root = env.groups.postUserMessage({ groupId: group.id, body: "Work on the task." });
      const task = createGroupTask({
        groupId: group.id,
        title: `Task ${interruption}`,
        executionId: root.id,
      });
      let release!: () => void;
      let firstStarted!: () => void;
      let bothStarted!: () => void;
      let lookups = 0;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const firstLookup = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      const secondLookup = new Promise<void>((resolve) => {
        bothStarted = resolve;
      });
      sourceLookup.wait = async () => {
        lookups += 1;
        if (lookups === 1) firstStarted();
        if (lookups === 2) bothStarted();
        await blocked;
      };
      assignGroupTask(group.id, task.id, lead, owner);
      await firstLookup;
      if (interruption === "stop") {
        env.groups.stopGroup(group.id);
        release();
        await flushRuntime();
        expect(listGroupActions(group.id)).toEqual([]);
      } else {
        assignGroupTask(group.id, task.id, lead, reviewer);
        await secondLookup;
        const latestTransition = listGroupTaskTransitions(task.id).at(-1);
        if (!latestTransition) throw new Error("Superseding assignment was not persisted.");
        release();
        await flushRuntime();
        expect(listGroupActions(group.id)).toMatchObject([
          {
            taskVersion: latestTransition.taskVersion,
            sourceEventId: latestTransition.id,
            decision: { targetSessionId: reviewer, sourceEventId: latestTransition.id },
            deliveryState: "dispatched",
          },
        ]);
      }
    }
  });

  it("ignores an individual QA run without an exact task binding", async () => {
    const { group, owner, reviewer } = runtimeSquad();
    const env = runtime();
    const root = env.groups.postUserMessage({ groupId: group.id, body: "Review the task." });
    const task = createGroupTask({
      groupId: group.id,
      title: "Unbound QA",
      status: "in_review",
      ownerSessionId: owner,
      reviewerSessionId: reviewer,
      executionId: root.id,
      kind: "code",
      priority: "normal",
      dependencyIds: [],
      criteria: [{ id: "tests", description: "Tests pass", requiredCheckKinds: ["tests"] }],
      verificationPolicy: { mode: "required", requireReview: true },
    });
    const runId = crypto.randomUUID();
    const event: AgentEvent = {
      type: "harness.qa",
      sessionId: owner,
      runId,
      result: {
        required: true,
        status: "passed",
        reasonCode: "all_passed",
        sourceFingerprint: "unrelated-source",
        evidence: [
          {
            id: "individual-tests",
            kind: "check",
            status: "passed",
            label: "Tests",
            checkName: "tests",
          },
        ],
      },
    };
    const eventCursor = recordAgentEvent(event);
    env.emit({ ...event, eventCursor });
    await flushRuntime();
    expect(listGroupTaskTransitions(task.id)).toEqual([]);
    expect(listGroupActions(group.id)).toEqual([]);
  });
});

describe("stale task evidence and failed persistence", () => {
  it("keeps changed-source evidence from completing a task and invalidates a removed owner's run", async () => {
    const fixture = await sourceTaskFixture();
    try {
      const qaBefore = getHarnessQAEventByRowId(
        fixture.qaRowId,
        fixture.sessions.owner,
        fixture.runId,
      );
      const stateEventCountBefore = (
        fixture.db
          .prepare(
            "select count(*) as n from agent_events where session_id = ? and type like 'harness.task_state%'",
          )
          .get(fixture.sessions.owner) as { n: number }
      ).n;
      await writeFile(join(fixture.root, "source.ts"), "changed after QA\n");
      const response = await runGroupVerifiedTool(
        "group_review_task",
        {
          sessionId: fixture.sessions.reviewer,
          groupId: fixture.group.id,
          toolCallId: "stale-review",
        },
        {
          id: fixture.task.id,
          verdict: "approve",
          approvedCriterionIds: ["tests"],
          expectedVersion: fixture.inReview.stateVersion ?? 1,
          operationId: "review:stale-source",
        },
      );
      expect(response).toMatch(/verification|required/i);
      expect(getGroupTask(fixture.task.id)).toMatchObject({
        status: "in_review",
        ownerSessionId: fixture.sessions.owner,
      });
      expect(
        getHarnessQAEventByRowId(fixture.qaRowId, fixture.sessions.owner, fixture.runId),
      ).toEqual(qaBefore);
      expect(
        (
          fixture.db
            .prepare(
              "select count(*) as n from agent_events where session_id = ? and type like 'harness.task_state%'",
            )
            .get(fixture.sessions.owner) as { n: number }
        ).n,
      ).toBe(stateEventCountBefore);

      removeAgentGroupMember(fixture.group.id, fixture.sessions.reviewer);
      expect(getGroupTask(fixture.task.id)).toMatchObject({
        status: "in_progress",
        ownerSessionId: fixture.sessions.owner,
      });
      expect(getGroupTask(fixture.task.id).reviewerSessionId).toBeUndefined();
      removeAgentGroupMember(fixture.group.id, fixture.sessions.owner);
      const released = getGroupTask(fixture.task.id);
      expect(released).toMatchObject({ status: "open" });
      expect(released.ownerSessionId).toBeUndefined();
      expect(collectGroupTaskRunEvidence(fixture.binding, fixture.qaRowId)).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rolls task state back when persistence of its transition event fails", () => {
    const { db, group, lead, owner } = runtimeSquad();
    const task = createGroupTask({ groupId: group.id, title: "Atomic task" });
    db.exec(`create trigger fail_group_task_event before insert on group_task_events
      begin select raise(abort, 'injected group task storage failure'); end;`);
    try {
      expect(() => assignGroupTask(group.id, task.id, lead, owner)).toThrow(
        /injected group task storage failure/,
      );
      expect(getGroupTask(task.id)).toMatchObject({ status: "open", stateVersion: 1 });
      expect(listGroupTaskTransitions(task.id)).toEqual([]);
    } finally {
      db.exec("drop trigger fail_group_task_event");
    }
  });
});
