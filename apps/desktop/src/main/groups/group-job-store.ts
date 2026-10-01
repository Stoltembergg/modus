import { getDatabase } from "../db/database";
import type { ChainState, Wake } from "./group-runtime-lib";

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
    (id, group_id, session_id, chain_id, trigger_message_id, message_id, seq, prompt, status, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) on conflict(id) do nothing`)
    .run(
      wake.id,
      wake.groupId,
      wake.sessionId,
      wake.chainId,
      wake.triggerMessageId,
      wake.messageId,
      wake.seq,
      wake.prompt,
      now,
      now,
    );
}

export function updateGroupJob(wake: Wake, status: GroupJobStatus, error?: string): void {
  if (!wake.id) return;
  getDatabase()
    .prepare("update group_jobs set status = ?, error = ?, updated_at = ? where id = ?")
    .run(status, error ?? null, new Date().toISOString(), wake.id);
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
  };
}

/** Look up a durable group job by its execution id (turn id). */
export function getGroupJob(
  jobId: string,
): { wake: Wake; status: GroupJobStatus; error: string | null } | undefined {
  const row = getDatabase()
    .prepare("select * from group_jobs where id = ?")
    .get(jobId) as JobRow | undefined;
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
