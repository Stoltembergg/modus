import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_FACES,
  AGENT_AVATAR_SHAPES,
  CHATS_WORKSPACE_ID,
} from "../../shared/contracts";

vi.mock("electron", () => ({ app: { getPath: () => tmpdir() } }));

const { migrateDatabase } = await import("./database");
const {
  GROUPS_MIGRATION_ATTEMPTS,
  GROUPS_MIGRATION_RUN_ERROR,
  backupBeforeGroupsMigration,
  groupsMigrationAttempts,
  hashGroupMessages,
  isGroupsMigrationDone,
  isGroupsMigrationPending,
  migrateGroupsToProjects,
} = await import("./groups-to-projects");

let dir: string;
let db: DatabaseSync;
const T = "2026-10-13T09:00:00.000Z";
const opts = () => ({ inboxRootPath: join(dir, "inbox-chats"), now: () => T });

function open(path = join(dir, "modus.sqlite")): DatabaseSync {
  const handle = new DatabaseSync(path);
  handle.exec("PRAGMA foreign_keys = ON");
  migrateDatabase(handle);
  return handle;
}

let seq = 0;
const ts = () => `2026-10-01T00:00:${String(seq++).padStart(2, "0")}.000Z`;

function workspace(id: string): void {
  db.prepare(
    "insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at) values (?, ?, ?, 0, ?, ?)",
  ).run(id, join(dir, id), id, T, T);
}

function session(
  id: string,
  ws: string,
  kind: "chat" | "group_member",
  agentId: string | null = null,
): void {
  db.prepare(
    "insert into agent_sessions (id, workspace_id, title, cwd, status, kind, agent_id, created_at, updated_at) values (?, ?, ?, ?, 'idle', ?, ?, ?, ?)",
  ).run(id, ws, `title ${id}`, join(dir, ws), kind, agentId, T, T);
}

function group(id: string, name: string, ws: string | null): void {
  db.prepare(
    "insert into agent_groups (id, name, workspace_id, mode, created_at, updated_at) values (?, ?, ?, 'free', ?, ?)",
  ).run(id, name, ws, ts(), T);
}

function agent(
  id: string,
  name: string,
  groupId: string | null,
  shape = 0,
  archived = false,
): void {
  db.prepare(
    `insert into agents (id, group_id, name, avatar_face, avatar_color, avatar_shape, created_at, updated_at, archived_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    groupId,
    name,
    String(AGENT_AVATAR_FACES[0]),
    String(AGENT_AVATAR_COLORS[0]),
    String(AGENT_AVATAR_SHAPES[shape % AGENT_AVATAR_SHAPES.length]),
    ts(),
    T,
    archived ? T : null,
  );
}

function member(groupId: string, sessionId: string, agentId: string, ws: string): void {
  session(sessionId, ws, "group_member");
  db.prepare(
    "insert into agent_group_members (group_id, session_id, joined_at, agent_id) values (?, ?, ?, ?)",
  ).run(groupId, sessionId, T, agentId);
}

function message(
  id: string,
  groupId: string,
  body: string,
  author: string | null = null,
  attachments: string | null = null,
): void {
  db.prepare(
    `insert into group_messages (id, group_id, author_kind, author_session_id, body, attachments_json, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, groupId, author ? "agent" : "user", author, body, attachments, ts());
}

function seedRich(): void {
  workspace("ws1");
  group("g1", "Alpha", "ws1");
  group("g2", "Beta", null);
  agent("a1", "Ana", "g1", 0);
  agent("a2", "Bob", "g1", 1);
  agent("a3", "Ana", "g2", 0); // same name in another group
  agent("a4", "Old", "g2", 1, true); // archived
  agent("p1", "Bob", null); // existing profile clashes with g1 Bob
  member("g1", "m1", "a1", "ws1");
  member("g1", "m2", "a2", "ws1");
  member("g2", "m3", "a3", "ws1");
  session("c1", "ws1", "chat", "a1"); // a1 has a 1:1 chat, a2 has none
  session("orphan", "ws1", "group_member");
  message("x1", "g1", "hello");
  message("x2", "g1", "on it", "m1", '[{"name":"a.png"}]');
  db.prepare(
    "insert into agent_runs (id, session_id, prompt, status, started_at) values ('r1', 'm1', 'p', 'running', ?)",
  ).run(T);
  db.prepare(
    "insert into agent_runs (id, session_id, prompt, status, started_at) values ('r2', 'c1', 'p', 'running', ?)",
  ).run(T);
  db.prepare(
    "insert into group_tasks (id, group_id, title, status, created_at, updated_at) values ('t1', 'g1', 'Do it', 'open', ?, ?)",
  ).run(T, T);
  db.prepare(
    "insert into group_decisions (id, group_id, text, created_at) values ('d1', 'g1', 'Use SQLite', ?)",
  ).run(T);
}

function snapshot(handle: DatabaseSync) {
  return {
    groups: handle.prepare("select * from agent_groups order by id").all(),
    members: handle.prepare("select * from agent_group_members order by session_id").all(),
    agents: handle.prepare("select * from agents order by id").all(),
    sessions: handle.prepare("select * from agent_sessions order by id").all(),
    runs: handle.prepare("select * from agent_runs order by id").all(),
    transcripts: handle.prepare("select * from migrated_group_transcripts").all(),
    version: handle.prepare("PRAGMA user_version").get(),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "g2p-"));
  db = open();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("groups → projects migration", () => {
  it("empty database: not pending, marks done with zero counts", () => {
    expect(isGroupsMigrationPending(db)).toBe(false);
    const result = migrateGroupsToProjects(db, opts());
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.pre.groups).toBe(0);
    expect(result.post.transcripts).toBe(0);
    expect(isGroupsMigrationDone(db)).toBe(true);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  });

  it("migrates groups, members, sessions, runs and names", () => {
    seedRich();
    expect(isGroupsMigrationPending(db)).toBe(true);
    const result = migrateGroupsToProjects(db, opts());
    if (result.status !== "done") throw new Error("not done");
    expect(result.pre).toMatchObject({
      groups: 2,
      memberships: 3,
      memberSessions: 4,
      orphanMemberSessions: 1,
      messages: 2,
      messagesWithAttachments: 1,
      liveRuns: 1,
    });
    expect(result.post).toEqual({ transcripts: 2, roomWorkChats: 4, renamedProfiles: 2 });

    const agents = db
      .prepare("select id, name, group_id, archived_at from agents order by id")
      .all();
    expect(agents).toEqual([
      { id: "a1", name: "Ana", group_id: null, archived_at: null },
      { id: "a2", name: "Bob (Alpha)", group_id: null, archived_at: null },
      { id: "a3", name: "Ana (Beta)", group_id: null, archived_at: null },
      { id: "a4", name: "Old", group_id: null, archived_at: T },
      { id: "p1", name: "Bob", group_id: null, archived_at: null },
    ]);

    const s = (id: string) =>
      db
        .prepare(
          "select kind, read_only, agent_id, title, workspace_id, migrated_from_group_id from agent_sessions where id = ?",
        )
        .get(id);
    expect(s("m1")).toEqual({
      kind: "chat",
      read_only: 1,
      agent_id: "a1",
      title: "Ana · Alpha (room work)",
      workspace_id: "ws1",
      migrated_from_group_id: "g1",
    });
    expect(s("m3")).toMatchObject({
      read_only: 1,
      agent_id: "a3",
      title: "Ana (Beta) · Beta (room work)",
    });
    expect(s("orphan")).toMatchObject({
      kind: "chat",
      read_only: 1,
      agent_id: null,
      title: "title orphan (room work)",
    });
    expect(s("c1")).toMatchObject({
      kind: "chat",
      read_only: 0,
      agent_id: "a1",
      migrated_from_group_id: "g1",
    });

    expect(db.prepare("select status, error from agent_runs where id = 'r1'").get()).toEqual({
      status: "cancelled",
      error: GROUPS_MIGRATION_RUN_ERROR,
    });
    expect(db.prepare("select status from agent_runs where id = 'r2'").get()).toEqual({
      status: "running",
    });

    const transcripts = db
      .prepare(
        "select t.group_id, t.messages_json, t.checksum, t.body_md, s.workspace_id, s.title, s.read_only from migrated_group_transcripts t join agent_sessions s on s.id = t.session_id order by t.group_id",
      )
      .all() as Array<Record<string, string | number>>;
    expect(transcripts.map((t) => [t.group_id, t.workspace_id, t.title, t.read_only])).toEqual([
      ["g1", "ws1", "Alpha (group room)", 1],
      ["g2", CHATS_WORKSPACE_ID, "Beta (group room)", 1],
    ]);
    const g1 = transcripts[0] ?? {};
    const parsed = JSON.parse(String(g1.messages_json));
    expect(parsed.map((m: { id: string }) => m.id)).toEqual(["x1", "x2"]);
    expect(parsed[1].author_name).toBe("Ana");
    expect(g1.checksum).toBe(hashGroupMessages(parsed));
    expect(g1.body_md).toContain("## Tasks");
    expect(g1.body_md).toContain("Use SQLite");
    expect(g1.body_md).toContain("Run r1 was cancelled");
    expect(
      db.prepare("select root_path from workspaces where id = ?").get(CHATS_WORKSPACE_ID),
    ).toEqual({ root_path: join(dir, "inbox-chats") });

    // Group rows stay (dropped in PR 9), marked migrated.
    expect(
      db.prepare("select count(*) as n from agent_groups where migrated_at is not null").get(),
    ).toEqual({ n: 2 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("many groups", () => {
    workspace("ws1");
    for (let g = 0; g < 40; g += 1) {
      group(`g${g}`, `G${g}`, g % 2 ? "ws1" : null);
      for (let a = 0; a < 3; a += 1) {
        agent(`a${g}-${a}`, `Agent ${a}`, `g${g}`, a);
        member(`g${g}`, `m${g}-${a}`, `a${g}-${a}`, "ws1");
        message(`x${g}-${a}`, `g${g}`, `msg ${a}`);
      }
    }
    const result = migrateGroupsToProjects(db, opts());
    if (result.status !== "done") throw new Error("not done");
    expect(result.post.transcripts).toBe(40);
    expect(result.post.roomWorkChats).toBe(120);
    const names = db.prepare("select name from agents").all() as Array<{ name: string }>;
    expect(new Set(names.map((n) => n.name.toLowerCase())).size).toBe(120);
  });

  it("is idempotent and survives reopening (legacy steps gated)", () => {
    seedRich();
    migrateGroupsToProjects(db, opts());
    const before = snapshot(db);
    expect(migrateGroupsToProjects(db, opts())).toEqual({ status: "skipped", reason: "done" });
    db.close();
    db = open();
    const after = snapshot(db);
    expect(after).toEqual(before);
    expect(db.prepare("select count(*) as n from agents where group_id is not null").get()).toEqual(
      { n: 0 },
    );
  });

  for (const step of [
    "close-live-work",
    "profiles",
    "sessions",
    "transcripts",
    "verify",
  ] as const) {
    it(`rolls back on failure after ${step}`, () => {
      seedRich();
      const before = snapshot(db);
      expect(() => migrateGroupsToProjects(db, { ...opts(), failAfter: step })).toThrow(
        /Forced failure/,
      );
      expect(snapshot(db)).toEqual(before);
      expect(isGroupsMigrationDone(db)).toBe(false);
      expect(groupsMigrationAttempts(db)).toBe(1);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    });
  }

  it("rolls back on checksum tamper, then succeeds on retry", () => {
    seedRich();
    const before = snapshot(db);
    expect(() => migrateGroupsToProjects(db, { ...opts(), tamperChecksum: true })).toThrow(
      /checksum mismatch/,
    );
    expect(snapshot(db)).toEqual(before);
    expect(migrateGroupsToProjects(db, opts()).status).toBe("done");
    expect(
      db.prepare("select value from app_settings where key = ?").get(GROUPS_MIGRATION_ATTEMPTS),
    ).toEqual({ value: "2" });
  });

  it("after migration, deleting a project keeps profiles", () => {
    seedRich();
    migrateGroupsToProjects(db, opts());
    db.prepare("update agents set default_workspace_id = 'ws1' where id = 'a1'").run();
    db.prepare("delete from workspaces where id = 'ws1'").run();
    expect(db.prepare("select count(*) as n from agents").get()).toEqual({ n: 5 });
    expect(db.prepare("select default_workspace_id from agents where id = 'a1'").get()).toEqual({
      default_workspace_id: null,
    });
  });

  it("profile names are unique among active profiles", () => {
    seedRich();
    migrateGroupsToProjects(db, opts());
    expect(() => agent("dup", "ana", null)).toThrow();
    expect(() => agent("dup2", "Ana", null, 0, true)).not.toThrow();
  });

  it("backup: VACUUM INTO, integrity checked, keeps the newest three", () => {
    seedRich();
    const backups = join(dir, "backups");
    let n = 0;
    const stamp = () => `2026-10-13T09:00:0${n++}.000Z`;
    for (let i = 0; i < 4; i += 1)
      backupBeforeGroupsMigration(db, backups, (p) => new DatabaseSync(p), stamp);
    const files = readdirSync(backups).sort();
    expect(files).toHaveLength(3);
    const copy = new DatabaseSync(join(backups, files[2] ?? ""));
    expect(copy.prepare("select count(*) as n from agent_groups").get()).toEqual({ n: 2 });
    copy.close();
    expect(existsSync(join(backups, files[0] ?? ""))).toBe(true);
  });
});
