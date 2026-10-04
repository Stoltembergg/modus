import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { GroupTask, GroupTaskStatus } from "../../shared/contracts";
import { isCoordinatorModeActive } from "../../shared/group-coordinator";
import { validateGroupTaskDraft } from "../../shared/group-task-policy";
import type {
  BindGroupTaskRunInput,
  GroupTaskCriterion,
  GroupTaskDraft,
  GroupTaskEvidenceInput,
  GroupTaskEvidenceRef,
  GroupTaskProgressInput,
  GroupTaskReview,
  GroupTaskRunBinding,
  GroupTaskTransitionEvent,
  GroupTaskVerificationPolicy,
} from "../../shared/group-work-state";
import { getDatabase } from "../db/database";
import { GroupStoreError, getAgentGroup } from "./group-store";

const TASK_STATUSES: readonly GroupTaskStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "cancelled",
];
const INITIAL_TASK_STATUS: GroupTaskStatus = "open";
const IN_PROGRESS_TASK_STATUS: GroupTaskStatus = "in_progress";
const IN_REVIEW_TASK_STATUS: GroupTaskStatus = "in_review";
const CLOSED_TASK_STATUSES: readonly GroupTaskStatus[] = ["done", "cancelled"];

function requireText(value: string, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new GroupStoreError("invalid-value", `Group ${field} must not be empty.`);
  return text;
}
function requireOneOf<T extends string>(value: T, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value))
    throw new GroupStoreError(
      "invalid-value",
      `Invalid ${field} "${String(value)}". Expected one of: ${allowed.join(", ")}.`,
    );
  return value;
}
function requireGroupRow(groupId: string) {
  const group = getAgentGroup(groupId);
  if (!group) throw new GroupStoreError("group-not-found", `Agent group not found: ${groupId}`);
  return group;
}
function requireMember(groupId: string, sessionId: string, field: string): void {
  if (
    !getDatabase()
      .prepare("select 1 from agent_group_members where group_id = ? and session_id = ?")
      .get(groupId, sessionId)
  ) {
    throw new GroupStoreError(
      "not-a-member",
      `The ${field} session ${sessionId} is not a member of group ${groupId}.`,
    );
  }
}
function requireExecutionInGroup(groupId: string, executionId: string): void {
  const row = getDatabase()
    .prepare("select group_id from group_messages where id = ?")
    .get(executionId) as { group_id: string } | undefined;
  if (!row || row.group_id !== groupId)
    throw new GroupStoreError(
      "message-not-found",
      `Execution ${executionId} is not a message in group ${groupId}.`,
    );
}
function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  return transaction(db, fn);
}

type TaskRow = {
  id: string;
  group_id: string;
  title: string;
  description: string | null;
  status: GroupTaskStatus;
  owner_session_id: string | null;
  created_by_session_id: string | null;
  reviewer_session_id: string | null;
  branch: string | null;
  execution_id: string | null;
  created_at: string;
  updated_at: string;
  kind: string;
  priority: string;
  stage: string | null;
  blocked_reason: string | null;
  dependency_ids_json: string;
  criteria_json: string;
  criteria_version: number;
  verification_policy_json: string;
  evidence_refs_json: string;
  review_json: string | null;
  state_version: number;
};

const TASK_COLUMNS = `id, group_id, title, description, status, owner_session_id,
  created_by_session_id, reviewer_session_id, branch, execution_id, created_at, updated_at,
  kind, priority, stage, blocked_reason, dependency_ids_json, criteria_json, criteria_version,
  verification_policy_json, evidence_refs_json, review_json, state_version`;
const TASK_INSERT_COLUMNS = `id, group_id, title, description, status, owner_session_id,
  created_by_session_id, reviewer_session_id, branch, execution_id, created_at, updated_at`;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseStored<T>(text: string, field: string, valid: (value: unknown) => value is T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GroupStoreError("invalid-value", `Stored task ${field} is not valid JSON.`);
  }
  if (!valid(parsed))
    throw new GroupStoreError("invalid-value", `Stored task ${field} has an invalid shape.`);
  return parsed;
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const criteria = (value: unknown): value is GroupTaskCriterion[] =>
  Array.isArray(value) &&
  value.every((item) => {
    const row = object(item);
    return (
      row &&
      typeof row.id === "string" &&
      row.id.length > 0 &&
      typeof row.description === "string" &&
      row.description.length > 0 &&
      Array.isArray(row.requiredCheckKinds) &&
      row.requiredCheckKinds.every((check: unknown) =>
        ["tests", "typecheck", "lint", "build"].includes(String(check)),
      )
    );
  });
const policy = (value: unknown): value is GroupTaskVerificationPolicy => {
  const row = object(value);
  return (
    !!row &&
    (row.mode === "none" || row.mode === "required") &&
    typeof row.requireReview === "boolean"
  );
};
const evidence = (value: unknown): value is GroupTaskEvidenceRef[] =>
  Array.isArray(value) &&
  value.every((item) => {
    const row = object(item);
    return (
      !!row &&
      typeof row.criterionId === "string" &&
      Number.isSafeInteger(row.criteriaVersion) &&
      typeof row.sessionId === "string" &&
      typeof row.runId === "string" &&
      Number.isSafeInteger(row.eventRowId) &&
      typeof row.evidenceId === "string" &&
      typeof row.sourceFingerprint === "string"
    );
  });
const review = (value: unknown): value is GroupTaskReview => {
  const row = object(value);
  return (
    !!row &&
    typeof row.reviewerSessionId === "string" &&
    (row.verdict === "approve" || row.verdict === "changes") &&
    Number.isSafeInteger(row.criteriaVersion) &&
    typeof row.sourceFingerprint === "string" &&
    typeof row.eventId === "string" &&
    strings(row.approvedCriterionIds)
  );
};

function toTask(row: TaskRow): GroupTask {
  return {
    id: row.id,
    groupId: row.group_id,
    title: row.title,
    ...(row.description !== null ? { description: row.description } : {}),
    status: row.status,
    kind: row.kind as NonNullable<GroupTask["kind"]>,
    priority: row.priority as NonNullable<GroupTask["priority"]>,
    ...(row.stage !== null ? { stage: row.stage as NonNullable<GroupTask["stage"]> } : {}),
    ...(row.blocked_reason !== null ? { blockedReason: row.blocked_reason } : {}),
    dependencyIds: parseStored(row.dependency_ids_json, "dependencies", strings),
    criteria: parseStored(row.criteria_json, "criteria", criteria),
    criteriaVersion: row.criteria_version,
    verificationPolicy: parseStored(row.verification_policy_json, "verification policy", policy),
    evidenceRefs: parseStored(row.evidence_refs_json, "evidence", evidence),
    ...(row.review_json !== null ? { review: parseStored(row.review_json, "review", review) } : {}),
    stateVersion: row.state_version,
    ...(row.owner_session_id !== null ? { ownerSessionId: row.owner_session_id } : {}),
    ...(row.created_by_session_id !== null
      ? { createdBySessionId: row.created_by_session_id }
      : {}),
    ...(row.reviewer_session_id !== null ? { reviewerSessionId: row.reviewer_session_id } : {}),
    ...(row.branch !== null ? { branch: row.branch } : {}),
    ...(row.execution_id !== null ? { executionId: row.execution_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const RUN_COLUMNS = `group_id, task_id, task_version, criteria_version, session_id,
  run_id, execution_id, role, source_fingerprint`;
type RunRow = {
  group_id: string;
  task_id: string;
  task_version: number;
  criteria_version: number;
  session_id: string;
  run_id: string;
  execution_id: string;
  role: "owner" | "reviewer";
  source_fingerprint: string;
};
type EventRow = {
  id: string;
  group_id: string;
  task_id: string;
  task_version: number;
  action: string;
  actor_session_id: string | null;
  source_event_id: string | null;
  execution_id: string | null;
  from_status: GroupTaskStatus;
  to_status: GroupTaskStatus;
  created_at: string;
};

function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("begin immediate");
  try {
    const result = run();
    db.exec("commit");
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function requireGroupTask(groupId: string, taskId: string): GroupTask {
  const task = listGroupTasks(groupId).find((item) => item.id === taskId);
  if (!task) throw new GroupStoreError("task-not-found", `Group task not found: ${taskId}`);
  return task;
}

function requireVersion(task: GroupTask, expectedVersion: number): void {
  if (!Number.isSafeInteger(expectedVersion) || task.stateVersion !== expectedVersion) {
    throw new GroupStoreError(
      "stale-task",
      `Task ${task.id} changed since version ${expectedVersion}.`,
    );
  }
}

function requireActor(task: GroupTask, actorSessionId: string, role: "owner" | "reviewer"): void {
  const authorized = role === "owner" ? task.ownerSessionId : task.reviewerSessionId;
  if (
    authorized !== actorSessionId ||
    !getDatabase()
      .prepare("select 1 from agent_group_members where group_id = ? and session_id = ?")
      .get(task.groupId, actorSessionId)
  ) {
    throw new GroupStoreError(
      role === "owner" ? "not-owner" : "not-reviewer",
      `Only the active ${role} may change task ${task.id}.`,
    );
  }
}

function requireOperationId(operationId: string): void {
  if (typeof operationId !== "string" || !operationId.trim()) {
    throw new GroupStoreError("invalid-value", "Task operationId must not be empty.");
  }
}

function rejectRunOperationCollision(db: DatabaseSync, operationId: string): void {
  if (db.prepare("select 1 from group_task_runs where operation_id = ?").get(operationId)) {
    throw new GroupStoreError(
      "invalid-value",
      `operationId ${operationId} is already bound to a run.`,
    );
  }
}

function rejectEventOperationCollision(db: DatabaseSync, operationId: string): void {
  if (db.prepare("select 1 from group_task_events where operation_id = ?").get(operationId)) {
    throw new GroupStoreError(
      "invalid-value",
      `operationId ${operationId} is already bound to a task event.`,
    );
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const row = object(value);
  if (!row) return value;
  return Object.fromEntries(
    Object.keys(row)
      .sort()
      .filter((key) => row[key] !== undefined)
      .map((key) => [key, canonical(row[key])]),
  );
}

function getReplay<T>(
  db: DatabaseSync,
  operationId: string,
  action: string,
  input: unknown,
): T | undefined {
  const row = db
    .prepare("select action, result_json from group_task_events where operation_id = ?")
    .get(operationId) as { action: string; result_json: string | null } | undefined;
  if (!row) return undefined;
  const saved = JSON.parse(row.result_json ?? "null") as { input: unknown; result: T } | null;
  if (
    row.action !== action ||
    JSON.stringify(canonical(saved?.input)) !== JSON.stringify(canonical(input))
  ) {
    throw new GroupStoreError(
      "invalid-value",
      `operationId ${operationId} was used for a different task operation.`,
    );
  }
  return saved?.result;
}

function recordEvent(
  db: DatabaseSync,
  task: GroupTask,
  action: string,
  next: GroupTask,
  actorSessionId?: string,
  operationId?: string,
  input?: unknown,
): void {
  db.prepare(`insert into group_task_events
    (id, group_id, task_id, task_version, action, actor_session_id, execution_id,
     from_status, to_status, operation_id, result_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    randomUUID(),
    task.groupId,
    task.id,
    next.stateVersion ?? 1,
    action,
    actorSessionId ?? null,
    task.executionId ?? null,
    task.status,
    next.status,
    operationId ?? null,
    operationId ? JSON.stringify({ input: canonical(input), result: next }) : null,
    new Date().toISOString(),
  );
}

/** Called within the existing group-store transaction after a legacy task mutation. */
export function recordGroupTaskLegacyTransition(
  task: GroupTask,
  action: string,
  actorSessionId?: string,
): void {
  const db = getDatabase();
  db.prepare("update group_tasks set state_version = state_version + 1 where id = ?").run(task.id);
  const next = requireGroupTask(task.groupId, task.id);
  recordEvent(db, task, action, next, actorSessionId);
}

export function reportGroupTaskProgress(input: GroupTaskProgressInput): GroupTask {
  const db = getDatabase();
  return transaction(db, () => {
    requireOperationId(input.operationId);
    const replay = getReplay<GroupTask>(db, input.operationId, "progress", input);
    if (replay) return replay;
    rejectRunOperationCollision(db, input.operationId);
    const task = requireGroupTask(input.groupId, input.taskId);
    requireVersion(task, input.expectedVersion);
    requireActor(
      task,
      input.actorSessionId,
      input.stage === "review" && task.status === "in_review" ? "reviewer" : "owner",
    );
    if (task.status === "done" || task.status === "cancelled") {
      throw new GroupStoreError("invalid-transition", `Task ${task.id} is closed.`);
    }
    const stages = ["plan", "implement", "verify", "review", "deliver"];
    if (input.stage !== undefined && !stages.includes(input.stage)) {
      throw new GroupStoreError("invalid-value", "Invalid task stage.");
    }
    let status = task.status;
    let reason = task.blockedReason ?? null;
    if (input.blockedReason !== undefined) {
      if (input.blockedReason === null) {
        if (status !== "blocked")
          throw new GroupStoreError("invalid-transition", "Task is not blocked.");
        status = "in_progress";
        reason = null;
      } else {
        reason = input.blockedReason.trim();
        if (!reason) throw new GroupStoreError("invalid-value", "Block reason must not be empty.");
        if (status !== "in_progress" && status !== "blocked") {
          throw new GroupStoreError("invalid-transition", "Only active work may be blocked.");
        }
        status = "blocked";
      }
    }
    db.prepare(`update group_tasks set status = ?, stage = ?, blocked_reason = ?,
      state_version = state_version + 1, updated_at = ? where id = ?`).run(
      status,
      input.stage ?? task.stage ?? null,
      reason,
      new Date().toISOString(),
      task.id,
    );
    const next = requireGroupTask(input.groupId, task.id);
    recordEvent(db, task, "progress", next, input.actorSessionId, input.operationId, input);
    return next;
  });
}

function validateEvidenceRefs(task: GroupTask, refs: GroupTaskEvidenceRef[]): void {
  if (!Array.isArray(refs))
    throw new GroupStoreError("invalid-value", "Evidence refs must be an array.");
  const ids = new Set(task.criteria?.map((criterion) => criterion.id) ?? []);
  for (const ref of refs) {
    if (
      !ref ||
      !ids.has(ref.criterionId) ||
      ref.criteriaVersion !== task.criteriaVersion ||
      !Number.isSafeInteger(ref.eventRowId) ||
      ref.eventRowId < 1 ||
      !ref.sessionId ||
      !ref.runId ||
      !ref.evidenceId ||
      !ref.sourceFingerprint
    ) {
      throw new GroupStoreError(
        "stale-evidence",
        "Evidence reference is outside this task's criteria.",
      );
    }
    const binding = getGroupTaskRunBinding(ref.sessionId, ref.runId);
    if (
      !binding ||
      binding.taskId !== task.id ||
      binding.groupId !== task.groupId ||
      binding.criteriaVersion !== task.criteriaVersion ||
      binding.sourceFingerprint !== ref.sourceFingerprint
    ) {
      throw new GroupStoreError("stale-evidence", "Evidence reference has no matching task run.");
    }
  }
}

export function recordGroupTaskEvidence(input: GroupTaskEvidenceInput): GroupTask {
  const db = getDatabase();
  return transaction(db, () => {
    requireOperationId(input.operationId);
    const replay = getReplay<GroupTask>(db, input.operationId, "evidence", input);
    if (replay) return replay;
    rejectRunOperationCollision(db, input.operationId);
    const task = requireGroupTask(input.groupId, input.taskId);
    requireVersion(task, input.expectedVersion);
    requireActor(
      task,
      input.actorSessionId,
      task.status === "in_review" && task.reviewerSessionId === input.actorSessionId
        ? "reviewer"
        : "owner",
    );
    if (task.status === "done" || task.status === "cancelled") {
      throw new GroupStoreError("invalid-transition", `Task ${task.id} is closed.`);
    }
    validateEvidenceRefs(task, input.evidenceRefs);
    db.prepare(
      "update group_tasks set evidence_refs_json = ?, state_version = state_version + 1, updated_at = ? where id = ?",
    ).run(JSON.stringify(input.evidenceRefs), new Date().toISOString(), task.id);
    const next = requireGroupTask(input.groupId, task.id);
    recordEvent(db, task, "evidence", next, input.actorSessionId, input.operationId, input);
    return next;
  });
}

function toRun(row: RunRow): GroupTaskRunBinding {
  return {
    groupId: row.group_id,
    taskId: row.task_id,
    taskVersion: row.task_version,
    criteriaVersion: row.criteria_version,
    sessionId: row.session_id,
    runId: row.run_id,
    executionId: row.execution_id,
    role: row.role,
    sourceFingerprint: row.source_fingerprint,
  };
}

function sameBinding(a: GroupTaskRunBinding, b: GroupTaskRunBinding): boolean {
  return (
    a.groupId === b.groupId &&
    a.taskId === b.taskId &&
    a.taskVersion === b.taskVersion &&
    a.criteriaVersion === b.criteriaVersion &&
    a.sessionId === b.sessionId &&
    a.runId === b.runId &&
    a.executionId === b.executionId &&
    a.role === b.role &&
    a.sourceFingerprint === b.sourceFingerprint
  );
}

export function getGroupTaskRunBinding(
  sessionId: string,
  runId: string,
): GroupTaskRunBinding | undefined {
  const row = getDatabase()
    .prepare(`select ${RUN_COLUMNS} from group_task_runs where session_id = ? and run_id = ?`)
    .get(sessionId, runId) as RunRow | undefined;
  return row ? toRun(row) : undefined;
}

export function bindGroupTaskRun(input: BindGroupTaskRunInput): void {
  const db = getDatabase();
  transaction(db, () => {
    requireOperationId(input.operationId);
    rejectEventOperationCollision(db, input.operationId);
    const { operationId, expectedVersion, ...binding } = input;
    const previousOperation = db
      .prepare(`select ${RUN_COLUMNS} from group_task_runs where operation_id = ?`)
      .get(operationId) as RunRow | undefined;
    if (previousOperation) {
      if (sameBinding(toRun(previousOperation), binding)) return;
      throw new GroupStoreError(
        "invalid-value",
        `operationId ${operationId} was used for another run.`,
      );
    }
    const existing = getGroupTaskRunBinding(input.sessionId, input.runId);
    if (existing) {
      throw new GroupStoreError(
        "invalid-value",
        `Run ${input.runId} is already bound by another operation.`,
      );
    }
    const task = requireGroupTask(input.groupId, input.taskId);
    requireVersion(task, expectedVersion);
    if (task.stateVersion !== input.taskVersion || task.criteriaVersion !== input.criteriaVersion) {
      throw new GroupStoreError("stale-task", `Run version does not match task ${task.id}.`);
    }
    if (input.role !== "owner" && input.role !== "reviewer") {
      throw new GroupStoreError("invalid-value", "Invalid run role.");
    }
    requireActor(task, input.sessionId, input.role);
    if (!input.runId || !input.executionId || !input.sourceFingerprint) {
      throw new GroupStoreError("invalid-value", "Run identity and fingerprint are required.");
    }
    db.prepare(`insert into group_task_runs (${RUN_COLUMNS}, operation_id)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.groupId,
      input.taskId,
      input.taskVersion,
      input.criteriaVersion,
      input.sessionId,
      input.runId,
      input.executionId,
      input.role,
      input.sourceFingerprint,
      input.operationId,
    );
  });
}

export function listGroupTaskTransitions(taskId: string): GroupTaskTransitionEvent[] {
  const rows = getDatabase()
    .prepare(`select id, group_id, task_id, task_version, action,
    actor_session_id, source_event_id, execution_id, from_status, to_status, created_at
    from group_task_events where task_id = ? order by task_version, created_at, id`)
    .all(taskId) as EventRow[];
  return rows.map((row) => ({
    id: row.id,
    groupId: row.group_id,
    taskId: row.task_id,
    taskVersion: row.task_version,
    action: row.action,
    ...(row.actor_session_id ? { actorSessionId: row.actor_session_id } : {}),
    ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}),
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    fromStatus: row.from_status,
    toStatus: row.to_status,
    createdAt: row.created_at,
  }));
}

/* ── Tasks ─────────────────────────────────────────────────────────────── */

export function createGroupTask(input: {
  id?: string;
  groupId: string;
  title: string;
  description?: string;
  status?: GroupTaskStatus;
  ownerSessionId?: string;
  createdBySessionId?: string;
  reviewerSessionId?: string;
  branch?: string;
  /** Ask-spanning execution id (message chain root). */
  executionId?: string;
  kind?: GroupTaskDraft["kind"];
  priority?: GroupTaskDraft["priority"];
  dependencyIds?: GroupTaskDraft["dependencyIds"];
  criteria?: GroupTaskDraft["criteria"];
  verificationPolicy?: GroupTaskDraft["verificationPolicy"];
  stage?: GroupTask["stage"];
}): GroupTask {
  const db = getDatabase();
  requireGroupRow(input.groupId);
  const title = requireText(input.title, "task title");
  const status = requireOneOf(input.status ?? "open", TASK_STATUSES, "task status");
  if (input.ownerSessionId) requireMember(input.groupId, input.ownerSessionId, "owner");
  if (input.createdBySessionId) {
    requireMember(input.groupId, input.createdBySessionId, "task creator");
  }
  if (input.reviewerSessionId) requireMember(input.groupId, input.reviewerSessionId, "reviewer");
  if (input.executionId) requireExecutionInGroup(input.groupId, input.executionId);
  const structured =
    input.kind !== undefined ||
    input.priority !== undefined ||
    input.dependencyIds !== undefined ||
    input.criteria !== undefined ||
    input.verificationPolicy !== undefined;
  if (structured) {
    if (
      !input.kind ||
      !input.priority ||
      !input.dependencyIds ||
      !input.criteria ||
      !input.verificationPolicy
    ) {
      throw new GroupStoreError(
        "invalid-value",
        "Structured tasks require kind, priority, dependencies, criteria and verification policy.",
      );
    }
    if (!policy(input.verificationPolicy)) {
      throw new GroupStoreError("invalid-value", "Invalid task verification policy.");
    }
    const result = validateGroupTaskDraft(
      {
        groupId: input.groupId,
        title,
        kind: input.kind,
        priority: input.priority,
        dependencyIds: input.dependencyIds,
        criteria: input.criteria,
        verificationPolicy: input.verificationPolicy,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.reviewerSessionId !== undefined
          ? { reviewerSessionId: input.reviewerSessionId }
          : {}),
      },
      listGroupTasks(input.groupId),
    );
    if (result.issues.length) {
      const issue = result.issues[0];
      throw new GroupStoreError(
        issue?.code === "dependency-cycle"
          ? "dependency-cycle"
          : issue?.code === "invalid-dependency"
            ? "invalid-dependency"
            : "invalid-value",
        issue?.message ?? "Invalid task draft.",
      );
    }
  }
  if (
    input.stage !== undefined &&
    !["plan", "implement", "verify", "review", "deliver"].includes(input.stage)
  ) {
    throw new GroupStoreError("invalid-value", "Invalid task stage.");
  }
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `insert into group_tasks (${TASK_INSERT_COLUMNS}, kind, priority, dependency_ids_json,
      criteria_json, verification_policy_json, stage)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.groupId,
    title,
    input.description ?? null,
    status,
    input.ownerSessionId ?? null,
    input.createdBySessionId ?? null,
    input.reviewerSessionId ?? null,
    input.branch ?? null,
    input.executionId ?? null,
    now,
    now,
    input.kind ?? "legacy",
    input.priority ?? "normal",
    JSON.stringify(input.dependencyIds ?? []),
    JSON.stringify(input.criteria ?? []),
    JSON.stringify(input.verificationPolicy ?? { mode: "none", requireReview: false }),
    input.stage ?? null,
  );
  return requireTask(id);
}

function requireTask(taskId: string): GroupTask {
  const row = getDatabase()
    .prepare(`select ${TASK_COLUMNS} from group_tasks where id = ?`)
    .get(taskId) as TaskRow | undefined;
  if (!row) {
    throw new GroupStoreError("task-not-found", `Group task not found: ${taskId}`);
  }
  return toTask(row);
}

/**
 * Patches a task. `null` clears owner / reviewer / branch; omitted fields are
 * left unchanged. New owners and reviewers must be group members.
 */
export function updateGroupTask(
  taskId: string,
  patch: {
    status?: GroupTaskStatus;
    ownerSessionId?: string | null;
    reviewerSessionId?: string | null;
    branch?: string | null;
  },
): GroupTask {
  const current = requireTask(taskId);
  const sets: string[] = [];
  const params: Array<string | null> = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(requireOneOf(patch.status, TASK_STATUSES, "task status"));
  }
  if (patch.ownerSessionId !== undefined) {
    if (patch.ownerSessionId !== null) {
      requireMember(current.groupId, patch.ownerSessionId, "owner");
    }
    sets.push("owner_session_id = ?");
    params.push(patch.ownerSessionId);
  }
  if (patch.reviewerSessionId !== undefined) {
    if (patch.reviewerSessionId !== null) {
      requireMember(current.groupId, patch.reviewerSessionId, "reviewer");
    }
    sets.push("reviewer_session_id = ?");
    params.push(patch.reviewerSessionId);
  }
  if (patch.branch !== undefined) {
    sets.push("branch = ?");
    params.push(patch.branch);
  }
  if (sets.length === 0) {
    return current;
  }
  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  return inTransaction(getDatabase(), () => {
    getDatabase()
      .prepare(`update group_tasks set ${sets.join(", ")} where id = ?`)
      .run(...params, taskId);
    recordGroupTaskLegacyTransition(current, "update");
    return requireTask(taskId);
  });
}

export function listGroupTasks(
  groupId: string,
  options: { status?: GroupTaskStatus } = {},
): GroupTask[] {
  const db = getDatabase();
  const rows =
    options.status === undefined
      ? (db
          .prepare(
            `select ${TASK_COLUMNS} from group_tasks where group_id = ?
             order by created_at, rowid`,
          )
          .all(groupId) as TaskRow[])
      : (db
          .prepare(
            `select ${TASK_COLUMNS} from group_tasks where group_id = ? and status = ?
             order by created_at, rowid`,
          )
          .all(groupId, requireOneOf(options.status, TASK_STATUSES, "task status")) as TaskRow[]);
  return rows.map(toTask);
}

/**
 * The user cancels a task from the room's task panel: the only path to
 * `cancelled` (member tools never reach it). Open, in progress and in review
 * tasks cancel; a done task is refused (`invalid-transition`); an already
 * cancelled one is returned unchanged.
 */
export function cancelGroupTask(taskId: string): GroupTask {
  const task = requireTask(taskId);
  if (task.status === "cancelled") return task;
  if (task.status === "done") {
    throw new GroupStoreError("invalid-transition", `Cannot cancel task ${task.id}: it is done.`);
  }
  return updateGroupTask(taskId, { status: "cancelled" });
}

/* ── Member task transitions (the rules the member tools rely on) ───────── */
/*
 * open ──claim──▶ in_progress ──request review──▶ in_review ──approve──▶ done
 *   ▲                │   ▲                            │
 *   └────release─────┘   └──────────changes───────────┘
 *
 * `cancelled` is not reachable here (only through updateGroupTask). A member
 * leaving reuses detachMemberRows: owner leaves → open with no owner; reviewer
 * leaves during in_review → in_progress.
 */

function requireTaskInGroup(taskId: string, groupId: string): GroupTask {
  const task = requireTask(taskId);
  if (task.groupId !== groupId) {
    throw new GroupStoreError("task-not-found", `Group task not found: ${taskId}`);
  }
  return task;
}

/**
 * The status the rules act on, per the reading convention on
 * removeAgentGroupMember: a non-closed task with no owner counts as `open`
 * (e.g. its owner's session was deleted and the FK nulled the owner).
 */
function effectiveTaskStatus(task: GroupTask): GroupTaskStatus {
  if (CLOSED_TASK_STATUSES.includes(task.status)) return task.status;
  return task.ownerSessionId ? task.status : INITIAL_TASK_STATUS;
}

function invalidTransition(task: GroupTask, action: string): GroupStoreError {
  return new GroupStoreError(
    "invalid-transition",
    `Cannot ${action} task ${task.id}: it is ${effectiveTaskStatus(task)}.`,
  );
}

function writeTaskTransition(
  taskId: string,
  fields: {
    status: GroupTaskStatus;
    owner?: string | null;
    reviewer?: string | null;
    branch?: string;
  },
  action: string,
  actorSessionId: string,
): GroupTask {
  const current = requireTask(taskId);
  const sets = ["status = ?"];
  const params: Array<string | null> = [fields.status];
  if (fields.owner !== undefined) {
    sets.push("owner_session_id = ?");
    params.push(fields.owner);
  }
  if (fields.reviewer !== undefined) {
    sets.push("reviewer_session_id = ?");
    params.push(fields.reviewer);
  }
  if (fields.branch !== undefined) {
    // Fills a missing branch only; an existing value is never overwritten.
    sets.push("branch = coalesce(branch, ?)");
    params.push(fields.branch);
  }
  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  getDatabase()
    .prepare(`update group_tasks set ${sets.join(", ")} where id = ?`)
    .run(...params, taskId);
  recordGroupTaskLegacyTransition(current, action, actorSessionId);
  return requireTask(taskId);
}

/** Any member creates a task; it starts `open` with no owner. */
export function createMemberGroupTask(input: {
  groupId: string;
  actorSessionId: string;
  title: string;
  description?: string;
  reviewerSessionId?: string;
  executionId?: string;
}): GroupTask {
  requireGroupRow(input.groupId);
  requireMember(input.groupId, input.actorSessionId, "task creator");
  return createGroupTask({
    groupId: input.groupId,
    title: input.title,
    status: INITIAL_TASK_STATUS,
    createdBySessionId: input.actorSessionId,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.reviewerSessionId ? { reviewerSessionId: input.reviewerSessionId } : {}),
    ...(input.executionId ? { executionId: input.executionId } : {}),
  });
}

/**
 * Claim an unowned `open` task: the caller becomes owner, status `in_progress`.
 * A suggested reviewer may claim it; the claim then clears the reviewer in the
 * same update (an owner never reviews their own task). `options.branch` (the
 * claimer's member worktree branch) fills the task's branch when it has none.
 */
export function claimGroupTask(
  groupId: string,
  taskId: string,
  actorSessionId: string,
  options: { branch?: string } = {},
): GroupTask {
  const db = getDatabase();
  return inTransaction(db, () => {
    requireMember(groupId, actorSessionId, "claimer");
    const task = requireTaskInGroup(taskId, groupId);
    if (task.ownerSessionId) {
      throw new GroupStoreError("task-taken", `Task ${taskId} is already owned.`);
    }
    if (effectiveTaskStatus(task) !== INITIAL_TASK_STATUS) throw invalidTransition(task, "claim");
    return writeTaskTransition(
      taskId,
      {
        status: IN_PROGRESS_TASK_STATUS,
        owner: actorSessionId,
        ...(task.reviewerSessionId === actorSessionId ? { reviewer: null } : {}),
        ...(options.branch ? { branch: options.branch } : {}),
      },
      "claim",
      actorSessionId,
    );
  });
}

/**
 * Coordinator mode (PR 7): the Lead hands a task to a member (itself included).
 * `open` → `in_progress` with the assignee; `in_progress` with another owner is
 * a reassignment (returns the previous owner; the branch is kept on purpose, as
 * the record of where the earlier work is); in_review / done / cancelled
 * (and the current owner again) are invalid-transition. Only while the mode is
 * in effect (coordinator-off) and only by the Lead (not-coordinator).
 */
export function assignGroupTask(
  groupId: string,
  taskId: string,
  actorSessionId: string,
  assigneeSessionId: string,
  options: { branch?: string } = {},
): { task: GroupTask; previousOwnerSessionId?: string } {
  const db = getDatabase();
  return inTransaction(db, () => {
    const group = requireGroupRow(groupId);
    if (!isCoordinatorModeActive(group)) {
      throw new GroupStoreError(
        "coordinator-off",
        `Coordinator mode is not in effect in group ${groupId} (it needs the mode on and a Lead).`,
      );
    }
    if (group.leadSessionId !== actorSessionId) {
      throw new GroupStoreError("not-coordinator", "Only the group's Lead assigns tasks.");
    }
    requireMember(groupId, assigneeSessionId, "assignee");
    const task = requireTaskInGroup(taskId, groupId);
    const status = effectiveTaskStatus(task);
    const reviewer = task.reviewerSessionId === assigneeSessionId ? { reviewer: null } : {};
    if (status === INITIAL_TASK_STATUS) {
      return {
        task: writeTaskTransition(
          taskId,
          {
            status: IN_PROGRESS_TASK_STATUS,
            owner: assigneeSessionId,
            ...reviewer,
            ...(options.branch ? { branch: options.branch } : {}),
          },
          "assign",
          actorSessionId,
        ),
      };
    }
    if (
      status !== IN_PROGRESS_TASK_STATUS ||
      !task.ownerSessionId ||
      task.ownerSessionId === assigneeSessionId
    ) {
      throw invalidTransition(task, "assign");
    }
    return {
      task: writeTaskTransition(
        taskId,
        {
          status: IN_PROGRESS_TASK_STATUS,
          owner: assigneeSessionId,
          ...reviewer,
        },
        "assign",
        actorSessionId,
      ),
      previousOwnerSessionId: task.ownerSessionId,
    };
  });
}

/**
 * Sets `branch` on the member's `in_progress` tasks that have none (never
 * overwrites). Returns the updated tasks.
 */
export function fillMemberTaskBranches(
  groupId: string,
  sessionId: string,
  branch: string,
): GroupTask[] {
  const db = getDatabase();
  return inTransaction(db, () => {
    const rows = db
      .prepare(
        `select id from group_tasks
         where group_id = ? and owner_session_id = ? and status = ? and branch is null`,
      )
      .all(groupId, sessionId, IN_PROGRESS_TASK_STATUS) as Array<{ id: string }>;
    const now = new Date().toISOString();
    const update = db.prepare(
      "update group_tasks set branch = ?, updated_at = ? where id = ? and branch is null",
    );
    for (const row of rows) update.run(branch, now, row.id);
    for (const row of rows) {
      // Branch changes are task state changes even though status stays in progress.
      // The pre-update DTO is reconstructed with the preceding version.
      const current = requireTask(row.id);
      recordGroupTaskLegacyTransition(current, "branch_filled", sessionId);
    }
    return rows.map((row) => requireTask(row.id));
  });
}

/** The owner gives an `in_progress` task back: `open`, no owner. */
export function releaseGroupTask(
  groupId: string,
  taskId: string,
  actorSessionId: string,
): GroupTask {
  const db = getDatabase();
  return inTransaction(db, () => {
    const task = requireTaskInGroup(taskId, groupId);
    if (task.ownerSessionId !== actorSessionId) {
      throw new GroupStoreError("not-owner", `Only the owner can release task ${taskId}.`);
    }
    if (task.status !== IN_PROGRESS_TASK_STATUS) throw invalidTransition(task, "release");
    return writeTaskTransition(
      taskId,
      { status: INITIAL_TASK_STATUS, owner: null },
      "release",
      actorSessionId,
    );
  });
}

/** The owner asks another member to review an `in_progress` task: `in_review`. */
export function requestGroupTaskReview(
  groupId: string,
  taskId: string,
  actorSessionId: string,
  reviewerSessionId: string,
): GroupTask {
  const db = getDatabase();
  return inTransaction(db, () => {
    const task = requireTaskInGroup(taskId, groupId);
    if (task.ownerSessionId !== actorSessionId) {
      throw new GroupStoreError("not-owner", `Only the owner can request review of ${taskId}.`);
    }
    if (reviewerSessionId === actorSessionId) {
      throw new GroupStoreError("self-review", `The owner cannot review task ${taskId}.`);
    }
    requireMember(groupId, reviewerSessionId, "reviewer");
    if (task.status !== IN_PROGRESS_TASK_STATUS) throw invalidTransition(task, "request review of");
    return writeTaskTransition(
      taskId,
      {
        status: IN_REVIEW_TASK_STATUS,
        reviewer: reviewerSessionId,
      },
      "request_review",
      actorSessionId,
    );
  });
}

export type GroupTaskReviewVerdict = "approve" | "changes";

/**
 * The reviewer decides an `in_review` task: approve → `done` (the schema has no
 * `closed`), changes → `in_progress`. Review rights exist only while the review
 * is pending: anyone else, or the recorded reviewer of a task that is no
 * longer in review (e.g. its owner left, so it went back to `open`), gets
 * `not-reviewer`; a closed task gets `invalid-transition`.
 */
export function reviewGroupTask(
  groupId: string,
  taskId: string,
  actorSessionId: string,
  verdict: GroupTaskReviewVerdict,
): GroupTask {
  const db = getDatabase();
  return inTransaction(db, () => {
    const task = requireTaskInGroup(taskId, groupId);
    const next = requireOneOf(verdict, ["approve", "changes"], "review verdict");
    const status = effectiveTaskStatus(task);
    if (CLOSED_TASK_STATUSES.includes(status)) throw invalidTransition(task, "review");
    if (status !== IN_REVIEW_TASK_STATUS || task.reviewerSessionId !== actorSessionId) {
      throw new GroupStoreError(
        "not-reviewer",
        `Only the reviewer of a pending review can review task ${taskId}.`,
      );
    }
    return writeTaskTransition(
      taskId,
      {
        status: next === "approve" ? "done" : IN_PROGRESS_TASK_STATUS,
      },
      "review",
      actorSessionId,
    );
  });
}

/**
 * P1b agreement loop: any member may mark an active task done when the room
 * reaches Agree (owner/reviewer formal review is still available via
 * group_review_task). Cancelled/done tasks are rejected.
 */
export function completeGroupTaskForAgreement(
  groupId: string,
  taskId: string,
  actorSessionId: string,
): GroupTask {
  const db = getDatabase();
  return inTransaction(db, () => {
    requireMember(groupId, actorSessionId, "agreement actor");
    const task = requireTaskInGroup(taskId, groupId);
    const status = effectiveTaskStatus(task);
    if (CLOSED_TASK_STATUSES.includes(status))
      throw invalidTransition(task, "complete by agreement");
    return writeTaskTransition(taskId, { status: "done" }, "agreement", actorSessionId);
  });
}
