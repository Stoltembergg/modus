import { randomUUID } from "node:crypto";
import type { AgentSessionInfo, SubagentWorktreeInfo } from "../../shared/contracts";
import { getDatabase } from "../db/database";
import { getWorkspace } from "../workspace/workspace-store";

type AgentSessionRow = {
  id: string;
  workspace_id: string;
  title: string;
  cwd: string;
  status: AgentSessionInfo["status"];
  runtime: "pi-sdk" | "pi-rpc";
  model: string | null;
  pi_session_id: string | null;
  pi_session_file: string | null;
  parent_session_id: string | null;
  subagent_task: string | null;
  subagent_type: string | null;
  subagent_readonly: number;
  subagent_worktree_path: string | null;
  subagent_worktree_branch: string | null;
  subagent_worktree_base_sha: string | null;
  subagent_integration_status: string | null;
  subagent_changed_files_json: string | null;
  subagent_conflict_files_json: string | null;
  pinned_at: string | null;
  archived_at: string | null;
  kind: "chat" | "group_member";
  agent_id: string | null;
  read_only: number;
  created_at: string;
  updated_at: string;
};

const SESSION_COLUMNS = `id, workspace_id, title, cwd, status, runtime, model, pi_session_id,
  pi_session_file, parent_session_id, subagent_task, subagent_type, subagent_readonly,
  subagent_worktree_path, subagent_worktree_branch, subagent_worktree_base_sha,
  subagent_integration_status, subagent_changed_files_json, subagent_conflict_files_json,
  pinned_at, archived_at, kind, agent_id, read_only, created_at, updated_at`;

function parseJsonArray(text: string | null): string[] | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : undefined;
  } catch {
    return undefined;
  }
}

function toSession(row: AgentSessionRow): AgentSessionInfo {
  const session: AgentSessionInfo = {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    cwd: row.cwd,
    status: row.status,
    runtime: row.runtime,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.model !== null) {
    session.model = row.model;
  }
  if (row.pi_session_id !== null) {
    session.piSessionId = row.pi_session_id;
  }
  if (row.pi_session_file !== null) {
    session.piSessionFile = row.pi_session_file;
  }
  if (row.parent_session_id !== null) {
    session.parentSessionId = row.parent_session_id;
  }
  if (row.pinned_at !== null) {
    session.pinnedAt = row.pinned_at;
  }
  if (row.archived_at !== null) {
    session.archivedAt = row.archived_at;
  }
  if (row.kind === "group_member") {
    session.kind = "group_member";
  }
  if (row.agent_id !== null) {
    session.agentId = row.agent_id;
  }
  if (Number(row.read_only ?? 0) !== 0) {
    session.readOnly = true;
  }
  if (row.subagent_task !== null) {
    session.subagentTask = row.subagent_task;
  }
  if (row.subagent_type !== null) {
    session.subagentType = row.subagent_type;
  }
  if (row.subagent_readonly !== 0) {
    session.subagentReadOnly = true;
  }
  if (
    row.subagent_worktree_path !== null &&
    row.subagent_worktree_branch !== null &&
    row.subagent_worktree_base_sha !== null
  ) {
    const integrationStatus = row.subagent_integration_status as
      | SubagentWorktreeInfo["integrationStatus"]
      | null;
    const changedFiles = parseJsonArray(row.subagent_changed_files_json);
    const conflictFiles = parseJsonArray(row.subagent_conflict_files_json);
    session.subagentWorktree = {
      path: row.subagent_worktree_path,
      branch: row.subagent_worktree_branch,
      baseSha: row.subagent_worktree_base_sha,
      integrationStatus: integrationStatus ?? "running",
      ...(changedFiles ? { changedFiles } : {}),
      ...(conflictFiles ? { conflictFiles } : {}),
    };
  }
  return session;
}

export function createAgentSessionRecord(input: {
  id?: string;
  workspaceId: string;
  title: string;
  cwd: string;
  runtime?: "pi-sdk" | "pi-rpc";
  model?: string;
  agentId?: string;
  piSessionId?: string;
  piSessionFile?: string;
  parentSessionId?: string;
  subagentTask?: string;
  subagentType?: string;
  subagentReadOnly?: boolean;
  subagentWorktree?: SubagentWorktreeInfo;
}): AgentSessionInfo {
  const now = new Date().toISOString();
  const runtime = input.runtime ?? "pi-sdk";
  const session: AgentSessionInfo = {
    id: input.id ?? randomUUID(),
    workspaceId: input.workspaceId,
    title: input.title,
    cwd: input.cwd,
    status: "starting",
    runtime,
    createdAt: now,
    updatedAt: now,
  };

  if (input.model !== undefined) {
    session.model = input.model;
  }
  if (input.agentId !== undefined) {
    session.agentId = input.agentId;
  }
  if (input.piSessionId !== undefined) {
    session.piSessionId = input.piSessionId;
  }
  if (input.piSessionFile !== undefined) {
    session.piSessionFile = input.piSessionFile;
  }
  if (input.parentSessionId !== undefined) {
    session.parentSessionId = input.parentSessionId;
  }
  if (input.subagentTask !== undefined) {
    session.subagentTask = input.subagentTask;
  }
  if (input.subagentType !== undefined) {
    session.subagentType = input.subagentType;
  }
  if (input.subagentReadOnly !== undefined) {
    session.subagentReadOnly = input.subagentReadOnly;
  }
  if (input.subagentWorktree !== undefined) {
    session.subagentWorktree = input.subagentWorktree;
  }
  getDatabase()
    .prepare(
      `insert into agent_sessions (
        id, workspace_id, title, cwd, status, runtime, model, pi_session_id, pi_session_file,
        parent_session_id, subagent_task, subagent_type, subagent_readonly,
        subagent_worktree_path, subagent_worktree_branch, subagent_worktree_base_sha,
        subagent_integration_status, subagent_changed_files_json, subagent_conflict_files_json,
        agent_id, created_at, updated_at
       )
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      session.id,
      session.workspaceId,
      session.title,
      session.cwd,
      session.status,
      runtime,
      session.model ?? null,
      session.piSessionId ?? null,
      session.piSessionFile ?? null,
      session.parentSessionId ?? null,
      session.subagentTask ?? null,
      session.subagentType ?? null,
      session.subagentReadOnly ? 1 : 0,
      session.subagentWorktree?.path ?? null,
      session.subagentWorktree?.branch ?? null,
      session.subagentWorktree?.baseSha ?? null,
      session.subagentWorktree?.integrationStatus ?? null,
      session.subagentWorktree?.changedFiles
        ? JSON.stringify(session.subagentWorktree.changedFiles)
        : null,
      session.subagentWorktree?.conflictFiles
        ? JSON.stringify(session.subagentWorktree.conflictFiles)
        : null,
      session.agentId ?? null,
      session.createdAt,
      session.updatedAt,
    );

  return session;
}

/**
 * Writes the session's worktree info. `options.cwd` also moves the session's
 * working directory in the same update (Agent Group member worktrees; a live
 * runtime picks it up on its next turn, see PiSdkRuntime.getOrResume).
 */
export function updateAgentSessionWorktree(
  sessionId: string,
  worktree: SubagentWorktreeInfo | undefined,
  options: { cwd?: string } = {},
): AgentSessionInfo | undefined {
  const existing = getAgentSession(sessionId);
  if (!existing) {
    return undefined;
  }

  getDatabase()
    .prepare(
      `update agent_sessions
       set cwd = ?,
           subagent_worktree_path = ?,
           subagent_worktree_branch = ?,
           subagent_worktree_base_sha = ?,
           subagent_integration_status = ?,
           subagent_changed_files_json = ?,
           subagent_conflict_files_json = ?
       where id = ?`,
    )
    .run(
      options.cwd ?? existing.cwd,
      worktree?.path ?? null,
      worktree?.branch ?? null,
      worktree?.baseSha ?? null,
      worktree?.integrationStatus ?? null,
      worktree?.changedFiles ? JSON.stringify(worktree.changedFiles) : null,
      worktree?.conflictFiles ? JSON.stringify(worktree.conflictFiles) : null,
      sessionId,
    );

  return getAgentSession(sessionId);
}

/**
 * Conversation activity heartbeat — the ONLY writer of `updated_at` after create.
 * Open/resume/status/metadata/pin/archive must never bump the sort key.
 */
export function touchAgentSession(sessionId: string): string {
  const now = new Date().toISOString();
  getDatabase()
    .prepare("update agent_sessions set updated_at = ? where id = ?")
    .run(now, sessionId);
  return now;
}

export function updateAgentSessionStatus(
  sessionId: string,
  status: AgentSessionInfo["status"],
): void {
  getDatabase().prepare("update agent_sessions set status = ? where id = ?").run(status, sessionId);
}

export function updateAgentSessionMetadata(
  sessionId: string,
  metadata: Partial<Pick<AgentSessionInfo, "model" | "piSessionId" | "piSessionFile">>,
): AgentSessionInfo | undefined {
  const existing = getAgentSession(sessionId);
  if (!existing) {
    return undefined;
  }

  const next = { ...existing, ...metadata };
  getDatabase()
    .prepare(
      `update agent_sessions
       set model = ?, pi_session_id = ?, pi_session_file = ?
       where id = ?`,
    )
    .run(next.model ?? null, next.piSessionId ?? null, next.piSessionFile ?? null, sessionId);

  return next;
}

export function updateAgentSessionTitle(
  sessionId: string,
  title: string,
): AgentSessionInfo | undefined {
  const existing = getAgentSession(sessionId);
  if (!existing) {
    return undefined;
  }

  const next = { ...existing, title };
  getDatabase()
    .prepare("update agent_sessions set title = ? where id = ?")
    .run(next.title, sessionId);

  return next;
}

export function getAgentSession(sessionId: string): AgentSessionInfo | undefined {
  const row = getDatabase()
    .prepare(
      `select ${SESSION_COLUMNS}
       from agent_sessions
       where id = ?`,
    )
    .get(sessionId) as AgentSessionRow | undefined;

  return row ? toSession(row) : undefined;
}

/** Every surviving reference matters, including archived and hidden group sessions. */
export function listOtherAgentSessionPiSessionFiles(sessionId: string): string[] {
  const rows = getDatabase()
    .prepare(
      `select pi_session_file from agent_sessions
       where id <> ? and pi_session_file is not null`,
    )
    .all(sessionId) as { pi_session_file: string }[];
  return rows.map((row) => row.pi_session_file);
}

export function listAgentSessions(options: { includeSessionId?: string } = {}): AgentSessionInfo[] {
  const rows = getDatabase()
    .prepare(
      `select ${SESSION_COLUMNS}
       from agent_sessions
       where archived_at is null and kind = 'chat'
       order by pinned_at is null, pinned_at desc, updated_at desc`,
    )
    .all() as AgentSessionRow[];

  const sessions = rows.map(toSession);
  if (
    options.includeSessionId &&
    !sessions.some((session) => session.id === options.includeSessionId)
  ) {
    // Group room turns stay in the group pane: never hand the renderer a
    // hidden `group_member` session to open as a private chat (Waiting for
    // you / ask_user are answered in the room). Other non-listed sessions
    // (e.g. an archived chat kept open) can still be included.
    const included = getAgentSession(options.includeSessionId);
    if (included && included.kind !== "group_member") {
      sessions.push(included);
    }
  }
  return sessions;
}

/**
 * Sessions still linked to a legacy group of a Project through
 * `agent_group_members` (the groups migration keeps those rows). "Remove
 * project" tears them down too, wherever they live.
 */
export function listWorkspaceGroupMemberSessionIds(workspaceId: string): string[] {
  const rows = getDatabase()
    .prepare(
      `select m.session_id from agent_group_members m
       join agent_groups g on g.id = m.group_id
       where g.workspace_id = ? order by m.rowid`,
    )
    .all(workspaceId) as Array<{ session_id: string }>;
  return rows.map((row) => row.session_id);
}

export function listArchivedAgentSessions(workspaceId: string): AgentSessionInfo[] {
  const rows = getDatabase()
    .prepare(
      `select ${SESSION_COLUMNS}
       from agent_sessions
       where workspace_id = ? and parent_session_id is null and archived_at is not null
         and kind = 'chat'
       order by archived_at desc`,
    )
    .all(workspaceId) as AgentSessionRow[];

  return rows.map(toSession);
}

export function listSubagentSessions(parentSessionId: string): AgentSessionInfo[] {
  const rows = getDatabase()
    .prepare(
      `select ${SESSION_COLUMNS}
       from agent_sessions
       where parent_session_id = ? and kind = 'chat'
       order by created_at asc, rowid asc`,
    )
    .all(parentSessionId) as AgentSessionRow[];

  return rows.map(toSession);
}

export function setAgentSessionPinned(
  sessionId: string,
  pinned: boolean,
): AgentSessionInfo | undefined {
  getDatabase()
    .prepare("update agent_sessions set pinned_at = ? where id = ?")
    .run(pinned ? new Date().toISOString() : null, sessionId);
  return getAgentSession(sessionId);
}

/** Archives / unarchives a session. */
export function setAgentSessionArchived(
  sessionId: string,
  archived: boolean,
): AgentSessionInfo | undefined {
  getDatabase()
    .prepare("update agent_sessions set archived_at = ? where id = ?")
    .run(archived ? new Date().toISOString() : null, sessionId);
  return getAgentSession(sessionId);
}

/**
 * Permanently removes a session and (via `on delete cascade`) its recorded
 * events and runs. Used by the explicit delete action.
 */
export function deleteAgentSession(sessionId: string): void {
  getDatabase().prepare("delete from agent_sessions where id = ?").run(sessionId);
}

/** L2: the session's chosen branch (session state), or undefined when never set. */
export function getAgentSessionBranch(sessionId: string): string | undefined {
  const row = getDatabase()
    .prepare("select branch from agent_sessions where id = ?")
    .get(sessionId) as { branch: string | null } | undefined;
  return row?.branch ?? undefined;
}

export function setAgentSessionBranch(sessionId: string, branch: string): void {
  getDatabase().prepare("update agent_sessions set branch = ? where id = ?").run(branch, sessionId);
}

/** define-goal: the session's raw goal state JSON, or undefined when never set. */
export function getAgentSessionGoalJson(sessionId: string): string | undefined {
  const row = getDatabase()
    .prepare("select goal_json from agent_sessions where id = ?")
    .get(sessionId) as { goal_json: string | null } | undefined;
  return row?.goal_json ?? undefined;
}

export function setAgentSessionGoalJson(sessionId: string, goalJson: string): void {
  getDatabase()
    .prepare("update agent_sessions set goal_json = ? where id = ?")
    .run(goalJson, sessionId);
}

/** Location metadata only: transcript, model, run evidence and timestamps remain unchanged. */
export function moveAgentSessionWorkspace(
  sessionId: string,
  workspaceId: string,
  pinned: boolean,
): AgentSessionInfo {
  const session = getAgentSession(sessionId);
  const workspace = getWorkspace(workspaceId);
  if (!session || !workspace) throw new Error("Session or destination workspace not found.");
  getDatabase()
    .prepare(
      "update agent_sessions set workspace_id = ?, cwd = ?, pinned_at = ?, branch = null where id = ?",
    )
    .run(workspace.id, workspace.rootPath, pinned ? new Date().toISOString() : null, sessionId);
  const moved = getAgentSession(sessionId);
  if (!moved) throw new Error("Session disappeared during movement.");
  return moved;
}
