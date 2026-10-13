import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";

/**
 * Groups → Projects, one-time migration (PLAN-projects-default §2.4–2.5, PR 4a).
 *
 * Every Agent Group becomes history inside its Project:
 * - each agent loses its group (`agents.group_id = NULL`) and becomes a 1:1
 *   profile, names deduped among active profiles;
 * - each hidden room session (`kind = 'group_member'`) becomes a visible,
 *   read-only "(room work)" chat in the group's Project, linked to its agent;
 * - each group gets one read-only "(group room)" chat whose transcript lives in
 *   `migrated_group_transcripts`, with an ordered SHA-256 checksum;
 * - live runs/jobs/integrations are closed.
 * The group tables themselves stay (dropped in PR 9). One transaction, FK off
 * outside it, verified before commit; any mismatch rolls back and leaves every
 * group row untouched. The marker makes it run once.
 *
 * This module is not wired into getDatabase() yet (PR 4b does that, together
 * with removing the Groups UI and bumping KNOWN_DATABASE_VERSION).
 */

export const GROUPS_MIGRATION_MARKER = "migration.groups_to_projects.v1";
export const GROUPS_MIGRATION_ATTEMPTS = `${GROUPS_MIGRATION_MARKER}.attempts`;
export const GROUPS_MIGRATION_LAST_ERROR = `${GROUPS_MIGRATION_MARKER}.last_error`;
export const GROUPS_MIGRATION_USER_VERSION = 1;
export const GROUPS_MIGRATION_MAX_ATTEMPTS = 3;
export const GROUPS_MIGRATION_RUN_ERROR = "Group removed during migration";
const BACKUPS_KEPT = 3;

export type GroupsMigrationCounts = {
  groups: number;
  memberships: number;
  memberSessions: number;
  orphanMemberSessions: number;
  groupedAgents: number;
  agents: number;
  agentChats: number;
  messages: number;
  messagesWithAttachments: number;
  tasks: number;
  decisions: number;
  liveRuns: number;
  liveJobs: number;
  applyingIntegrations: number;
  previews: number;
};

export type GroupsMigrationResult =
  | { status: "skipped"; reason: "done" }
  | {
      status: "done";
      backup: string | null;
      pre: GroupsMigrationCounts;
      post: { transcripts: number; roomWorkChats: number; renamedProfiles: number };
      transcripts: Array<{ groupId: string; sessionId: string; title: string; bodyMd: string }>;
    };

export type GroupsMigrationOptions = {
  /** Path of the backup taken before any group write (stored in the marker). */
  backup?: string | null;
  /** Root path of the folderless "Chats" inbox, used for groups without a Project. */
  inboxRootPath: string;
  now?: () => string;
  /** Test hook: throw right after the named step, inside the transaction. */
  failAfter?: "close-live-work" | "profiles" | "sessions" | "transcripts" | "verify";
  /** Test hook: corrupt a stored transcript checksum before verification. */
  tamperChecksum?: boolean;
};

type Row = Record<string, unknown>;

function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table) !==
    undefined
  );
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function count(db: DatabaseSync, table: string, where = "1 = 1", ...params: string[]): number {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`select count(*) as n from ${table} where ${where}`).get(...params) as {
    n: number;
  };
  return Number(row.n);
}

function readSetting(db: DatabaseSync, key: string): string | undefined {
  if (!tableExists(db, "app_settings")) return undefined;
  const row = db.prepare("select value from app_settings where key = ?").get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? undefined;
}

function writeSetting(db: DatabaseSync, key: string, value: string, now: string): void {
  db.prepare(
    `insert into app_settings (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

/** True once the migration committed. Missing table/key = not done. */
export function isGroupsMigrationDone(db: DatabaseSync): boolean {
  const raw = readSetting(db, GROUPS_MIGRATION_MARKER);
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { status?: string }).status === "done";
  } catch {
    return false;
  }
}

export function groupsMigrationAttempts(db: DatabaseSync): number {
  return Number(readSetting(db, GROUPS_MIGRATION_ATTEMPTS) ?? 0) || 0;
}

/**
 * Read-only probe: marker not done and there is group data (groups, memberships,
 * room sessions or room messages). A table that does not exist yet counts as
 * empty, so a brand-new database is never "pending".
 */
export function isGroupsMigrationPending(db: DatabaseSync): boolean {
  if (isGroupsMigrationDone(db)) return false;
  for (const table of ["agent_groups", "agent_group_members", "group_messages"]) {
    if (count(db, table) > 0) return true;
  }
  return (
    tableExists(db, "agent_sessions") &&
    hasColumn(db, "agent_sessions", "kind") &&
    count(db, "agent_sessions", "kind = 'group_member'") > 0
  );
}

/**
 * VACUUM INTO `<dir>/modus-<ts>-pre-groups.db`, checked with integrity_check,
 * keeping the newest three. Runs outside any transaction; throws before any
 * write to the live database if the copy is bad.
 */
export function backupBeforeGroupsMigration(
  db: DatabaseSync,
  backupsDir: string,
  open: (path: string) => DatabaseSync,
  now: () => string = () => new Date().toISOString(),
): string {
  mkdirSync(backupsDir, { recursive: true });
  const stamp = now().replace(/[:.]/g, "-");
  const path = join(backupsDir, `modus-${stamp}-pre-groups.db`);
  db.prepare("VACUUM INTO ?").run(path);
  const copy = open(path);
  try {
    const row = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (row.integrity_check !== "ok") {
      throw new Error(`Backup integrity check failed: ${row.integrity_check}`);
    }
  } finally {
    copy.close();
  }
  const old = readdirSync(backupsDir)
    .filter((name) => /^modus-.*-pre-groups\.db$/.test(name))
    .sort()
    .reverse()
    .slice(BACKUPS_KEPT);
  for (const name of old) rmSync(join(backupsDir, name), { force: true });
  return path;
}

type MessageRow = {
  id: string;
  author_kind: string;
  author_session_id: string | null;
  author_name: string | null;
  kind: string;
  body: string;
  attachments_json: string | null;
  context_items_json: string | null;
  created_at: string;
};

/** Ordered hash over (id, body, attachments) — plan §2.5 step 4. */
export function hashGroupMessages(
  rows: Iterable<{ id: string; body: string; attachments_json: string | null }>,
): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(`${row.id}\x1f${row.body}\x1f${row.attachments_json ?? ""}\x1e`);
  }
  return hash.digest("hex");
}

function groupMessages(db: DatabaseSync, groupId: string): MessageRow[] {
  const ac = hasColumn(db, "group_messages", "attachments_json") ? "m.attachments_json" : "null";
  const cc = hasColumn(db, "group_messages", "context_items_json")
    ? "m.context_items_json"
    : "null";
  return db
    .prepare(
      `select m.id, m.author_kind, m.author_session_id, m.kind, m.body,
              ${ac} as attachments_json, ${cc} as context_items_json, m.created_at,
              coalesce(a.name, s.title) as author_name
         from group_messages m
         left join agent_group_members gm on gm.session_id = m.author_session_id
         left join agents a on a.id = gm.agent_id
         left join agent_sessions s on s.id = m.author_session_id
        where m.group_id = ?
        order by m.created_at, m.id`,
    )
    .all(groupId) as MessageRow[];
}

function preCounts(db: DatabaseSync): GroupsMigrationCounts {
  const memberSessions = count(db, "agent_sessions", "kind = 'group_member'");
  const orphan = tableExists(db, "agent_group_members")
    ? count(
        db,
        "agent_sessions",
        "kind = 'group_member' and id not in (select session_id from agent_group_members)",
      )
    : memberSessions;
  return {
    groups: count(db, "agent_groups"),
    memberships: count(db, "agent_group_members"),
    memberSessions,
    orphanMemberSessions: orphan,
    groupedAgents: count(db, "agents", "group_id is not null"),
    agents: count(db, "agents"),
    agentChats: count(db, "agent_sessions", "kind = 'chat' and agent_id is not null"),
    messages: count(db, "group_messages"),
    messagesWithAttachments: hasColumn(db, "group_messages", "attachments_json")
      ? count(db, "group_messages", "attachments_json is not null and attachments_json <> '[]'")
      : 0,
    tasks: count(db, "group_tasks"),
    decisions: count(db, "group_decisions"),
    liveRuns: count(
      db,
      "agent_runs",
      "status in ('running','blocked') and session_id in (select id from agent_sessions where kind = 'group_member')",
    ),
    liveJobs: count(db, "group_jobs", "status in ('pending','running','awaiting_user')"),
    applyingIntegrations: count(db, "group_task_integrations", "status = 'applying'"),
    previews: count(db, "group_integration_previews"),
  };
}

function nextFreeName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Plan §2.5. Throws (after rollback) on any failure; the caller decides about retries. */
export function migrateGroupsToProjects(
  db: DatabaseSync,
  options: GroupsMigrationOptions,
): GroupsMigrationResult {
  if (isGroupsMigrationDone(db)) return { status: "skipped", reason: "done" };
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();

  // Retry bookkeeping lives outside the transaction so it survives a rollback.
  writeSetting(db, GROUPS_MIGRATION_ATTEMPTS, String(groupsMigrationAttempts(db) + 1), startedAt);

  const fkRow = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  const fkWasOn = Number(fkRow.foreign_keys) === 1;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("begin immediate");
    try {
      const result = runInTransaction(db, options, now);
      db.exec("commit");
      return result;
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  } catch (error) {
    writeSetting(
      db,
      GROUPS_MIGRATION_LAST_ERROR,
      error instanceof Error ? error.message : String(error),
      now(),
    );
    throw error;
  } finally {
    if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
  }
}

function runInTransaction(
  db: DatabaseSync,
  options: GroupsMigrationOptions,
  now: () => string,
): GroupsMigrationResult {
  const at = now();
  const fail = (step: NonNullable<GroupsMigrationOptions["failAfter"]>) => {
    if (options.failAfter === step) throw new Error(`Forced failure after ${step}`);
  };
  const pre = preCounts(db);
  const hasGroups = tableExists(db, "agent_groups");

  type GroupRow = { id: string; name: string; workspace_id: string | null; created_at: string };
  const groups = hasGroups
    ? (db
        .prepare(
          "select id, name, workspace_id, created_at from agent_groups order by created_at, id",
        )
        .all() as GroupRow[])
    : [];
  const preHashes = new Map(groups.map((g) => [g.id, hashGroupMessages(groupMessages(db, g.id))]));
  const summaries = new Map<string, string[]>(groups.map((g) => [g.id, []]));
  const note = (groupId: string | null, line: string) => {
    if (groupId) summaries.get(groupId)?.push(line);
  };

  // a. Close dangling work.
  const memberGroup = new Map<string, string>();
  if (tableExists(db, "agent_group_members")) {
    for (const r of db
      .prepare("select session_id, group_id from agent_group_members")
      .all() as Row[]) {
      memberGroup.set(String(r.session_id), String(r.group_id));
    }
  }
  const liveRuns = db
    .prepare(
      `select r.id, r.session_id from agent_runs r join agent_sessions s on s.id = r.session_id
        where s.kind = 'group_member' and r.status in ('running','blocked')`,
    )
    .all() as Array<{ id: string; session_id: string }>;
  const cancelRun = db.prepare(
    "update agent_runs set status = 'cancelled', completed_at = ?, error = ? where id = ?",
  );
  for (const run of liveRuns) {
    cancelRun.run(at, GROUPS_MIGRATION_RUN_ERROR, run.id);
    note(memberGroup.get(run.session_id) ?? null, `- Run ${run.id} was cancelled.`);
  }
  if (tableExists(db, "group_jobs")) {
    const jobs = db
      .prepare(
        "select id, group_id from group_jobs where status in ('pending','running','awaiting_user')",
      )
      .all() as Array<{ id: string; group_id: string }>;
    const cancel = db.prepare(
      "update group_jobs set status = 'cancelled', updated_at = ? where id = ?",
    );
    for (const job of jobs) {
      cancel.run(at, job.id);
      note(job.group_id, `- Job ${job.id} was cancelled.`);
    }
  }
  if (tableExists(db, "group_task_integrations")) {
    const rows = db
      .prepare("select id, group_id from group_task_integrations where status = 'applying'")
      .all() as Array<{ id: string; group_id: string }>;
    const abort = db.prepare(
      "update group_task_integrations set status = 'aborted', updated_at = ? where id = ?",
    );
    for (const row of rows) {
      abort.run(at, row.id);
      note(row.group_id, `- Integration ${row.id} was being applied and was aborted.`);
    }
  }
  if (tableExists(db, "group_integration_previews")) {
    for (const r of db
      .prepare("select group_id, count(*) as n from group_integration_previews group by group_id")
      .all() as Array<{ group_id: string; n: number }>) {
      note(r.group_id, `- ${r.n} integration preview(s) were discarded.`);
    }
  }
  fail("close-live-work");

  // b. Agents → profiles (no rebuild): dedupe, ungroup, unique index.
  let renamedProfiles = 0;
  if (tableExists(db, "agents") && hasColumn(db, "agents", "group_id")) {
    // Pre-existing standalone profiles may already clash among themselves
    // (even case-only: "Coder" / "coder"). Dedupe them first, oldest keeps its
    // name, so the unique index below can always be created.
    const taken = new Set<string>();
    const rename = db.prepare("update agents set name = ?, updated_at = ? where id = ?");
    const standalone = db
      .prepare(
        `select id, name from agents where group_id is null and archived_at is null
          order by created_at, id`,
      )
      .all() as Array<{ id: string; name: string }>;
    // Pass 1: the oldest holder of each name keeps it. Pass 2: the others get
    // the first free " 2", " 3"… that no kept name uses.
    const clashing: Array<{ id: string; name: string }> = [];
    for (const profile of standalone) {
      if (taken.has(profile.name.toLowerCase())) clashing.push(profile);
      else taken.add(profile.name.toLowerCase());
    }
    for (const profile of clashing) {
      const name = nextFreeName(profile.name, taken);
      rename.run(name, at, profile.id);
      renamedProfiles += 1;
      taken.add(name.toLowerCase());
    }
    const grouped = db
      .prepare(
        `select a.id, a.name, g.name as group_name from agents a
           join agent_groups g on g.id = a.group_id
          where a.archived_at is null
          order by g.created_at, g.id, a.created_at, a.id`,
      )
      .all() as Array<{ id: string; name: string; group_name: string }>;
    for (const agent of grouped) {
      let name = agent.name;
      if (taken.has(name.toLowerCase())) {
        name = nextFreeName(`${agent.name} (${agent.group_name})`, taken);
        rename.run(name, at, agent.id);
        renamedProfiles += 1;
      }
      taken.add(name.toLowerCase());
    }
    // Archived agents keep their name and are outside the index; restoring one
    // whose name is taken auto-renames it (agents-store setAgentArchived, PR 3).
    db.exec("update agents set group_id = null where group_id is not null");
    db.exec(`create unique index if not exists idx_agents_profile_name
      on agents(lower(name)) where group_id is null and archived_at is null`);
  }
  fail("profiles");

  // c. Room sessions → read-only "(room work)" chats.
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const memberRows = tableExists(db, "agent_group_members")
    ? (db
        .prepare(
          `select m.session_id, m.group_id, m.agent_id, a.name as agent_name
             from agent_group_members m left join agents a on a.id = m.agent_id`,
        )
        .all() as Array<{
        session_id: string;
        group_id: string;
        agent_id: string;
        agent_name: string | null;
      }>)
    : [];
  const convert = db.prepare(
    `update agent_sessions set kind = 'chat', read_only = 1, agent_id = ?,
       migrated_from_group_id = ?, title = ?, updated_at = ? where id = ? and kind = 'group_member'`,
  );
  let roomWorkChats = 0;
  for (const m of memberRows) {
    const group = groupById.get(m.group_id);
    const title = `${m.agent_name ?? "Agent"} · ${group?.name ?? "Group"} (room work)`;
    roomWorkChats += Number(convert.run(m.agent_id, m.group_id, title, at, m.session_id).changes);
  }
  const orphans = db
    .prepare("select id, title from agent_sessions where kind = 'group_member'")
    .all() as Array<{ id: string; title: string }>;
  const convertOrphan = db.prepare(
    `update agent_sessions set kind = 'chat', read_only = 1, title = ?, updated_at = ? where id = ?`,
  );
  for (const o of orphans) {
    convertOrphan.run(`${o.title} (room work)`, at, o.id);
    roomWorkChats += 1;
  }
  // Existing 1:1 chats of former members: tag them (display only).
  db.prepare(
    `update agent_sessions set migrated_from_group_id = (
        select m.group_id from agent_group_members m where m.agent_id = agent_sessions.agent_id limit 1)
      where kind = 'chat' and read_only = 0 and agent_id is not null and migrated_from_group_id is null
        and agent_id in (select agent_id from agent_group_members)`,
  ).run();
  fail("sessions");

  // Transcript per group.
  const ensureInbox = () => {
    const row = db
      .prepare("select root_path from workspaces where id = ?")
      .get(CHATS_WORKSPACE_ID) as { root_path: string } | undefined;
    if (row) return row.root_path;
    db.prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, 'Chats', 0, ?, ?)`,
    ).run(CHATS_WORKSPACE_ID, options.inboxRootPath, at, at);
    return options.inboxRootPath;
  };
  const insertSession = db.prepare(
    `insert into agent_sessions (id, workspace_id, title, cwd, status, kind, read_only,
       migrated_from_group_id, created_at, updated_at)
     values (?, ?, ?, ?, 'idle', 'chat', 1, ?, ?, ?)`,
  );
  const insertTranscript = db.prepare(
    `insert into migrated_group_transcripts (session_id, group_id, body_md, messages_json, checksum, created_at)
     values (?, ?, ?, ?, ?, ?)`,
  );
  const hasTranscript = db.prepare("select 1 from migrated_group_transcripts where group_id = ?");
  const transcripts: Array<{ groupId: string; sessionId: string; title: string; bodyMd: string }> =
    [];
  for (const group of groups) {
    if (hasTranscript.get(group.id)) continue;
    let workspaceId = group.workspace_id;
    let cwd: string | undefined;
    if (workspaceId) {
      const ws = db.prepare("select root_path from workspaces where id = ?").get(workspaceId) as
        | { root_path: string }
        | undefined;
      cwd = ws?.root_path;
    }
    if (!workspaceId || cwd === undefined) {
      workspaceId = CHATS_WORKSPACE_ID;
      cwd = ensureInbox();
    }
    const messages = groupMessages(db, group.id);
    const checksum = hashGroupMessages(messages);
    const title = `${group.name} (group room)`;
    const bodyMd = transcriptMarkdown(db, group, messages, summaries.get(group.id) ?? []);
    const sessionId = randomUUID();
    insertSession.run(sessionId, workspaceId, title, cwd, group.id, group.created_at, at);
    insertTranscript.run(
      sessionId,
      group.id,
      bodyMd,
      JSON.stringify(messages),
      options.tamperChecksum ? `x${checksum}` : checksum,
      at,
    );
    transcripts.push({ groupId: group.id, sessionId, title, bodyMd });
  }
  if (hasGroups) {
    if (!hasColumn(db, "agent_groups", "migrated_at")) {
      db.exec("alter table agent_groups add column migrated_at text");
    }
    db.prepare("update agent_groups set migrated_at = ? where migrated_at is null").run(at);
  }
  fail("transcripts");

  // e. Verify before commit.
  const problems: string[] = [];
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  if (fk.length > 0) problems.push(`foreign_key_check: ${fk.length} row(s)`);
  if (count(db, "agent_sessions", "kind = 'group_member'") !== 0) {
    problems.push("group_member sessions left");
  }
  const badMember = memberRows.filter((m) => {
    const s = db
      .prepare("select kind, read_only, agent_id, workspace_id from agent_sessions where id = ?")
      .get(m.session_id) as Row | undefined;
    return !s || s.kind !== "chat" || Number(s.read_only) !== 1 || s.agent_id !== m.agent_id;
  });
  if (badMember.length > 0) problems.push(`${badMember.length} room session(s) not converted`);
  if (roomWorkChats !== pre.memberSessions) {
    problems.push(`room work chats ${roomWorkChats} != member sessions ${pre.memberSessions}`);
  }
  const stored = db
    .prepare("select group_id, messages_json, checksum from migrated_group_transcripts")
    .all() as Array<{ group_id: string; messages_json: string; checksum: string }>;
  const byGroup = new Map(stored.map((t) => [t.group_id, t]));
  let attachments = 0;
  for (const group of groups) {
    const t = byGroup.get(group.id);
    if (!t) {
      problems.push(`no transcript for group ${group.id}`);
      continue;
    }
    const parsed = JSON.parse(t.messages_json) as MessageRow[];
    attachments += parsed.filter(
      (m) => m.attachments_json !== null && m.attachments_json !== "[]",
    ).length;
    const recomputed = hashGroupMessages(parsed);
    if (recomputed !== t.checksum || recomputed !== preHashes.get(group.id)) {
      problems.push(`checksum mismatch for group ${group.id}`);
    }
  }
  if (attachments !== pre.messagesWithAttachments) {
    problems.push(`attachments ${attachments} != ${pre.messagesWithAttachments}`);
  }
  if (count(db, "agents") !== pre.agents) problems.push("agents count changed");
  if (tableExists(db, "agents") && hasColumn(db, "agents", "group_id")) {
    if (count(db, "agents", "group_id is not null") !== 0) problems.push("agents still grouped");
    const dupes = db
      .prepare(
        `select count(*) as n from (select lower(name) from agents
          where group_id is null and archived_at is null group by lower(name) having count(*) > 1)`,
      )
      .get() as { n: number };
    if (Number(dupes.n) !== 0) problems.push("duplicate profile names");
  }
  fail("verify");
  if (problems.length > 0) {
    throw new Error(`Groups → Projects verification failed: ${problems.join("; ")}`);
  }

  // f. Marker + schema version, inside the same transaction.
  const post = { transcripts: transcripts.length, roomWorkChats, renamedProfiles };
  writeSetting(
    db,
    GROUPS_MIGRATION_MARKER,
    JSON.stringify({ status: "done", at, backup: options.backup ?? null, pre, post }),
    at,
  );
  db.exec(`PRAGMA user_version = ${GROUPS_MIGRATION_USER_VERSION}`);
  return { status: "done", backup: options.backup ?? null, pre, post, transcripts };
}

function transcriptMarkdown(
  db: DatabaseSync,
  group: { id: string; name: string; created_at: string },
  messages: MessageRow[],
  summary: string[],
): string {
  const lines = [
    `# ${group.name} (group room)`,
    "",
    `Migrated from Agent Groups. Created ${group.created_at}.`,
    "",
  ];
  for (const m of messages) {
    const who =
      m.author_kind === "user"
        ? "You"
        : m.author_kind === "system"
          ? "System"
          : (m.author_name ?? "Agent");
    lines.push(`**${who}** · ${m.created_at}`, "", m.body, "");
  }
  if (tableExists(db, "group_tasks")) {
    const tasks = db
      .prepare(
        "select title, status, branch from group_tasks where group_id = ? order by created_at, id",
      )
      .all(group.id) as Array<{ title: string; status: string; branch: string | null }>;
    if (tasks.length > 0) {
      lines.push("## Tasks", "");
      for (const t of tasks)
        lines.push(`- [${t.status}] ${t.title}${t.branch ? ` (branch ${t.branch})` : ""}`);
      lines.push("");
    }
  }
  if (tableExists(db, "group_decisions")) {
    const decisions = db
      .prepare("select text from group_decisions where group_id = ? order by created_at, id")
      .all(group.id) as Array<{ text: string }>;
    if (decisions.length > 0) {
      lines.push("## Decisions", "");
      for (const d of decisions) lines.push(`- ${d.text}`);
      lines.push("");
    }
  }
  const worktrees = db
    .prepare(
      `select distinct s.subagent_worktree_path as path, s.subagent_worktree_branch as branch,
              s.subagent_worktree_base_sha as base
         from agent_sessions s
        where s.subagent_worktree_path is not null
          and (s.migrated_from_group_id = ? or s.parent_session_id in
               (select id from agent_sessions where migrated_from_group_id = ?))`,
    )
    .all(group.id, group.id) as Array<{ path: string; branch: string | null; base: string | null }>;
  if (worktrees.length > 0) {
    lines.push("## Worktrees kept on disk", "");
    for (const w of worktrees)
      lines.push(
        `- ${w.path}${w.branch ? ` (${w.branch}${w.base ? ` from ${w.base.slice(0, 8)}` : ""})` : ""}`,
      );
    lines.push("");
  }
  if (summary.length > 0) lines.push("## Closed during migration", "", ...summary, "");
  return lines.join("\n");
}
