import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => tmpdir() } }));

const {
  GroupsMigrationError,
  assertDatabaseVersionSupported,
  isGroupsMigrationPendingOnDisk,
  migrateDatabase,
  openAndMigrate,
} = await import("./database");
const { GROUPS_MIGRATION_ATTEMPTS, isGroupsMigrationDone } = await import("./groups-to-projects");
const { dismissGroupsMigrationNotice, readGroupsMigrationNotice, readMigratedGroupTranscript } =
  await import("./groups-migration-notice");

let dir: string;
let dbPath: string;
const T = "2026-10-13T09:00:00.000Z";

function raw(): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function seed(): void {
  const db = raw();
  migrateDatabase(db);
  db.close();
  const handle = raw();
  const { AGENT_AVATAR_COLORS, AGENT_AVATAR_FACES, AGENT_AVATAR_SHAPES } = avatar;
  handle
    .prepare(
      "insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at) values ('ws', ?, 'proj', 0, ?, ?)",
    )
    .run(join(dir, "proj"), T, T);
  handle
    .prepare(
      "insert into agent_groups (id, name, workspace_id, mode, created_at, updated_at) values ('g1', 'Alpha', 'ws', 'free', ?, ?)",
    )
    .run(T, T);
  for (const [i, id] of ["a1", "a2"].entries()) {
    handle
      .prepare(
        "insert into agents (id, group_id, name, avatar_face, avatar_color, avatar_shape, created_at, updated_at) values (?, 'g1', ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        `Agent ${i}`,
        String(AGENT_AVATAR_FACES[0]),
        String(AGENT_AVATAR_COLORS[0]),
        String(AGENT_AVATAR_SHAPES[i]),
        T,
        T,
      );
    handle
      .prepare(
        "insert into agent_sessions (id, workspace_id, title, cwd, status, kind, created_at, updated_at) values (?, 'ws', 'm', ?, 'idle', 'group_member', ?, ?)",
      )
      .run(`m-${id}`, join(dir, "proj"), T, T);
    handle
      .prepare(
        "insert into agent_group_members (group_id, session_id, joined_at, agent_id) values ('g1', ?, ?, ?)",
      )
      .run(`m-${id}`, T, id);
  }
  handle
    .prepare(
      "insert into group_messages (id, group_id, author_kind, body, created_at) values ('x1', 'g1', 'user', 'Ship it', ?)",
    )
    .run(T);
  handle.close();
}

const avatar = await import("../../shared/contracts");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "g2p-start-"));
  dbPath = join(dir, "modus.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("startup: groups → projects", () => {
  it("fresh database: not pending, marked done, user_version 1, no backup", () => {
    expect(isGroupsMigrationPendingOnDisk(dbPath)).toBe(false);
    const db = raw();
    openAndMigrate(db, dbPath, false);
    expect(isGroupsMigrationDone(db)).toBe(true);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(readGroupsMigrationNotice(db)).toMatchObject({ migrated: true, show: false });
    db.close();
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });

  it("legacy database: backup, migrate, Markdown copy, notice shown once, transcript readable", () => {
    seed();
    expect(isGroupsMigrationPendingOnDisk(dbPath)).toBe(true);
    const db = raw();
    openAndMigrate(db, dbPath, false);
    expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
    const md = readFileSync(join(dir, "migrated-groups", "g1.md"), "utf8");
    expect(md).toContain("# Alpha (group room)");
    expect(md).toContain("Ship it");
    const notice = readGroupsMigrationNotice(db);
    expect(notice.show).toBe(true);
    expect(notice.groups).toEqual([
      expect.objectContaining({ groupId: "g1", title: "Alpha (group room)", workspaceId: "ws" }),
    ]);
    expect(notice.backup).toContain("pre-groups.db");
    const sessionId = notice.groups[0]?.sessionId ?? "";
    expect(readMigratedGroupTranscript(db, sessionId)).toContain("Ship it");
    expect(readMigratedGroupTranscript(db, "m-a1")).toBeNull();
    dismissGroupsMigrationNotice(db);
    expect(readGroupsMigrationNotice(db).show).toBe(false);
    db.close();
    expect(isGroupsMigrationPendingOnDisk(dbPath)).toBe(false);

    // Reopen: guard accepts version 1, nothing re-runs, groups stay unlinked.
    const again = raw();
    assertDatabaseVersionSupported(again, dbPath);
    openAndMigrate(again, dbPath, false);
    expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
    expect(
      again.prepare("select count(*) as n from agents where group_id is not null").get(),
    ).toEqual({ n: 0 });
    again.close();
  });

  it("a failing migration rolls back, keeps groups, and throws GroupsMigrationError with the backup", () => {
    seed();
    const db = raw();
    // A real failure inside the transaction: room sessions cannot be converted.
    db.exec(`create trigger block_convert before update of kind on agent_sessions
      begin select raise(abort, 'blocked by test'); end;`);
    let thrown: unknown;
    try {
      openAndMigrate(db, dbPath, false);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GroupsMigrationError);
    const error = thrown as InstanceType<typeof GroupsMigrationError>;
    expect(error.message).toContain("blocked by test");
    expect(error.backup).toContain("pre-groups.db");
    expect(error.attempts).toBe(1);
    expect(isGroupsMigrationDone(db)).toBe(false);
    expect(db.prepare("select count(*) as n from agents where group_id = 'g1'").get()).toEqual({
      n: 2,
    });
    expect(
      db.prepare("select count(*) as n from agent_sessions where kind = 'group_member'").get(),
    ).toEqual({ n: 2 });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    db.close();
  });

  it("after 3 failures auto-retry stops until forced", () => {
    seed();
    const db = raw();
    db.exec(
      `insert into app_settings (key, value, updated_at) values ('${GROUPS_MIGRATION_ATTEMPTS}', '3', '${T}')`,
    );
    expect(() => openAndMigrate(db, dbPath, false)).toThrow(GroupsMigrationError);
    expect(existsSync(join(dir, "backups"))).toBe(false);
    openAndMigrate(db, dbPath, true);
    expect(isGroupsMigrationDone(db)).toBe(true);
    db.close();
  });
});
