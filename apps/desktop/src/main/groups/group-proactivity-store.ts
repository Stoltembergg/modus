import { randomUUID } from "node:crypto";
import type { GroupProactivityDecision, GroupProactivityMode } from "../../shared/group-work-state";
import { getDatabase } from "../db/database";
import { GroupStoreError } from "./group-store";

export type GroupActionRecord = {
  id: string;
  groupId: string;
  taskId: string;
  taskVersion: number;
  executionId?: string;
  sourceEventId: string;
  decision: GroupProactivityDecision;
  deliveryState: "suggested" | "pending" | "dispatched" | "discarded" | "invalidated";
  wakeMessageId?: string;
  jobId?: string;
  resolutionTargetSessionId?: string;
  resolvedExecutionId?: string;
  requiresNewExecution: boolean;
  version: number;
};

type ActionRow = {
  id: string;
  idempotency_key: string;
  group_id: string;
  task_id: string;
  task_version: number;
  execution_id: string | null;
  source_event_id: string;
  decision_json: string;
  delivery_state: GroupActionRecord["deliveryState"];
  wake_message_id: string | null;
  job_id: string | null;
  resolution_target_session_id: string | null;
  resolved_execution_id: string | null;
  requires_new_execution: number;
  version: number;
};

function toAction(row: ActionRow): GroupActionRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    taskId: row.task_id,
    taskVersion: row.task_version,
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    sourceEventId: row.source_event_id,
    decision: JSON.parse(row.decision_json) as GroupProactivityDecision,
    deliveryState: row.delivery_state,
    ...(row.wake_message_id ? { wakeMessageId: row.wake_message_id } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    ...(row.resolution_target_session_id
      ? { resolutionTargetSessionId: row.resolution_target_session_id }
      : {}),
    ...(row.resolved_execution_id ? { resolvedExecutionId: row.resolved_execution_id } : {}),
    requiresNewExecution: row.requires_new_execution === 1,
    version: row.version,
  };
}

function requireAction(id: string): GroupActionRecord {
  const action = getGroupAction(id);
  if (!action) throw new GroupStoreError("invalid-value", "Action could not be read after update.");
  return action;
}

export function getGroupProactivityMode(groupId: string): GroupProactivityMode {
  const row = getDatabase()
    .prepare("select proactivity_mode from agent_groups where id = ?")
    .get(groupId) as { proactivity_mode: GroupProactivityMode } | undefined;
  if (!row) throw new GroupStoreError("group-not-found", `Unknown group ${groupId}.`);
  return row.proactivity_mode;
}

/** Main-process setting; the renderer control is supplied in Task 8. */
export function setGroupProactivityMode(groupId: string, mode: GroupProactivityMode): void {
  if (mode !== "suggest" && mode !== "opt_in_auto")
    throw new GroupStoreError("invalid-value", "Invalid proactivity mode.");
  const changed = getDatabase()
    .prepare("update agent_groups set proactivity_mode = ? where id = ?")
    .run(mode, groupId);
  if (!changed.changes) throw new GroupStoreError("group-not-found", `Unknown group ${groupId}.`);
}

export function getGroupAction(id: string): GroupActionRecord | undefined {
  const row = getDatabase()
    .prepare("select * from group_proactivity_actions where id = ?")
    .get(id) as ActionRow | undefined;
  return row ? toAction(row) : undefined;
}

export function getGroupActionBySource(
  groupId: string,
  sourceEventId: string,
): GroupActionRecord | undefined {
  const row = getDatabase()
    .prepare("select * from group_proactivity_actions where group_id = ? and source_event_id = ?")
    .get(groupId, sourceEventId) as ActionRow | undefined;
  return row ? toAction(row) : undefined;
}

export function getGroupActionByJobId(jobId: string): GroupActionRecord | undefined {
  const row = getDatabase()
    .prepare("select * from group_proactivity_actions where job_id = ?")
    .get(jobId) as ActionRow | undefined;
  return row ? toAction(row) : undefined;
}

export function listGroupActions(groupId?: string): GroupActionRecord[] {
  const rows = (
    groupId
      ? getDatabase()
          .prepare(
            "select * from group_proactivity_actions where group_id = ? order by created_at, id",
          )
          .all(groupId)
      : getDatabase()
          .prepare("select * from group_proactivity_actions order by created_at, id")
          .all()
  ) as ActionRow[];
  return rows.map(toAction);
}

/** Persist the confirmation step when a source execution ends or is retired. */
export function markSuggestedActionsForNewExecution(executionId: string): GroupActionRecord[] {
  if (!executionId) return [];
  const db = getDatabase();
  const ids = (
    db
      .prepare(`select id from group_proactivity_actions
      where execution_id = ? and delivery_state = 'suggested' and requires_new_execution = 0`)
      .all(executionId) as Array<{ id: string }>
  ).map((row) => row.id);
  if (ids.length === 0) return [];
  const now = new Date().toISOString();
  db.prepare(`update group_proactivity_actions set requires_new_execution = 1,
    version = version + 1, updated_at = ?
    where execution_id = ? and delivery_state = 'suggested' and requires_new_execution = 0`).run(
    now,
    executionId,
  );
  return ids.flatMap((id) => {
    const action = getGroupAction(id);
    return action ? [action] : [];
  });
}

export function listPendingGroupActions(groupId?: string): GroupActionRecord[] {
  const rows = (
    groupId
      ? getDatabase()
          .prepare(
            "select * from group_proactivity_actions where delivery_state = 'pending' and group_id = ? order by created_at, id",
          )
          .all(groupId)
      : getDatabase()
          .prepare(
            "select * from group_proactivity_actions where delivery_state = 'pending' order by created_at, id",
          )
          .all()
  ) as ActionRow[];
  return rows.map(toAction);
}

/** Resolve the source in SQLite so caller-supplied IDs cannot forge group or task context. */
function sourceOf(decision: GroupProactivityDecision): {
  groupId: string;
  taskVersion: number;
  executionId: string | null;
} {
  const db = getDatabase();
  const row = db
    .prepare(
      "select group_id, task_id, task_version, execution_id from group_task_events where id = ?",
    )
    .get(decision.sourceEventId) as
    | { group_id: string; task_id: string; task_version: number; execution_id: string | null }
    | undefined;
  if (row && row.task_id === decision.taskId)
    return { groupId: row.group_id, taskVersion: row.task_version, executionId: row.execution_id };
  throw new GroupStoreError("invalid-value", "Decision source does not belong to this task.");
}

export function persistGroupProactivityDecision(
  decision: GroupProactivityDecision,
  options: { requiresNewExecution?: boolean } = {},
): GroupActionRecord {
  if (
    !decision ||
    !["suggest", "wake_owner", "wake_reviewer"].includes(decision.kind) ||
    !decision.taskId ||
    !decision.sourceEventId ||
    !decision.reasonCode ||
    !decision.idempotencyKey ||
    (decision.kind === "suggest" ? !!decision.targetSessionId : !decision.targetSessionId)
  )
    throw new GroupStoreError("invalid-value", "Malformed proactivity decision.");
  const source = sourceOf(decision);
  const task = getDatabase()
    .prepare("select group_id from group_tasks where id = ?")
    .get(decision.taskId) as { group_id: string } | undefined;
  if (!task || task.group_id !== source.groupId)
    throw new GroupStoreError("invalid-value", "Decision crosses groups.");
  const db = getDatabase();
  const existing = db
    .prepare("select * from group_proactivity_actions where idempotency_key = ?")
    .get(decision.idempotencyKey) as ActionRow | undefined;
  if (existing) {
    if (
      existing.decision_json !== JSON.stringify(decision) ||
      existing.group_id !== source.groupId ||
      existing.task_version !== source.taskVersion
    )
      throw new GroupStoreError(
        "invalid-value",
        "Decision key was reused with a different payload.",
      );
    return toAction(existing);
  }
  if (getGroupActionBySource(source.groupId, decision.sourceEventId))
    throw new GroupStoreError("invalid-value", "Decision source already has an action.");
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`insert into group_proactivity_actions
    (id,idempotency_key,group_id,task_id,task_version,execution_id,source_event_id,decision_json,delivery_state,requires_new_execution,created_at,updated_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id,
    decision.idempotencyKey,
    source.groupId,
    decision.taskId,
    source.taskVersion,
    source.executionId,
    decision.sourceEventId,
    JSON.stringify(decision),
    decision.kind === "suggest" ? "suggested" : "pending",
    options.requiresNewExecution ? 1 : 0,
    now,
    now,
  );
  return requireAction(id);
}

export function markGroupActionDispatched(
  id: string,
  wakeMessageId: string,
  jobId: string,
  binding?: { targetSessionId: string; resolvedExecutionId: string },
): GroupActionRecord {
  const db = getDatabase();
  db.prepare(
    `update group_proactivity_actions set delivery_state = 'dispatched', wake_message_id = ?, job_id = ?,
      resolution_target_session_id = ?, resolved_execution_id = ?, version = version + 1, updated_at = ?
      where id = ? and delivery_state = 'pending'`,
  ).run(
    wakeMessageId,
    jobId,
    binding?.targetSessionId ?? null,
    binding?.resolvedExecutionId ?? null,
    new Date().toISOString(),
    id,
  );
  const action = getGroupAction(id);
  if (
    action?.deliveryState !== "dispatched" ||
    action.wakeMessageId !== wakeMessageId ||
    action.jobId !== jobId
  )
    throw new GroupStoreError("invalid-transition", "Action cannot be dispatched.");
  return action;
}

/** Resolve one suggestion with optimistic concurrency inside the caller's durable transaction. */
export function resolveSuggestedGroupAction(input: {
  id: string;
  expectedVersion: number;
  decision: "accept" | "discard";
  wakeMessageId?: string;
  jobId?: string;
  targetSessionId?: string;
  resolvedExecutionId?: string;
}): GroupActionRecord {
  if (
    !input.id ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    (input.decision === "accept" &&
      (!input.wakeMessageId ||
        !input.jobId ||
        !input.targetSessionId ||
        !input.resolvedExecutionId)) ||
    (input.decision === "discard" &&
      (input.wakeMessageId || input.jobId || input.targetSessionId || input.resolvedExecutionId))
  )
    throw new GroupStoreError("invalid-value", "Malformed suggestion resolution.");

  const state = input.decision === "accept" ? "dispatched" : "discarded";
  const changed = getDatabase()
    .prepare(`update group_proactivity_actions set delivery_state = ?, wake_message_id = ?, job_id = ?,
      resolution_target_session_id = ?, resolved_execution_id = ?, version = version + 1, updated_at = ?
      where id = ? and delivery_state = 'suggested' and version = ?`)
    .run(
      state,
      input.wakeMessageId ?? null,
      input.jobId ?? null,
      input.targetSessionId ?? null,
      input.resolvedExecutionId ?? null,
      new Date().toISOString(),
      input.id,
      input.expectedVersion,
    );
  if (!changed.changes)
    throw new GroupStoreError(
      "stale-task",
      "Suggestion changed or was already resolved. Refresh the suggestion before acting.",
    );
  return requireAction(input.id);
}

export function invalidateSuggestedGroupAction(
  id: string,
  expectedVersion: number,
): GroupActionRecord {
  const changed = getDatabase()
    .prepare(`update group_proactivity_actions set delivery_state = 'invalidated',
      version = version + 1, updated_at = ?
      where id = ? and delivery_state = 'suggested' and version = ?`)
    .run(new Date().toISOString(), id, expectedVersion);
  if (!changed.changes)
    throw new GroupStoreError("stale-task", "Suggestion changed before it could be invalidated.");
  return requireAction(id);
}

export function invalidateGroupAction(id: string): GroupActionRecord {
  getDatabase()
    .prepare(
      "update group_proactivity_actions set delivery_state = 'invalidated', version = version + 1, updated_at = ? where id = ? and delivery_state = 'pending'",
    )
    .run(new Date().toISOString(), id);
  const action = getGroupAction(id);
  if (!action) throw new GroupStoreError("invalid-value", "Unknown action.");
  return action;
}

/** Preserve a still-ready task action as a user-visible suggestion after dispatch rollback. */
export function deferPendingGroupActionAsSuggestion(
  id: string,
  input: { reasonCode: string; requiresNewExecution: boolean },
): GroupActionRecord {
  if (!input.reasonCode)
    throw new GroupStoreError("invalid-value", "A deferred suggestion needs a reason.");
  const action = getGroupAction(id);
  if (action?.deliveryState !== "pending")
    throw new GroupStoreError("invalid-transition", "Only a pending action can be deferred.");
  const suggestedDecision: GroupProactivityDecision = {
    kind: "suggest",
    taskId: action.decision.taskId,
    sourceEventId: action.decision.sourceEventId,
    reasonCode: input.reasonCode,
    idempotencyKey: action.decision.idempotencyKey,
  };
  const changed = getDatabase()
    .prepare(`update group_proactivity_actions set delivery_state = 'suggested', decision_json = ?,
      wake_message_id = null, job_id = null, resolution_target_session_id = null,
      resolved_execution_id = null, requires_new_execution = ?, version = version + 1, updated_at = ?
      where id = ? and delivery_state = 'pending'`)
    .run(
      JSON.stringify(suggestedDecision),
      input.requiresNewExecution ? 1 : 0,
      new Date().toISOString(),
      id,
    );
  if (!changed.changes)
    throw new GroupStoreError("stale-task", "Action changed before it could be deferred.");
  return requireAction(id);
}

/** A committed automatic job may lose authority while waiting for a start gate. */
export function invalidateDispatchedGroupAction(id: string): GroupActionRecord {
  getDatabase()
    .prepare(
      "update group_proactivity_actions set delivery_state = 'invalidated', version = version + 1, updated_at = ? where id = ? and delivery_state = 'dispatched'",
    )
    .run(new Date().toISOString(), id);
  return requireAction(id);
}
