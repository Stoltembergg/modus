import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const {
  assertDatabaseVersionSupported,
  DatabaseTooNewError,
  getDatabase,
  KNOWN_DATABASE_VERSION,
  migrateDatabase,
} = await import("../db/database");
const { getAgentSession } = await import("../agent/agent-store");
const { deleteAgentGroup } = await import("../groups/group-store");
const {
  createAgentChatRow,
  createGroupWithNewAgents,
  createProfile,
  deleteAgent,
  getAgent,
  openAgentChatRow,
  requireAgentChatWritable,
  requireSessionWritable,
  setAgentArchived,
  updateAgent,
} = await import("./agents-store");

const MODEL = "openai/gpt-5";

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function insertWorkspace(): string {
  const id = uid("workspace");
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, 'repo', 1, ?, ?)`,
    )
    .run(id, `root-${id}`, now, now);
  return id;
}

function touch(sessionId: string, updatedAt: string): void {
  getDatabase()
    .prepare("update agent_sessions set updated_at = ? where id = ?")
    .run(updatedAt, sessionId);
}

function markReadOnly(sessionId: string): void {
  getDatabase().prepare("update agent_sessions set read_only = 1 where id = ?").run(sessionId);
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function groupOf3() {
  const group = createGroupWithNewAgents({
    name: uid("Squad"),
    workspaceId: insertWorkspace(),
    members: [
      { name: "One", modelId: MODEL },
      { name: "Two", modelId: MODEL },
      { name: "Three", modelId: MODEL },
    ],
  });
  return group;
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-agents-profiles-test-"));
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("profiles (groupless agents)", () => {
  it("creates a profile with no group; the name is unique among active profiles", () => {
    const name = uid("Solo");
    const profile = createProfile({ name, modelId: MODEL });
    expect(profile.groupId).toBeUndefined();
    expect(errorCode(() => createProfile({ name, modelId: MODEL }))).toBe("agent-name-taken");
    // A grouped agent may share the name (different scope).
    const group = groupOf3();
    expect(group.members).toHaveLength(3);
    expect(createProfile({ name: "One", modelId: MODEL }).name).toBe("One");
  });

  it("restoring a profile whose name was taken meanwhile auto-renames it (A 2, A 3)", () => {
    const base = uid("A");
    const first = createProfile({ name: base, modelId: MODEL });
    setAgentArchived(first.id, true);
    const second = createProfile({ name: base, modelId: MODEL });
    expect(second.name).toBe(base);
    const restored = setAgentArchived(first.id, false);
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.name).toBe(`${base} 2`);

    // Again with " 2" also taken → " 3".
    setAgentArchived(second.id, true);
    const third = createProfile({ name: base, modelId: MODEL });
    expect(setAgentArchived(second.id, false).name).toBe(`${base} 3`);
    expect(getAgent(third.id)?.name).toBe(base);
  });

  it("restoring with a free name keeps it; archiving twice keeps the first date", () => {
    const profile = createProfile({ name: uid("Keep"), modelId: MODEL });
    const archived = setAgentArchived(profile.id, true);
    expect(setAgentArchived(profile.id, true).archivedAt).toBe(archived.archivedAt);
    expect(setAgentArchived(profile.id, false).name).toBe(profile.name);
  });
});

describe("agent chats (many per agent, read-only aware)", () => {
  it("opens in the default Project when set, else No project (the Chats inbox)", () => {
    const workspaceId = insertWorkspace();
    const withProject = createProfile({
      name: uid("P"),
      modelId: MODEL,
      defaultWorkspaceId: workspaceId,
    });
    const inbox = createProfile({ name: uid("N"), modelId: MODEL });
    expect(getAgentSession(openAgentChatRow(withProject.id))?.workspaceId).toBe(workspaceId);
    const inboxChat = getAgentSession(openAgentChatRow(inbox.id));
    expect(inboxChat?.workspaceId).toBe(CHATS_WORKSPACE_ID);
    expect(inboxChat?.agentId).toBe(inbox.id);
    expect(inboxChat?.model).toBe(MODEL);
  });

  it("a grouped agent without a default Project keeps using its group's Project", () => {
    const group = groupOf3();
    const agentId = group.members[0]?.agentId ?? "";
    expect(getAgentSession(openAgentChatRow(agentId))?.workspaceId).toBe(group.workspaceId);
  });

  it("two chats per agent: open picks the newest writable one, skipping a newer read-only one", () => {
    const profile = createProfile({ name: uid("Two"), modelId: MODEL });
    const older = createAgentChatRow(profile.id);
    const newer = createAgentChatRow(profile.id);
    touch(older, "2026-01-01T00:00:00.000Z");
    touch(newer, "2026-01-02T00:00:00.000Z");
    expect(openAgentChatRow(profile.id)).toBe(newer);
    const history = createAgentChatRow(profile.id);
    touch(history, "2026-01-05T00:00:00.000Z");
    markReadOnly(history);
    expect(openAgentChatRow(profile.id)).toBe(newer);
    expect(getAgentSession(history)?.readOnly).toBe(true);
    expect(getAgentSession(newer)?.readOnly).toBeUndefined();
  });

  it("only read-only chats → open creates a new writable one", () => {
    const profile = createProfile({ name: uid("Hist"), modelId: MODEL });
    const history = createAgentChatRow(profile.id);
    markReadOnly(history);
    const opened = openAgentChatRow(profile.id);
    expect(opened).not.toBe(history);
    expect(getAgentSession(opened)?.readOnly).toBeUndefined();
  });

  it("rename and model rebind touch writable chats only", () => {
    const profile = createProfile({ name: uid("Re"), modelId: MODEL });
    const chat = createAgentChatRow(profile.id);
    const history = createAgentChatRow(profile.id);
    markReadOnly(history);
    const renamed = uid("Renamed");
    updateAgent(profile.id, { name: renamed, modelId: "anthropic/claude" });
    expect(getAgentSession(chat)).toMatchObject({ title: renamed, model: "anthropic/claude" });
    expect(getAgentSession(history)).toMatchObject({ title: profile.name, model: MODEL });
  });

  it("deleteAgent tears down writable chats and keeps read-only ones (agent_id → null)", () => {
    const profile = createProfile({ name: uid("Del"), modelId: MODEL });
    const chat = createAgentChatRow(profile.id);
    const history = createAgentChatRow(profile.id);
    markReadOnly(history);
    expect(deleteAgent(profile.id)).toEqual([chat]);
    const kept = getAgentSession(history);
    expect(kept?.readOnly).toBe(true);
    expect(kept?.agentId).toBeUndefined();
  });

  it("removing a member and deleting a group never return read-only chats for teardown", () => {
    const group = groupOf3();
    const [a, b] = group.members;
    const aChat = openAgentChatRow(a?.agentId ?? "");
    const aHistory = createAgentChatRow(a?.agentId ?? "");
    markReadOnly(aHistory);
    expect(deleteAgent(a?.agentId ?? "")).toContain(aChat);
    expect(getAgentSession(aHistory)?.readOnly).toBe(true);

    const bHistory = createAgentChatRow(b?.agentId ?? "");
    markReadOnly(bHistory);
    const torn = deleteAgentGroup(group.id);
    expect(torn).not.toContain(bHistory);
    expect(getAgentSession(bHistory)?.readOnly).toBe(true);
  });

  it("refuses writes to a read-only session with session-read-only", () => {
    const profile = createProfile({ name: uid("RO"), modelId: MODEL });
    const chat = createAgentChatRow(profile.id);
    expect(() => requireSessionWritable(chat)).not.toThrow();
    markReadOnly(chat);
    expect(errorCode(() => requireSessionWritable(chat))).toBe("session-read-only");
    expect(errorCode(() => requireAgentChatWritable(chat))).toBe("session-read-only");
  });

  it("several chats per agent are allowed (the unique index is gone)", () => {
    const indexes = getDatabase()
      .prepare(
        "select name from sqlite_master where type = 'index' and tbl_name = 'agent_sessions'",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((row) => row.name);
    expect(names).toContain("idx_agent_sessions_agent");
    expect(names).not.toContain("idx_agent_sessions_agent_chat");
  });
});

describe("downgrade guard", () => {
  it("refuses a newer user_version without writing; accepts the known one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "modus-guard-"));
    const path = join(dir, "newer.sqlite");
    const newer = new DatabaseSync(path);
    newer.exec(`PRAGMA user_version = ${KNOWN_DATABASE_VERSION + 1}`);
    expect(() => assertDatabaseVersionSupported(newer, path)).toThrow(DatabaseTooNewError);
    const tables = newer.prepare("select count(*) as n from sqlite_master").get() as { n: number };
    expect(Number(tables.n)).toBe(0);
    newer.close();

    const known = new DatabaseSync(":memory:");
    expect(() => assertDatabaseVersionSupported(known)).not.toThrow();
    migrateDatabase(known);
    const version = known.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(Number(version.user_version)).toBe(KNOWN_DATABASE_VERSION);
    known.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("an existing one-chat DB migrates to the plain index and keeps its rows", () => {
    const db = new DatabaseSync(":memory:");
    migrateDatabase(db);
    db.exec(`drop index if exists idx_agent_sessions_agent;
      create unique index idx_agent_sessions_agent_chat on agent_sessions(agent_id) where agent_id is not null`);
    migrateDatabase(db);
    const names = (
      db.prepare("select name from sqlite_master where type = 'index'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(names).toContain("idx_agent_sessions_agent");
    expect(names).not.toContain("idx_agent_sessions_agent_chat");
    db.close();
  });
});
