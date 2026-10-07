import type { GroupTaskQueueItem } from "../../shared/group-work-state";
import { getDatabase } from "../db/database";
import { listGroupActions } from "./group-proactivity-store";
import type { ChainState, Wake } from "./group-runtime-lib";
import { listAgentGroupMembers } from "./group-store";
import { selectReadyGroupTasks } from "./group-task-scheduler";
import { getGroupTaskReadyState, listGroupTasks } from "./group-task-store";
import { getGroupWorkState } from "./group-work-state";

export type GroupJobStatus =
  | "pending"
  | "running"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
type JobRow = {
  id: string;
  group_id: string;
  session_id: string;
  chain_id: string;
  trigger_message_id: string;
  message_id: string;
  seq: number;
  prompt: string;
  purpose: "task" | "control";
  task_id: string | null;
  task_version: number | null;
  first_started_at: string | null;
  status: GroupJobStatus;
  error: string | null;
};

export function persistGroupChain(chain: ChainState): void {
  getDatabase()
    .prepare(`insert into group_execution_chains (id, group_id, state_json, updated_at)
    values (?, ?, ?, ?) on conflict(id) do update set state_json = excluded.state_json, updated_at = excluded.updated_at`)
    .run(
      chain.chainId,
      chain.groupId,
      JSON.stringify({ ...chain, wakesByMember: Object.fromEntries(chain.wakesByMember) }),
      new Date().toISOString(),
    );
}

export function readGroupChain(chainId: string): ChainState | undefined {
  const row = getDatabase()
    .prepare("select state_json from group_execution_chains where id = ?")
    .get(chainId) as { state_json: string } | undefined;
  if (!row) return undefined;
  const saved = JSON.parse(row.state_json) as Omit<ChainState, "wakesByMember"> & {
    wakesByMember: Record<string, number>;
  };
  return { ...saved, wakesByMember: new Map(Object.entries(saved.wakesByMember)) };
}

export function persistGroupJob(wake: Wake): void {
  if (!wake.id || !wake.messageId)
    throw new Error("A group job needs a turn and message identity.");
  const now = new Date().toISOString();
  getDatabase()
    .prepare(`insert into group_jobs
    (id, group_id, session_id, chain_id, trigger_message_id, message_id, seq, prompt, purpose, task_id, task_version, status, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) on conflict(id) do nothing`)
    .run(
      wake.id,
      wake.groupId,
      wake.sessionId,
      wake.chainId,
      wake.triggerMessageId,
      wake.messageId,
      wake.seq,
      wake.prompt,
      wake.purpose ?? "task",
      wake.taskId ?? null,
      wake.taskVersion ?? null,
      now,
      now,
    );
}

export function updateGroupJob(wake: Wake, status: GroupJobStatus, error?: string): void {
  if (!wake.id) return;
  const now = new Date().toISOString();
  getDatabase()
    .prepare(`update group_jobs set status = ?, error = ?,
      first_started_at = case when task_id is not null and ? = 'running'
        then coalesce(first_started_at, ?) else first_started_at end,
      updated_at = ? where id = ?`)
    .run(status, error ?? null, status, now, now, wake.id);
}

function wakeFromRow(row: JobRow): Wake {
  return {
    id: row.id,
    messageId: row.message_id,
    groupId: row.group_id,
    sessionId: row.session_id,
    chainId: row.chain_id,
    triggerMessageId: row.trigger_message_id,
    seq: row.seq,
    prompt: row.prompt,
    purpose: row.purpose,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.task_version !== null ? { taskVersion: row.task_version } : {}),
  };
}

/** Look up a durable group job by its execution id (turn id). */
export function getGroupJob(
  jobId: string,
): { wake: Wake; status: GroupJobStatus; error: string | null } | undefined {
  const row = getDatabase().prepare("select * from group_jobs where id = ?").get(jobId) as
    | JobRow
    | undefined;
  if (!row) return undefined;
  return { status: row.status, error: row.error, wake: wakeFromRow(row) };
}

export function listRecoverableGroupJobs(): Array<{ wake: Wake; status: GroupJobStatus }> {
  const rows = getDatabase()
    .prepare(
      "select * from group_jobs where status in ('pending','running','awaiting_user') order by seq, created_at, id",
    )
    .all() as JobRow[];
  return rows.map((row) => ({
    status: row.status,
    wake: wakeFromRow(row),
  }));
}

/** Project the existing persisted FIFO and un-actioned ready tasks; never returns prompt text. */
export function getGroupTaskQueueSnapshot(groupId: string): GroupTaskQueueItem[] {
  const db = getDatabase();
  if (!db.prepare("select 1 from agent_groups where id = ?").get(groupId))
    throw new Error("Agent group not found.");

  const members = listAgentGroupMembers(groupId);
  const memberNames = new Map(members.map((member) => [member.sessionId, member.name]));
  const tasks = listGroupTasks(groupId);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const jobs = db
    .prepare(`select id, session_id, task_id, status from group_jobs
      where group_id = ? and task_id is not null and status in ('running','pending')
      order by seq, created_at, id`)
    .all(groupId) as Array<{
    id: string;
    session_id: string;
    task_id: string;
    status: "running" | "pending";
  }>;
  const taskPositions = new Map<string, number>();
  const items: GroupTaskQueueItem[] = jobs.flatMap((job) => {
    const task = tasksById.get(job.task_id);
    if (!task) return [];
    const position = (taskPositions.get(job.session_id) ?? 0) + 1;
    taskPositions.set(job.session_id, position);
    return [
      {
        taskId: task.id,
        taskTitle: task.title,
        state: job.status === "running" ? "running" : "queued",
        sessionId: job.session_id,
        memberName: memberNames.get(job.session_id) ?? "Former member",
        jobId: job.id,
        position,
      },
    ];
  });

  const readiness = Object.fromEntries(
    tasks.flatMap((task) => {
      const ready = getGroupTaskReadyState(task.id);
      return ready
        ? [
            [
              task.id,
              { fingerprint: ready.readinessFingerprint, readySince: Date.parse(ready.readySince) },
            ],
          ]
        : [];
    }),
  );
  const workState = getGroupWorkState(groupId);
  workState.tasks = tasks;
  workState.members = members;
  const pendingTaskJobsByMember = Object.fromEntries(
    (
      db
        .prepare(`select session_id, count(*) as count from group_jobs
          where group_id = ? and task_id is not null and status = 'pending' group by session_id`)
        .all(groupId) as Array<{ session_id: string; count: number }>
    ).map((row) => [row.session_id, row.count]),
  );
  const activeReadyActionIdentities = new Set<string>();
  for (const action of listGroupActions(groupId)) {
    if (action.deliveryState !== "suggested" && action.deliveryState !== "pending") continue;
    const current = readiness[action.taskId];
    if (!current || action.taskVersion !== tasksById.get(action.taskId)?.stateVersion) continue;
    const source = db
      .prepare(`select action, result_json from group_task_events
        where id = ? and group_id = ? and task_id = ?`)
      .get(action.sourceEventId, groupId, action.taskId) as
      | { action: string; result_json: string }
      | undefined;
    if (source?.action !== "task_ready") continue;
    try {
      const result = JSON.parse(source.result_json) as {
        readinessFingerprint?: unknown;
        readySince?: unknown;
      };
      const sourceReadySince =
        typeof result.readySince === "string" ? Date.parse(result.readySince) : Number.NaN;
      if (
        result.readinessFingerprint === current.fingerprint &&
        Number.isFinite(sourceReadySince) &&
        sourceReadySince === current.readySince
      ) {
        activeReadyActionIdentities.add(
          JSON.stringify([action.taskId, current.fingerprint, current.readySince]),
        );
      }
    } catch {
      // An unreadable event result cannot suppress a current ready backlog item.
    }
  }
  const schedulerInput = {
    tasks,
    workState,
    readiness,
    now: Date.now(),
    pendingTaskJobsByMember,
  };
  const backlogCandidates = selectReadyGroupTasks({ ...schedulerInput, queueCapacity: 3 });
  const candidatesWithoutCapacity = new Map(
    selectReadyGroupTasks({
      ...schedulerInput,
      queueCapacity: Number.MAX_SAFE_INTEGER,
    }).map((candidate) => [candidate.taskId, candidate]),
  );
  const backlog = backlogCandidates.flatMap((candidate): GroupTaskQueueItem[] => {
    if (
      activeReadyActionIdentities.has(
        JSON.stringify([candidate.taskId, candidate.readinessFingerprint, candidate.readySince]),
      )
    )
      return [];
    const task = tasks.find((row) => row.id === candidate.taskId);
    if (!task) return [];
    const noCapacityTargets = candidatesWithoutCapacity.get(candidate.taskId)?.targets ?? [];
    const reason: GroupTaskQueueItem["backlogReason"] =
      candidate.reason === "member-unavailable" ||
      (candidate.targets.length === 0 && noCapacityTargets.length > 0)
        ? "awaiting-capacity"
        : candidate.selection === "suggestion-only"
          ? "routing-unavailable"
          : "needs-suggestion";
    return [{ taskId: task.id, taskTitle: task.title, state: "backlog", backlogReason: reason }];
  });
  return [...items, ...backlog];
}
