import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { app } from "electron";
import { agentAvatarForId } from "../../shared/agent-templates";
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_FACES,
  AGENT_AVATAR_SHAPES,
  allocateUniqueGroupAvatarShapes,
} from "../../shared/contracts";

let database: DatabaseSync | undefined;

/** `'a','b'` for a CHECK (... in (...)) over a list of known literals. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(",");
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

export function migrateDatabase(db: DatabaseSync): void {
  db.exec(`
    create table if not exists workspaces (
      id text primary key,
      root_path text not null unique,
      display_name text not null,
      is_git_repository integer not null default 0,
      last_opened_at text not null,
      created_at text not null
    );

    create table if not exists agent_sessions (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      title text not null,
      cwd text not null,
      status text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists permissions (
      id text primary key,
      action text not null,
      target text not null,
      decision text not null,
      created_at text not null
    );

    create table if not exists agent_events (
      id text primary key,
      session_id text not null references agent_sessions(id) on delete cascade,
      type text not null,
      payload_json text not null,
      created_at text not null
    );

    create table if not exists agent_runs (
      id text primary key,
      session_id text not null references agent_sessions(id) on delete cascade,
      user_message_id text,
      prompt text not null,
      status text not null,
      model text,
      started_at text not null,
      completed_at text,
      error text
    );

    create table if not exists terminal_outputs (
      terminal_id text primary key,
      workspace_id text not null,
      cwd text not null,
      output text not null,
      updated_at text not null
    );

    create table if not exists docs_sources (
      id text primary key,
      workspace_id text not null,
      title text not null,
      path text,
      url text,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists docs_chunks (
      id text primary key,
      source_id text not null references docs_sources(id) on delete cascade,
      heading text,
      content text not null,
      ordinal integer not null
    );

    create table if not exists agent_reviews (
      id text primary key,
      session_id text,
      workspace_id text,
      cwd text not null,
      depth text not null,
      status text not null,
      summary text not null,
      issues_json text not null,
      created_at text not null
    );

    create table if not exists app_settings (
      key text primary key,
      value text,
      updated_at text not null
    );

    create table if not exists model_provider_configs (
      provider_id text primary key,
      display_name text not null,
      source text not null,
      base_url text,
      api text,
      auth_header integer not null default 0,
      headers_json text,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists model_configs (
      id text primary key,
      provider_id text not null references model_provider_configs(provider_id) on delete cascade,
      model_id text not null,
      display_name text not null,
      source text not null,
      enabled integer not null default 0,
      context_window integer,
      max_tokens integer,
      reasoning integer not null default 0,
      thinking_level text not null default 'off',
      thinking_level_map_json text,
      created_at text not null,
      updated_at text not null,
      unique(provider_id, model_id)
    );

    create table if not exists agent_checkpoints (
      id text primary key,
      session_id text not null references agent_sessions(id) on delete cascade,
      run_id text,
      user_message_id text,
      cwd text not null,
      commit_hash text not null,
      kind text not null default 'auto',
      created_at text not null
    );

    create index if not exists idx_agent_checkpoints_session
      on agent_checkpoints(session_id);

    create table if not exists browser_recents (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      url_key text not null,
      url text not null,
      title text not null,
      favicon text,
      last_opened_at text not null,
      created_at text not null,
      unique(workspace_id, url_key)
    );

    create index if not exists idx_browser_recents_workspace_recent
      on browser_recents(workspace_id, last_opened_at desc);
  `);

  addColumn(db, "agent_sessions", "runtime", "text not null default 'pi-sdk'");
  addColumn(db, "agent_sessions", "model", "text");
  addColumn(db, "agent_sessions", "pi_session_id", "text");
  addColumn(db, "agent_sessions", "pi_session_file", "text");
  addColumn(
    db,
    "agent_sessions",
    "parent_session_id",
    "text references agent_sessions(id) on delete cascade",
  );
  addColumn(db, "agent_sessions", "subagent_task", "text");
  addColumn(db, "agent_sessions", "subagent_type", "text");
  addColumn(db, "agent_sessions", "subagent_readonly", "integer not null default 0");
  addColumn(db, "agent_sessions", "subagent_worktree_path", "text");
  addColumn(db, "agent_sessions", "subagent_worktree_branch", "text");
  addColumn(db, "agent_sessions", "subagent_worktree_base_sha", "text");
  addColumn(db, "agent_sessions", "subagent_integration_status", "text");
  addColumn(db, "agent_sessions", "subagent_changed_files_json", "text");
  addColumn(db, "agent_sessions", "subagent_conflict_files_json", "text");
  addColumn(db, "agent_sessions", "pinned_at", "text");
  addColumn(db, "agent_sessions", "archived_at", "text");
  // Agents model: an agent's hidden per-group room session is 'group_member'.
  // Every session listing only lists 'chat'.
  addColumn(
    db,
    "agent_sessions",
    "kind",
    "text not null default 'chat' check (kind in ('chat','group_member'))",
  );
  db.exec(`
    create index if not exists idx_agent_sessions_parent
      on agent_sessions(parent_session_id);
  `);
  // Sidebar project pinning: pinned projects sort to the top (pinned_at breaks ties).
  addColumn(db, "workspaces", "pinned", "integer not null default 0");
  addColumn(db, "workspaces", "pinned_at", "text");
  if (hasColumn(db, "agent_sessions", "worktree_path")) {
    db.exec(`
      update agent_sessions
      set
        cwd = coalesce(
          (select root_path from workspaces where workspaces.id = agent_sessions.workspace_id),
          cwd
        ),
        worktree_path = null
      where worktree_path is not null
    `);
  }
  // PI session-tree leaf id captured right before each prompt — the exact
  // branch point used to rewind the conversation when the message is edited.
  // "root" marks an empty tree (first message); NULL marks legacy runs.
  addColumn(db, "agent_runs", "pi_leaf_before", "text");
  addColumn(db, "model_configs", "thinking_variant", "text");

  db.exec(`
    create table if not exists project_memory_records (
      id text primary key,
      scope text not null check (scope in ('global', 'project')),
      workspace_id text references workspaces(id) on delete cascade,
      category text not null check (category in ('decision','architecture','convention','constraint','known_issue','solution','failed_attempt','task_result','preference')),
      title text not null,
      claim text not null,
      status text not null check (status in ('candidate','active','provisional','needs_review','superseded','obsolete')),
      verification text not null check (verification in ('user_explicit','agent_observed','tests_passed','parent_verified','unverified')),
      created_at text not null,
      updated_at text not null,
      last_verified_at text,
      supersedes_id text references project_memory_records(id) on delete set null,
      dedupe_key text not null,
      check ((scope = 'global' and workspace_id is null) or (scope = 'project' and workspace_id is not null))
    );
    create unique index if not exists idx_project_memory_dedupe
      on project_memory_records(scope, ifnull(workspace_id, ''), dedupe_key);
    create index if not exists idx_project_memory_workspace_status_verified
      on project_memory_records(workspace_id, status, last_verified_at);
    create index if not exists idx_project_memory_scope_status_verified
      on project_memory_records(scope, status, last_verified_at);
    create table if not exists project_memory_evidence (
      id text primary key,
      memory_id text not null references project_memory_records(id) on delete cascade,
      kind text not null check (kind in ('user_message','run','task','subagent','commit','file','symbol','external_reference')),
      session_id text references agent_sessions(id) on delete set null,
      run_id text,
      user_message_id text,
      task_ref text,
      commit_sha text,
      branch text,
      path text,
      symbol text,
      detached integer not null default 0 check (detached in (0,1)),
      external_reference_json text
    );
    create index if not exists idx_project_memory_evidence_memory on project_memory_evidence(memory_id);
    create index if not exists idx_project_memory_evidence_session on project_memory_evidence(session_id);
    create table if not exists project_memory_events (
      id text primary key,
      memory_id text not null references project_memory_records(id) on delete cascade,
      from_status text,
      to_status text not null check (to_status in ('candidate','active','provisional','needs_review','superseded','obsolete')),
      actor text not null,
      reason text not null,
      idempotency_key text,
      created_at text not null
    );
    drop index if exists idx_project_memory_event_idempotency;
    create unique index idx_project_memory_event_idempotency
      on project_memory_events(idempotency_key, memory_id) where idempotency_key is not null;
    create index if not exists idx_project_memory_events_memory on project_memory_events(memory_id, created_at);
    create table if not exists project_memory_settings (
      scope text not null check (scope in ('global','project')),
      workspace_id text references workspaces(id) on delete cascade,
      enabled integer not null check (enabled in (0,1)),
      updated_at text not null,
      primary key(scope, workspace_id),
      check ((scope = 'global' and workspace_id is null) or (scope = 'project' and workspace_id is not null))
    );
    create unique index if not exists idx_project_memory_settings_scope
      on project_memory_settings(scope, ifnull(workspace_id, ''));
    create trigger if not exists trg_detach_project_memory_before_session_delete
    before delete on agent_sessions
    begin
      update project_memory_evidence
      set session_id = null, run_id = null, user_message_id = null, detached = 1
      where session_id = old.id
        or run_id in (select id from agent_runs where session_id = old.id)
        or user_message_id in (
          select user_message_id from agent_runs
          where session_id = old.id and user_message_id is not null
        );
    end;
  `);

  const evidenceSql =
    (
      db
        .prepare(
          "select sql from sqlite_master where type = 'table' and name = 'project_memory_evidence'",
        )
        .get() as { sql: string } | undefined
    )?.sql ?? "";
  if (
    !evidenceSql.includes("'external_reference'") ||
    !hasColumn(db, "project_memory_evidence", "external_reference_json")
  ) {
    db.exec("begin");
    try {
      db.exec(`drop trigger if exists trg_detach_project_memory_before_session_delete;
        create table project_memory_evidence_replacement (
          id text primary key,
          memory_id text not null references project_memory_records(id) on delete cascade,
          kind text not null check (kind in ('user_message','run','task','subagent','commit','file','symbol','external_reference')),
          session_id text references agent_sessions(id) on delete set null,
          run_id text, user_message_id text, task_ref text, commit_sha text, branch text,
          path text, symbol text,
          detached integer not null default 0 check (detached in (0,1)),
          external_reference_json text
        );
        insert into project_memory_evidence_replacement
          (id,memory_id,kind,session_id,run_id,user_message_id,task_ref,commit_sha,branch,path,symbol,detached)
          select id,memory_id,kind,session_id,run_id,user_message_id,task_ref,commit_sha,branch,path,symbol,detached
          from project_memory_evidence;
        drop table project_memory_evidence;
        alter table project_memory_evidence_replacement rename to project_memory_evidence;
        create index idx_project_memory_evidence_memory on project_memory_evidence(memory_id);
        create index idx_project_memory_evidence_session on project_memory_evidence(session_id);
        create trigger trg_detach_project_memory_before_session_delete
        before delete on agent_sessions begin
          update project_memory_evidence
          set session_id = null, run_id = null, user_message_id = null, detached = 1
          where session_id = old.id
            or run_id in (select id from agent_runs where session_id = old.id)
            or user_message_id in (select user_message_id from agent_runs
              where session_id = old.id and user_message_id is not null);
        end;`);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }

  db.exec(`
    create table if not exists project_model_edges (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      revision text not null,
      from_path text not null,
      to_path text not null,
      kind text not null check (kind in ('discovery','changed','depends')),
      source text not null check (source in ('codegraph','git','checkpoint')),
      updated_at text not null
    );
    create index if not exists idx_project_model_edges_workspace_revision
      on project_model_edges(workspace_id, revision, updated_at desc);

    create table if not exists project_model_snapshots (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      revision text not null,
      estimate_json text not null,
      updated_at text not null
    );
    create index if not exists idx_project_model_snapshots_workspace
      on project_model_snapshots(workspace_id, updated_at desc);

    create table if not exists harness_failure_blacklist (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      signature text not null,
      strategy_code text not null,
      hypothesis_code text,
      hit_count integer not null default 1,
      first_seen_at text not null,
      last_seen_at text not null,
      expires_at text not null,
      status text not null check (status in ('active','cleared','expired')),
      source_run_id text
    );
    create index if not exists idx_harness_failure_blacklist_workspace_status
      on harness_failure_blacklist(workspace_id, status, expires_at);

    create table if not exists harness_promotions (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      insight_id text not null,
      kind text not null,
      claim text not null,
      recommendation text not null,
      confidence text not null,
      sample_count integer not null,
      status text not null check (status in ('proposed','validated','promoted','rejected','expired')),
      evidence_run_ids_json text not null,
      created_at text not null,
      updated_at text not null,
      promoted_at text,
      rejected_at text,
      rejection_reason text
    );
    create index if not exists idx_harness_promotions_workspace_status
      on harness_promotions(workspace_id, status, updated_at desc);
  `);

  // Agent Groups: rooms of normal agent_sessions. A null workspace_id means the
  // group has no Project (members then live in the Chats inbox workspace).
  // Deleting a group never deletes the member sessions themselves.
  db.exec(`
    create table if not exists agent_groups (
      id text primary key,
      name text not null,
      workspace_id text references workspaces(id) on delete cascade,
      mode text not null default 'coordinator' check (mode in ('free','coordinator')),
      lead_session_id text references agent_sessions(id) on delete set null,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists idx_agent_groups_workspace
      on agent_groups(workspace_id, updated_at desc);

    create table if not exists agent_group_members (${MEMBERS_TABLE_BODY});

    create table if not exists group_messages (
      id text primary key,
      group_id text not null references agent_groups(id) on delete cascade,
      author_kind text not null check (author_kind in ('user','agent','system')),
      author_session_id text references agent_sessions(id) on delete set null,
      reply_to_message_id text references group_messages(id) on delete set null,
      to_session_id text,
      chain_id text references group_messages(id) on delete set null,
      kind text not null default 'message' check (kind in ('message','status')),
      body text not null,
      mentions_json text not null default '[]',
      created_at text not null
    );
    drop index if exists idx_group_messages_group_created;
    create index if not exists idx_group_messages_group_created_id
      on group_messages(group_id, created_at, id);

    create table if not exists group_tasks (
      id text primary key,
      group_id text not null references agent_groups(id) on delete cascade,
      title text not null,
      description text,
      status text not null default 'open' check (status in ('open','in_progress','in_review','done','cancelled')),
      owner_session_id text references agent_sessions(id) on delete set null,
      created_by_session_id text references agent_sessions(id) on delete set null,
      reviewer_session_id text references agent_sessions(id) on delete set null,
      branch text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists idx_group_tasks_group_status
      on group_tasks(group_id, status, updated_at desc);

    create table if not exists group_decisions (
      id text primary key,
      group_id text not null references agent_groups(id) on delete cascade,
      text text not null,
      author_session_id text references agent_sessions(id) on delete set null,
      source_message_id text references group_messages(id) on delete set null,
      created_at text not null
    );
  `);
  migrateLegacyGroupDecisions(db);
  db.exec(`create index if not exists idx_group_decisions_group_created
    on group_decisions(group_id, created_at);`);

  // Agents model: an agent is its own entity (persona, defaults) and belongs to
  // exactly ONE group (A2): agents.group_id, names unique per group. Group
  // members point at it through agent_group_members.agent_id (unique: 1:1);
  // the room runtime stays keyed by the member's session_id.
  db.exec(`create table if not exists agents (${AGENTS_TABLE_BODY});`);
  // Membership migrations may temporarily reassign an agent before the N6
  // normalization runs. Remove the final-write guards while migrating, then
  // migrateAgentAvatarShapesN6 restores them after all group links are stable.
  db.exec(`drop trigger if exists agents_group_avatar_shape_unique_insert;
    drop trigger if exists agents_group_avatar_shape_unique_update;
    drop index if exists idx_agents_group_avatar_shape;`);
  migrateGroupMembersToAgents(db);
  migrateMembershipByAgent(db);
  migrateAgentsToOneGroup(db);
  migrateAgentAvatarsN5(db);
  migrateAgentAvatarShapesN6(db);
  // A3: an agent's 1:1 chat is a normal 'chat' session in its group's Project,
  // linked by agent_id (at most one per agent, made on first open). Deleting
  // the agent (with its group) only unlinks the row: the caller then runs the
  // full session teardown (runtime, subagents, checkpoints) after the commit.
  addColumn(db, "agent_sessions", "agent_id", "text references agents(id) on delete set null");
  db.exec(`create unique index if not exists idx_agent_sessions_agent_chat
    on agent_sessions(agent_id) where agent_id is not null`);
  // Group room Prompt Kit file upload: image + context payloads on user messages.
  addColumn(db, "group_messages", "attachments_json", "text");
  addColumn(db, "group_messages", "context_items_json", "text");

  for (const [column, type] of [
    ["turn_id", "text"],
    ["run_id", "text"],
    ["sdk_message_id", "text"],
    ["sequence", "integer"],
    ["status", "text"],
    ["updated_at", "text"],
    ["error", "text"],
  ] as const)
    addColumn(db, "group_messages", column, type);
  db.exec(`
    with ordered as (
      select id, row_number() over (partition by group_id order by created_at, id) as position
      from group_messages
    )
    update group_messages set sequence = (select position from ordered where ordered.id = group_messages.id)
    where sequence is null;
    create unique index if not exists idx_group_messages_sequence on group_messages(group_id, sequence);
    create index if not exists idx_group_messages_turn on group_messages(turn_id);
    create table if not exists group_execution_chains (
      id text primary key references group_messages(id) on delete cascade,
      group_id text not null references agent_groups(id) on delete cascade,
      state_json text not null,
      updated_at text not null
    );
    create table if not exists group_jobs (
      id text primary key,
      group_id text not null references agent_groups(id) on delete cascade,
      session_id text not null references agent_sessions(id) on delete cascade,
      chain_id text not null references group_execution_chains(id) on delete cascade,
      trigger_message_id text not null references group_messages(id) on delete cascade,
      message_id text not null references group_messages(id) on delete cascade,
      seq integer not null,
      prompt text not null,
      status text not null check (status in ('pending','running','awaiting_user','completed','failed','cancelled','interrupted')),
      error text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists idx_group_jobs_pending on group_jobs(status, seq);
  `);
  // Ask-spanning execution link (goal item 4): tasks/decisions share message chainId.
  addColumn(db, "group_tasks", "execution_id", "text");
  addColumn(db, "group_decisions", "execution_id", "text");
  db.exec(`
    create index if not exists idx_group_tasks_execution
      on group_tasks(group_id, execution_id);
    create index if not exists idx_group_decisions_execution
      on group_decisions(group_id, execution_id);
  `);
}

/**
 * `group_id` is nullable in SQL on purpose: legacy agents without a membership
 * keep NULL (see UNGROUPED_AGENT_POLICY); "an agent needs a group" is enforced
 * by IPC (agents:create). Names are unique per group, case-insensitively.
 */
const AGENTS_TABLE_BODY = `
      id text primary key,
      group_id text references agent_groups(id) on delete cascade,
      name text not null collate nocase,
      role text not null default '',
      instructions text not null default '',
      model_id text,
      default_workspace_id text references workspaces(id) on delete set null,
      avatar_face text not null check (avatar_face in (${sqlList(AGENT_AVATAR_FACES)})),
      avatar_color text not null check (avatar_color in (${sqlList(AGENT_AVATAR_COLORS)})),
      avatar_shape text not null check (avatar_shape in (${sqlList(AGENT_AVATAR_SHAPES)})),
      template_id text,
      created_at text not null,
      updated_at text not null,
      archived_at text,
      unique (group_id, name)
    `;
/** Columns copied during agents rebuilds (group_id is filled by assignAgentGroups). */
const AGENT_COPY_COLUMNS = `id, name, role, instructions, model_id, default_workspace_id,
  avatar_face, avatar_color, template_id, created_at, updated_at, archived_at`;

/**
 * Two migration cases are still undecided; both are conservative (nothing is
 * deleted) and each is one switch here:
 * - an agent with NO membership: "keep-null" leaves group_id NULL;
 * - an agent in SEVERAL groups: "split" keeps it in its first group (oldest
 *   joined_at) and makes one copy per other group (new agent id, same
 *   persona), re-pointing that membership to the copy.
 */
export const UNGROUPED_AGENT_POLICY: "keep-null" = "keep-null";
export const MULTI_GROUP_AGENT_POLICY: "split" = "split";

/**
 * A2, idempotent: rebuild `agents` with group_id (when missing), then give
 * every agent the group of its membership (policies above) and enforce 1:1
 * with a unique index on agent_group_members(agent_id). The rebuild drops the
 * parent table of agent_group_members.agent_id, so foreign keys are switched
 * off around it (they cannot change inside a transaction) and checked before
 * the commit.
 */
function migrateAgentsToOneGroup(db: DatabaseSync): void {
  const rebuild = !hasColumn(db, "agents", "group_id");
  const foreignKeys = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
    .foreign_keys;
  if (rebuild) db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("begin");
    try {
      if (rebuild) {
        const hasShape = hasColumn(db, "agents", "avatar_shape");
        db.exec(`create table agents_replacement (${AGENTS_TABLE_BODY});`);
        if (hasShape) {
          db.exec(`insert into agents_replacement (${AGENT_COPY_COLUMNS}, avatar_shape)
            select ${AGENT_COPY_COLUMNS}, avatar_shape from agents;`);
        } else {
          db.exec(`insert into agents_replacement (${AGENT_COPY_COLUMNS}, avatar_shape)
            select ${AGENT_COPY_COLUMNS}, 'circle' from agents;`);
        }
        db.exec(`drop table agents;
          alter table agents_replacement rename to agents;`);
        if (!hasShape) assignDeterministicAvatarShapes(db);
      }
      assignAgentGroups(db);
      db.exec(`create unique index if not exists idx_agent_group_members_agent
        on agent_group_members(agent_id)`);
      if (rebuild && db.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("agents migration left dangling foreign keys");
      }
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  } finally {
    if (rebuild && foreignKeys) db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * N5: add `avatar_shape` and expand `avatar_color` CHECK. Rebuilds the agents
 * table when the shape column is missing (SQLite cannot widen CHECK in place).
 */
function migrateAgentAvatarsN5(db: DatabaseSync): void {
  if (hasColumn(db, "agents", "avatar_shape")) return;
  const foreignKeys = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
    .foreign_keys;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("begin");
    try {
      db.exec(`create table agents_replacement (${AGENTS_TABLE_BODY});
        insert into agents_replacement (
          id, group_id, ${AGENT_COPY_COLUMNS}, avatar_shape
        )
        select id, group_id, ${AGENT_COPY_COLUMNS}, 'circle' from agents;
        drop table agents;
        alter table agents_replacement rename to agents;`);
      assignDeterministicAvatarShapes(db);
      if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("agent avatar migration left dangling foreign keys");
      }
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  } finally {
    if (foreignKeys) db.exec("PRAGMA foreign_keys = ON");
  }
}

/** N6: accept ten silhouettes, repair in-limit collisions and guard future writes. */
function migrateAgentAvatarShapesN6(db: DatabaseSync): void {
  const schema = db
    .prepare("select sql from sqlite_master where type = 'table' and name = 'agents'")
    .get() as { sql: string } | undefined;
  const rebuild =
    !schema || AGENT_AVATAR_SHAPES.some((shape) => !schema.sql.includes(`'${shape}'`));
  const indexExists =
    db
      .prepare(
        "select 1 from sqlite_master where type = 'index' and name = 'idx_agents_group_avatar_shape'",
      )
      .get() !== undefined;
  const triggerCount = (
    db
      .prepare(
        `select count(*) as count from sqlite_master where type = 'trigger'
         and name in ('agents_group_avatar_shape_unique_insert', 'agents_group_avatar_shape_unique_update')`,
      )
      .get() as { count: number }
  ).count;
  if (!rebuild && !indexExists && triggerCount === 2) return;

  const foreignKeys = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
    .foreign_keys;
  if (rebuild) db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("begin");
    try {
      if (rebuild) {
        db.exec(`create table agents_replacement (${AGENTS_TABLE_BODY});
          insert into agents_replacement (group_id, ${AGENT_COPY_COLUMNS}, avatar_shape)
            select group_id, ${AGENT_COPY_COLUMNS}, avatar_shape from agents;
          drop table agents;
          alter table agents_replacement rename to agents;`);
      }
      if (indexExists) db.exec("drop index idx_agents_group_avatar_shape");
      normalizeGroupedAvatarShapes(db);
      db.exec(`create trigger if not exists agents_group_avatar_shape_unique_insert
        before insert on agents
        when new.group_id is not null
          and (select count(*) from agents where group_id = new.group_id) < 10
          and exists (select 1 from agents where group_id = new.group_id and avatar_shape = new.avatar_shape)
        begin
          select raise(abort, 'UNIQUE constraint failed: agents.group_id, agents.avatar_shape');
        end;
        create trigger if not exists agents_group_avatar_shape_unique_update
        before update of group_id, avatar_shape on agents
        when new.group_id is not null
          and (select count(*) from agents where group_id = new.group_id) <= 10
          and exists (select 1 from agents where group_id = new.group_id and avatar_shape = new.avatar_shape and id <> new.id)
        begin
          select raise(abort, 'UNIQUE constraint failed: agents.group_id, agents.avatar_shape');
        end;`);
      if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("agent avatar-shape migration left dangling foreign keys");
      }
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  } finally {
    if (rebuild && foreignKeys) db.exec("PRAGMA foreign_keys = ON");
  }
}

function normalizeGroupedAvatarShapes(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `select a.id, a.group_id, a.avatar_shape
       from agents a left join agent_group_members m on m.agent_id = a.id
       where a.group_id is not null
       order by a.group_id, case when m.agent_id is null then 1 else 0 end,
         m.joined_at, m.rowid, a.id`,
    )
    .all() as Array<{
    id: string;
    group_id: string;
    avatar_shape: (typeof AGENT_AVATAR_SHAPES)[number];
  }>;
  const byGroup = new Map<string, typeof rows>();
  for (const row of rows) {
    const members = byGroup.get(row.group_id) ?? [];
    members.push(row);
    byGroup.set(row.group_id, members);
  }

  const update = db.prepare("update agents set avatar_shape = ? where id = ?");
  for (const members of byGroup.values()) {
    // Old app builds could leave groups over the current 10-member limit. Keep
    // those extra rows intact; there are only ten shapes to assign uniquely.
    const inLimitMembers = members.slice(0, AGENT_AVATAR_SHAPES.length);
    const allocated = allocateUniqueGroupAvatarShapes(
      inLimitMembers.map(({ id, avatar_shape }) => ({ agentId: id, preferredShape: avatar_shape })),
    );
    for (const member of inLimitMembers) {
      const shape = allocated.get(member.id);
      if (shape && shape !== member.avatar_shape) update.run(shape, member.id);
    }
  }
}

function assignDeterministicAvatarShapes(db: DatabaseSync): void {
  const rows = db.prepare("select id from agents").all() as Array<{ id: string }>;
  const update = db.prepare("update agents set avatar_shape = ? where id = ?");
  for (const row of rows) {
    update.run(agentAvatarForId(row.id).avatarShape, row.id);
  }
}

/** Sets agents.group_id from memberships (the caller owns the transaction). */
function assignAgentGroups(db: DatabaseSync): void {
  const memberships = db
    .prepare(
      `select m.agent_id, m.group_id, m.session_id from agent_group_members m
       join agents a on a.id = m.agent_id
       where a.group_id is null or a.group_id <> m.group_id
          or (select count(*) from agent_group_members o where o.agent_id = m.agent_id) > 1
       order by m.agent_id, m.joined_at, m.rowid`,
    )
    .all() as Array<{ agent_id: string; group_id: string; session_id: string }>;
  const byAgent = new Map<string, Array<{ group_id: string; session_id: string }>>();
  for (const row of memberships) {
    const list = byAgent.get(row.agent_id) ?? [];
    list.push(row);
    byAgent.set(row.agent_id, list);
  }
  const setGroup = db.prepare("update agents set group_id = ? where id = ?");
  const hasShape = hasColumn(db, "agents", "avatar_shape");
  const copy = db.prepare(
    hasShape
      ? `insert into agents (id, group_id, name, role, instructions, model_id, default_workspace_id,
           avatar_face, avatar_color, avatar_shape, template_id, created_at, updated_at, archived_at)
         select ?, ?, name, role, instructions, model_id, default_workspace_id,
           avatar_face, avatar_color, avatar_shape, template_id, created_at, updated_at, archived_at
         from agents where id = ?`
      : `insert into agents (id, group_id, name, role, instructions, model_id, default_workspace_id,
           avatar_face, avatar_color, template_id, created_at, updated_at, archived_at)
         select ?, ?, name, role, instructions, model_id, default_workspace_id,
           avatar_face, avatar_color, template_id, created_at, updated_at, archived_at
         from agents where id = ?`,
  );
  const repoint = db.prepare(
    "update agent_group_members set agent_id = ? where group_id = ? and session_id = ?",
  );
  for (const [agentId, rows] of byAgent) {
    const [first, ...others] = rows;
    if (!first) continue;
    setGroup.run(first.group_id, agentId);
    if (MULTI_GROUP_AGENT_POLICY !== "split") continue;
    for (const row of others) {
      const id = randomUUID();
      copy.run(id, row.group_id, agentId);
      repoint.run(id, row.group_id, row.session_id);
    }
  }
  // UNGROUPED_AGENT_POLICY "keep-null": agents without a membership are left as is.
}

/** Next free agent name in a group: "Jennie", then "Jennie 2", "Jennie 3" (case-insensitive). */
export function uniqueAgentName(db: DatabaseSync, base: string, groupId?: string): string {
  // Names are unique per group (A2). Without a group (migrations, legacy
  // agents) the check is global, which also works on the A1 table shape.
  const taken =
    groupId === undefined
      ? db.prepare("select 1 from agents where name = ?")
      : db.prepare("select 1 from agents where name = ? and group_id = ?");
  const isTaken = (name: string) =>
    (groupId === undefined ? taken.get(name) : taken.get(name, groupId)) !== undefined;
  let name = base;
  for (let suffix = 2; isTaken(name); suffix += 1) {
    name = `${base} ${suffix}`;
  }
  return name;
}

/**
 * Membership by agent (A2): one row per group+agent pair, whose `session_id`
 * is that pair's hidden room session (kind 'group_member'). Everything in the
 * room runtime stays keyed by session_id.
 */
const MEMBERS_TABLE_BODY = `
      group_id text not null references agent_groups(id) on delete cascade,
      session_id text not null unique references agent_sessions(id) on delete cascade,
      role text,
      joined_at text not null,
      agent_id text not null references agents(id) on delete cascade,
      primary key (group_id, session_id),
      unique (group_id, agent_id)
    `;

/**
 * Every member row with a NULL agent_id becomes its own agent, named after its
 * session title (deduped, "Agent" when blank) with empty role/instructions and
 * a face/color derived from its id. The member keeps its session, so the room
 * history is preserved. Idempotent (only NULL rows); the caller owns the
 * transaction.
 */
function backfillMemberAgents(db: DatabaseSync): void {
  const members = db
    .prepare(
      `select m.group_id, m.session_id, trim(coalesce(s.title, '')) as title
       from agent_group_members m join agent_sessions s on s.id = m.session_id
       where m.agent_id is null
       order by m.joined_at, m.rowid`,
    )
    .all() as Array<{ group_id: string; session_id: string; title: string }>;
  const hasShape = hasColumn(db, "agents", "avatar_shape");
  const insertAgent = db.prepare(
    hasShape
      ? `insert into agents (id, name, avatar_face, avatar_color, avatar_shape, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`
      : `insert into agents (id, name, avatar_face, avatar_color, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
  );
  const link = db.prepare(
    "update agent_group_members set agent_id = ? where group_id = ? and session_id = ?",
  );
  const now = new Date().toISOString();
  for (const member of members) {
    const id = randomUUID();
    const { avatarFace, avatarColor, avatarShape } = agentAvatarForId(id);
    const name = uniqueAgentName(db, member.title || "Agent");
    if (hasShape) insertAgent.run(id, name, avatarFace, avatarColor, avatarShape, now, now);
    else insertAgent.run(id, name, avatarFace, avatarColor, now, now);
    link.run(id, member.group_id, member.session_id);
  }
}

/** A1, one-shot (runs when agent_group_members gains agent_id): link every member to an agent. */
function migrateGroupMembersToAgents(db: DatabaseSync): void {
  if (hasColumn(db, "agent_group_members", "agent_id")) return;
  db.exec("begin");
  try {
    addColumn(
      db,
      "agent_group_members",
      "agent_id",
      "text references agents(id) on delete set null",
    );
    backfillMemberAgents(db);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/**
 * A2, idempotent, one transaction: backfill any member still without an agent
 * (e.g. added between A1 and A2), mark every member session 'group_member'
 * (it stays in the group's Project), then rebuild the table with agent_id NOT
 * NULL and unique (group_id, agent_id). Finally drop hidden room sessions left
 * without a membership (a teardown interrupted by a crash).
 */
function migrateMembershipByAgent(db: DatabaseSync): void {
  const agentColumn = (
    db.prepare("PRAGMA table_info(agent_group_members)").all() as Array<{
      name: string;
      notnull: number;
    }>
  ).find((column) => column.name === "agent_id");
  db.exec("begin");
  try {
    backfillMemberAgents(db);
    db.exec(`update agent_sessions set kind = 'group_member'
      where kind = 'chat' and id in (select session_id from agent_group_members)`);
    if (agentColumn?.notnull !== 1) {
      db.exec(`create table agent_group_members_replacement (${MEMBERS_TABLE_BODY});
        insert into agent_group_members_replacement (group_id, session_id, role, joined_at, agent_id)
          select group_id, session_id, role, joined_at, agent_id from agent_group_members;
        drop table agent_group_members;
        alter table agent_group_members_replacement rename to agent_group_members;`);
    }
    db.exec(`delete from agent_sessions where kind = 'group_member'
      and id not in (select session_id from agent_group_members)`);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/**
 * PR 6: group_decisions briefly had created_by_session_id / superseded_by_id
 * (never written by the app). Rebuild it in the shared-context shape, keeping
 * only active rows; the author carries over.
 */
function migrateLegacyGroupDecisions(db: DatabaseSync): void {
  if (!hasColumn(db, "group_decisions", "superseded_by_id")) return;
  db.exec("begin");
  try {
    db.exec(`create table group_decisions_replacement (
        id text primary key,
        group_id text not null references agent_groups(id) on delete cascade,
        text text not null,
        author_session_id text references agent_sessions(id) on delete set null,
        source_message_id text references group_messages(id) on delete set null,
        created_at text not null
      );
      insert into group_decisions_replacement
        (id, group_id, text, author_session_id, source_message_id, created_at)
        select id, group_id, text, created_by_session_id, source_message_id, created_at
        from group_decisions where superseded_by_id is null;
      drop table group_decisions;
      alter table group_decisions_replacement rename to group_decisions;`);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function getDatabase(): DatabaseSync {
  if (database) {
    return database;
  }

  const dbPath = join(app.getPath("userData"), "modus.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });

  database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  migrateDatabase(database);

  return database;
}
