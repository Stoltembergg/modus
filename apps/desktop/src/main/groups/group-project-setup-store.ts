import type {
  GroupProjectContextSnapshot,
  GroupProjectContextStatus,
} from "../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";
import { getDatabase } from "../db/database";

const SAFE_WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type SetupRow = {
  workspace_id: string;
  fingerprint: string;
  status: string;
  codegraph_state: string | null;
  edge_count: number;
  detail: string | null;
  revision: string | null;
  branch: string | null;
  head: string | null;
  updated_at: string;
  last_ready_at: string | null;
};

/** Ensure Setup table exists without touching the global migrateDatabase monolith. */
function ensureWorkspaceProjectSetupTable(): void {
  getDatabase().exec(`
    create table if not exists workspace_project_setup (
      workspace_id text primary key references workspaces(id) on delete cascade,
      fingerprint text not null,
      status text not null check (
        status in ('mapping','ready','updating','needs_refresh','failed')
      ),
      codegraph_state text,
      edge_count integer not null default 0,
      detail text,
      revision text,
      branch text,
      head text,
      updated_at text not null,
      last_ready_at text
    );
  `);
}

function rowToSnapshot(row: SetupRow): GroupProjectContextSnapshot {
  const snapshot: GroupProjectContextSnapshot = {
    workspaceId: row.workspace_id,
    status: row.status as GroupProjectContextStatus,
    fingerprint: row.fingerprint,
    edgeCount: row.edge_count,
    updatedAt: row.updated_at,
  };
  if (row.codegraph_state) snapshot.codegraphState = row.codegraph_state;
  if (row.detail) snapshot.detail = row.detail;
  if (row.revision) snapshot.revision = row.revision;
  if (row.last_ready_at) snapshot.lastReadyAt = row.last_ready_at;
  return snapshot;
}

export function getWorkspaceProjectSetup(
  workspaceId: string,
): GroupProjectContextSnapshot | undefined {
  if (!SAFE_WORKSPACE.test(workspaceId) || workspaceId === CHATS_WORKSPACE_ID) return undefined;
  ensureWorkspaceProjectSetupTable();
  const row = getDatabase()
    .prepare(
      `select workspace_id, fingerprint, status, codegraph_state, edge_count, detail, revision,
              branch, head, updated_at, last_ready_at
       from workspace_project_setup where workspace_id = ?`,
    )
    .get(workspaceId) as SetupRow | undefined;
  return row ? rowToSnapshot(row) : undefined;
}

export function getWorkspaceProjectSetupMeta(workspaceId: string):
  | {
      fingerprint: string;
      branch?: string;
      head?: string;
      status: GroupProjectContextStatus;
    }
  | undefined {
  if (!SAFE_WORKSPACE.test(workspaceId) || workspaceId === CHATS_WORKSPACE_ID) return undefined;
  ensureWorkspaceProjectSetupTable();
  const row = getDatabase()
    .prepare(
      `select fingerprint, status, branch, head from workspace_project_setup where workspace_id = ?`,
    )
    .get(workspaceId) as
    | { fingerprint: string; status: string; branch: string | null; head: string | null }
    | undefined;
  if (!row) return undefined;
  return {
    fingerprint: row.fingerprint,
    status: row.status as GroupProjectContextStatus,
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.head ? { head: row.head } : {}),
  };
}

export function upsertWorkspaceProjectSetup(input: {
  workspaceId: string;
  fingerprint: string;
  status: GroupProjectContextStatus;
  codegraphState?: string;
  edgeCount: number;
  detail?: string;
  revision?: string;
  branch?: string;
  head?: string;
  now?: string;
  markReady?: boolean;
}): GroupProjectContextSnapshot {
  if (!SAFE_WORKSPACE.test(input.workspaceId) || input.workspaceId === CHATS_WORKSPACE_ID) {
    throw new Error("workspace_project_setup requires a real Project workspace");
  }
  ensureWorkspaceProjectSetupTable();
  const now = input.now ?? new Date().toISOString();
  const prior = getDatabase()
    .prepare(`select last_ready_at from workspace_project_setup where workspace_id = ?`)
    .get(input.workspaceId) as { last_ready_at: string | null } | undefined;
  const lastReadyAt =
    input.markReady || input.status === "ready" ? now : (prior?.last_ready_at ?? null);
  getDatabase()
    .prepare(
      `insert into workspace_project_setup
        (workspace_id, fingerprint, status, codegraph_state, edge_count, detail, revision,
         branch, head, updated_at, last_ready_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(workspace_id) do update set
         fingerprint = excluded.fingerprint,
         status = excluded.status,
         codegraph_state = excluded.codegraph_state,
         edge_count = excluded.edge_count,
         detail = excluded.detail,
         revision = excluded.revision,
         branch = excluded.branch,
         head = excluded.head,
         updated_at = excluded.updated_at,
         last_ready_at = excluded.last_ready_at`,
    )
    .run(
      input.workspaceId,
      input.fingerprint,
      input.status,
      input.codegraphState ?? null,
      input.edgeCount,
      input.detail ?? null,
      input.revision ?? null,
      input.branch ?? null,
      input.head ?? null,
      now,
      lastReadyAt,
    );
  const snapshot = getWorkspaceProjectSetup(input.workspaceId);
  if (!snapshot) {
    throw new Error("workspace_project_setup upsert failed to persist");
  }
  return snapshot;
}
