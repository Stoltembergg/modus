import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { app } from "electron";

let database: DatabaseSync | undefined;

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
      mode text not null default 'free' check (mode in ('free','coordinator')),
      lead_session_id text references agent_sessions(id) on delete set null,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists idx_agent_groups_workspace
      on agent_groups(workspace_id, updated_at desc);

    create table if not exists agent_group_members (
      group_id text not null references agent_groups(id) on delete cascade,
      session_id text not null unique references agent_sessions(id) on delete cascade,
      role text,
      joined_at text not null,
      primary key (group_id, session_id)
    );

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
      source_message_id text references group_messages(id) on delete set null,
      created_by_session_id text references agent_sessions(id) on delete set null,
      created_at text not null,
      superseded_by_id text references group_decisions(id) on delete set null
    );
    create index if not exists idx_group_decisions_group_created
      on group_decisions(group_id, created_at);
  `);
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
