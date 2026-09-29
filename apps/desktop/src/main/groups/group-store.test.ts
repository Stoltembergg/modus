import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";

let userData: string;

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
  },
}));

const { getDatabase, migrateDatabase } = await import("../db/database");
const { deleteAgentSession, getAgentSession, listAgentSessions, setAgentSessionArchived } =
  await import("../agent/agent-store");
const { ensureChatsWorkspace, removeWorkspace } = await import("../workspace/workspace-store");
const {
  GroupStoreError,
  addAgentGroupMember,
  addGroupDecision,
  appendGroupMessage,
  createAgentGroup,
  createGroupTask,
  deleteAgentGroup,
  getAgentGroup,
  getAgentGroupForSession,
  listActiveGroupDecisions,
  listAgentGroupMembers,
  listAgentGroupMemberSessionIds,
  listAgentGroups,
  listGroupMessages,
  listGroupTasks,
  removeAgentGroupMember,
  renameAgentGroup,
  setAgentGroupLead,
  setAgentGroupMode,
  supersedeGroupDecision,
  updateGroupTask,
} = await import("./group-store");

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function insertWorkspace(workspaceId = uid("workspace")): string {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(workspaceId, `root-${workspaceId}`, "repo", 1, now, now);
  return workspaceId;
}

function insertSession(workspaceId: string, sessionId = uid("session")): string {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, workspaceId, `Chat ${sessionId}`, `root-${workspaceId}`, "idle", now, now);
  return sessionId;
}

function insertEvent(sessionId: string): void {
  getDatabase()
    .prepare(
      `insert into agent_events (id, session_id, type, payload_json, created_at)
       values (?, ?, ?, ?, ?)`,
    )
    .run(uid("event"), sessionId, "message", "{}", new Date().toISOString());
}

function insertRun(sessionId: string): void {
  getDatabase()
    .prepare(
      `insert into agent_runs (id, session_id, prompt, status, started_at)
       values (?, ?, ?, ?, ?)`,
    )
    .run(uid("run"), sessionId, "hello", "completed", new Date().toISOString());
}

function countRows(table: string, column: string, value: string): number {
  const row = getDatabase()
    .prepare(`select count(*) as n from ${table} where ${column} = ?`)
    .get(value) as { n: number };
  return Number(row.n);
}

function schemaSnapshot(db: DatabaseSync): Array<{ type: string; name: string; sql: string }> {
  return db
    .prepare(
      "select type, name, coalesce(sql, '') as sql from sqlite_master where name not like 'sqlite_%' order by type, name",
    )
    .all() as Array<{ type: string; name: string; sql: string }>;
}

function expectStoreError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GroupStoreError);
  expect((caught as InstanceType<typeof GroupStoreError>).code).toBe(code);
}

/** A project group with two members. */
function projectGroupFixture() {
  const workspaceId = insertWorkspace();
  const a = insertSession(workspaceId);
  const b = insertSession(workspaceId);
  const group = createAgentGroup({ name: "Squad", workspaceId });
  addAgentGroupMember({ groupId: group.id, sessionId: a, role: "implement" });
  addAgentGroupMember({ groupId: group.id, sessionId: b, role: "review" });
  return { workspaceId, a, b, group };
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-group-store-test-"));
  ensureChatsWorkspace();
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("group schema", () => {
  it("enables foreign keys on the shared connection", () => {
    const row = getDatabase().prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  it("migrates idempotently on the same database file", () => {
    const db = getDatabase();
    const before = schemaSnapshot(db);
    expect(before.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "agent_groups",
        "agent_group_members",
        "group_messages",
        "group_tasks",
        "group_decisions",
        "idx_group_messages_group_created_id",
      ]),
    );
    expect(() => {
      migrateDatabase(db);
      migrateDatabase(db);
    }).not.toThrow();
    expect(schemaSnapshot(db)).toEqual(before);
  });

  it("migrates a fresh file twice with the same schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "modus-group-migrate-"));
    const path = join(dir, "modus.sqlite");
    try {
      const first = new DatabaseSync(path);
      first.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(first);
      const once = schemaSnapshot(first);
      first.close();
      const second = new DatabaseSync(path);
      second.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(second);
      migrateDatabase(second);
      expect(schemaSnapshot(second)).toEqual(once);
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid enum values at the database level", () => {
    const db = getDatabase();
    const group = createAgentGroup({ name: "Checks" });
    const now = new Date().toISOString();
    expect(() =>
      db
        .prepare(
          `insert into group_messages (id, group_id, author_kind, kind, body, created_at)
           values (?, ?, 'robot', 'message', 'x', ?)`,
        )
        .run(uid("m"), group.id, now),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          `insert into group_messages (id, group_id, author_kind, kind, body, created_at)
           values (?, ?, 'user', 'shout', 'x', ?)`,
        )
        .run(uid("m"), group.id, now),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          `insert into group_tasks (id, group_id, title, status, created_at, updated_at)
           values (?, ?, 't', 'blocked', ?, ?)`,
        )
        .run(uid("t"), group.id, now, now),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.prepare("update agent_groups set mode = 'chaos' where id = ?").run(group.id),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("groups", () => {
  it("creates, gets, lists, renames, sets mode and deletes groups", () => {
    const workspaceId = insertWorkspace();
    const projectGroup = createAgentGroup({ name: "  Build crew ", workspaceId });
    const inboxGroup = createAgentGroup({ name: "Inbox crew", workspaceId: CHATS_WORKSPACE_ID });

    expect(projectGroup).toMatchObject({ name: "Build crew", workspaceId, mode: "free" });
    expect(projectGroup.leadSessionId).toBeUndefined();
    expect(inboxGroup.workspaceId).toBeUndefined();
    expect(getAgentGroup(projectGroup.id)).toEqual(projectGroup);
    expect(listAgentGroups({ workspaceId }).map((group) => group.id)).toEqual([projectGroup.id]);
    expect(listAgentGroups({ workspaceId: null }).map((group) => group.id)).toContain(
      inboxGroup.id,
    );
    expect(listAgentGroups({ workspaceId: null }).map((group) => group.id)).not.toContain(
      projectGroup.id,
    );
    expect(listAgentGroups().map((group) => group.id)).toEqual(
      expect.arrayContaining([projectGroup.id, inboxGroup.id]),
    );

    expect(renameAgentGroup(projectGroup.id, "Renamed").name).toBe("Renamed");
    expect(setAgentGroupMode(projectGroup.id, "coordinator").mode).toBe("coordinator");
    expectStoreError(() => renameAgentGroup(projectGroup.id, "   "), "invalid-value");
    expectStoreError(() => setAgentGroupMode(projectGroup.id, "chaos" as "free"), "invalid-value");
    expectStoreError(() => createAgentGroup({ name: "" }), "invalid-value");
    expectStoreError(() => renameAgentGroup("missing", "x"), "group-not-found");

    deleteAgentGroup(projectGroup.id);
    expect(getAgentGroup(projectGroup.id)).toBeUndefined();
  });
});

describe("members", () => {
  it("adds, lists, finds and removes members", () => {
    const { a, b, group } = projectGroupFixture();

    expect(listAgentGroupMembers(group.id)).toEqual([
      expect.objectContaining({ groupId: group.id, sessionId: a, role: "implement" }),
      expect.objectContaining({ groupId: group.id, sessionId: b, role: "review" }),
    ]);
    expect(getAgentGroupForSession(a)?.id).toBe(group.id);
    expect(listAgentGroupMemberSessionIds()).toEqual(expect.arrayContaining([a, b]));

    removeAgentGroupMember(group.id, b);
    expect(listAgentGroupMembers(group.id).map((member) => member.sessionId)).toEqual([a]);
    expect(getAgentGroupForSession(b)).toBeUndefined();
    expect(listAgentGroupMemberSessionIds()).not.toContain(b);
    expect(getAgentSession(b)).toBeDefined();
  });

  it("only accepts sessions from the group's Project", () => {
    const workspaceId = insertWorkspace();
    const otherWorkspaceId = insertWorkspace();
    const group = createAgentGroup({ name: "Project group", workspaceId });
    const foreign = insertSession(otherWorkspaceId);
    const inbox = insertSession(CHATS_WORKSPACE_ID);

    expectStoreError(
      () => addAgentGroupMember({ groupId: group.id, sessionId: foreign }),
      "workspace-mismatch",
    );
    expectStoreError(
      () => addAgentGroupMember({ groupId: group.id, sessionId: inbox }),
      "workspace-mismatch",
    );
    expectStoreError(
      () => addAgentGroupMember({ groupId: group.id, sessionId: "missing" }),
      "session-not-found",
    );
    expectStoreError(
      () => addAgentGroupMember({ groupId: "missing", sessionId: foreign }),
      "group-not-found",
    );
  });

  it("a group without a Project only accepts chats without a folder", () => {
    const group = createAgentGroup({ name: "No project" });
    const projectSession = insertSession(insertWorkspace());
    const inbox = insertSession(CHATS_WORKSPACE_ID);

    expectStoreError(
      () => addAgentGroupMember({ groupId: group.id, sessionId: projectSession }),
      "workspace-mismatch",
    );
    expect(addAgentGroupMember({ groupId: group.id, sessionId: inbox }).sessionId).toBe(inbox);
  });

  it("maps the unique session constraint to already-in-group", () => {
    const { workspaceId, a, group } = projectGroupFixture();
    const second = createAgentGroup({ name: "Second", workspaceId });

    expectStoreError(
      () => addAgentGroupMember({ groupId: second.id, sessionId: a }),
      "already-in-group",
    );
    expectStoreError(
      () => addAgentGroupMember({ groupId: group.id, sessionId: a }),
      "already-in-group",
    );
    expect(getAgentGroupForSession(a)?.id).toBe(group.id);
  });
});

describe("member eligibility", () => {
  it("rejects a subagent session with subagent-session", () => {
    const { workspaceId, a, group } = projectGroupFixture();
    const child = insertSession(workspaceId);
    getDatabase()
      .prepare("update agent_sessions set parent_session_id = ? where id = ?")
      .run(a, child);

    expectStoreError(
      () => addAgentGroupMember({ groupId: group.id, sessionId: child }),
      "subagent-session",
    );
    expect(getAgentGroupForSession(child)).toBeUndefined();
  });

  it("rejects an archived session with archived-session", () => {
    const { workspaceId, group } = projectGroupFixture();
    const archived = insertSession(workspaceId);
    setAgentSessionArchived(archived, true);

    expectStoreError(
      () => addAgentGroupMember({ groupId: group.id, sessionId: archived }),
      "archived-session",
    );
    expect(getAgentGroupForSession(archived)).toBeUndefined();
  });
});

describe("lead", () => {
  it("requires the lead to be a member and clears it when the lead leaves", () => {
    const { workspaceId, a, group } = projectGroupFixture();
    const outsider = insertSession(workspaceId);

    expectStoreError(() => setAgentGroupLead(group.id, outsider), "not-a-member");
    expect(setAgentGroupLead(group.id, a).leadSessionId).toBe(a);

    removeAgentGroupMember(group.id, a);
    expect(getAgentGroup(group.id)?.leadSessionId).toBeUndefined();

    expect(setAgentGroupLead(group.id, null).leadSessionId).toBeUndefined();
  });
});

describe("messages", () => {
  it("appends messages with chains, replies, mentions and pages by created_at", () => {
    const { a, b, group } = projectGroupFixture();
    const opener = appendGroupMessage({
      groupId: group.id,
      authorKind: "user",
      body: "@a please build it",
      mentions: [a, a],
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    expect(opener.chainId).toBe(opener.id);
    expect(opener.mentions).toEqual([a]);

    const reply = appendGroupMessage({
      groupId: group.id,
      authorKind: "agent",
      authorSessionId: a,
      replyToMessageId: opener.id,
      toSessionId: b,
      body: "Done, please review",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    expect(reply).toMatchObject({
      authorSessionId: a,
      replyToMessageId: opener.id,
      toSessionId: b,
      chainId: opener.id,
      kind: "message",
    });

    const status = appendGroupMessage({
      groupId: group.id,
      authorKind: "system",
      kind: "status",
      body: "b is reviewing",
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    expect(status.kind).toBe("status");

    expect(listGroupMessages(group.id).map((m) => m.id)).toEqual([opener.id, reply.id, status.id]);
    expect(listGroupMessages(group.id, { limit: 2 }).map((m) => m.id)).toEqual([
      reply.id,
      status.id,
    ]);
    expect(
      listGroupMessages(group.id, { before: { createdAt: reply.createdAt, id: reply.id } }).map(
        (m) => m.id,
      ),
    ).toEqual([opener.id]);
    expect(
      listGroupMessages(group.id, {
        after: { createdAt: opener.createdAt, id: opener.id },
        limit: 1,
      }).map((m) => m.id),
    ).toEqual([reply.id]);
  });

  it("rejects invalid kinds, authors and cross-group references", () => {
    const { workspaceId, a, group } = projectGroupFixture();
    const outsider = insertSession(workspaceId);
    const otherGroup = createAgentGroup({ name: "Other", workspaceId });
    const foreignMessage = appendGroupMessage({
      groupId: otherGroup.id,
      authorKind: "user",
      body: "elsewhere",
    });

    expectStoreError(
      () => appendGroupMessage({ groupId: group.id, authorKind: "robot" as "user", body: "x" }),
      "invalid-value",
    );
    expectStoreError(
      () =>
        appendGroupMessage({
          groupId: group.id,
          authorKind: "user",
          kind: "shout" as "message",
          body: "x",
        }),
      "invalid-value",
    );
    expectStoreError(
      () => appendGroupMessage({ groupId: group.id, authorKind: "agent", body: "x" }),
      "invalid-value",
    );
    expectStoreError(
      () =>
        appendGroupMessage({
          groupId: group.id,
          authorKind: "user",
          authorSessionId: a,
          body: "x",
        }),
      "invalid-value",
    );
    expectStoreError(
      () =>
        appendGroupMessage({
          groupId: group.id,
          authorKind: "agent",
          authorSessionId: outsider,
          body: "x",
        }),
      "not-a-member",
    );
    expectStoreError(
      () =>
        appendGroupMessage({
          groupId: group.id,
          authorKind: "user",
          body: "x",
          mentions: [outsider],
        }),
      "not-a-member",
    );
    expectStoreError(
      () =>
        appendGroupMessage({
          groupId: group.id,
          authorKind: "user",
          body: "x",
          replyToMessageId: foreignMessage.id,
        }),
      "message-not-found",
    );
    expectStoreError(
      () => appendGroupMessage({ groupId: group.id, authorKind: "user", body: "  " }),
      "invalid-value",
    );
  });
});

describe("message pagination cursor", () => {
  it("pages same-millisecond messages by (created_at, id) without skips or duplicates", () => {
    const { group } = projectGroupFixture();
    const sameMs = "2026-02-02T10:00:00.000Z";
    // Inserted first, but with the lexicographically LARGER id.
    const first = appendGroupMessage({
      id: "msg-zzz",
      groupId: group.id,
      authorKind: "user",
      body: "first inserted",
      createdAt: sameMs,
    });
    const second = appendGroupMessage({
      id: "msg-aaa",
      groupId: group.id,
      authorKind: "user",
      body: "second inserted",
      createdAt: sameMs,
    });
    const earlier = appendGroupMessage({
      id: "msg-mmm",
      groupId: group.id,
      authorKind: "user",
      body: "earlier",
      createdAt: "2026-02-02T09:59:59.999Z",
    });
    const later = appendGroupMessage({
      id: "msg-bbb",
      groupId: group.id,
      authorKind: "user",
      body: "later",
      createdAt: "2026-02-02T10:00:00.001Z",
    });
    const expected = [earlier.id, second.id, first.id, later.id];
    const cursor = (m: { createdAt: string; id: string }) => ({ createdAt: m.createdAt, id: m.id });

    expect(listGroupMessages(group.id).map((m) => m.id)).toEqual(expected);

    // Backwards (newest first), one per page.
    const backwards: string[] = [];
    let page = listGroupMessages(group.id, { limit: 1 });
    while (page.length > 0) {
      const [message] = page;
      if (!message) break;
      backwards.push(message.id);
      page = listGroupMessages(group.id, { before: cursor(message), limit: 1 });
    }
    expect(backwards).toEqual([...expected].reverse());

    // Forwards (oldest first), one per page, starting before the first message.
    const forwards: string[] = [];
    page = listGroupMessages(group.id, {
      after: { createdAt: "2026-02-02T00:00:00.000Z", id: "" },
      limit: 1,
    });
    while (page.length > 0) {
      const [message] = page;
      if (!message) break;
      forwards.push(message.id);
      page = listGroupMessages(group.id, { after: cursor(message), limit: 1 });
    }
    expect(forwards).toEqual(expected);
    expect(new Set(forwards).size).toBe(expected.length);

    // Stable: repeating a page gives the same result.
    expect(listGroupMessages(group.id, { before: cursor(first), limit: 1 })).toEqual(
      listGroupMessages(group.id, { before: cursor(first), limit: 1 }),
    );
    expect(listGroupMessages(group.id, { before: cursor(first), limit: 1 })[0]?.id).toBe(second.id);
  });
});

describe("tasks", () => {
  it("creates, updates (handoff and review) and lists tasks", () => {
    const { a, b, group } = projectGroupFixture();
    const task = createGroupTask({
      groupId: group.id,
      title: "Implement parser",
      description: "Use the new grammar",
      ownerSessionId: a,
      createdBySessionId: b,
    });
    expect(task).toMatchObject({ status: "open", ownerSessionId: a, createdBySessionId: b });

    const handedOff = updateGroupTask(task.id, {
      status: "in_review",
      ownerSessionId: b,
      reviewerSessionId: a,
      branch: "feat/parser",
    });
    expect(handedOff).toMatchObject({
      status: "in_review",
      ownerSessionId: b,
      reviewerSessionId: a,
      branch: "feat/parser",
    });

    const cleared = updateGroupTask(task.id, { reviewerSessionId: null, branch: null });
    expect(cleared.reviewerSessionId).toBeUndefined();
    expect(cleared.branch).toBeUndefined();
    expect(cleared.ownerSessionId).toBe(b);

    const other = createGroupTask({ groupId: group.id, title: "Docs", status: "done" });
    expect(listGroupTasks(group.id).map((t) => t.id)).toEqual([task.id, other.id]);
    expect(listGroupTasks(group.id, { status: "done" }).map((t) => t.id)).toEqual([other.id]);
  });

  it("removing a member detaches them from open tasks but keeps closed tasks as history", () => {
    const { a, b, group } = projectGroupFixture();
    const owned = createGroupTask({
      groupId: group.id,
      title: "Owned in progress",
      status: "in_progress",
      ownerSessionId: a,
      reviewerSessionId: b,
    });
    const reviewing = createGroupTask({
      groupId: group.id,
      title: "Reviewed by a",
      status: "in_review",
      ownerSessionId: b,
      reviewerSessionId: a,
    });
    const done = createGroupTask({
      groupId: group.id,
      title: "Done",
      status: "done",
      ownerSessionId: a,
      reviewerSessionId: a,
      branch: "feat/done",
    });
    const cancelled = createGroupTask({
      groupId: group.id,
      title: "Cancelled",
      status: "cancelled",
      ownerSessionId: a,
    });
    const unrelated = createGroupTask({
      groupId: group.id,
      title: "Unrelated",
      status: "in_progress",
      ownerSessionId: b,
    });

    removeAgentGroupMember(group.id, a);

    const byId = new Map(listGroupTasks(group.id).map((task) => [task.id, task]));
    expect(byId.get(owned.id)).toMatchObject({ status: "open", reviewerSessionId: b });
    expect(byId.get(owned.id)?.ownerSessionId).toBeUndefined();
    expect(byId.get(reviewing.id)).toMatchObject({ status: "open", ownerSessionId: b });
    expect(byId.get(reviewing.id)?.reviewerSessionId).toBeUndefined();
    expect(byId.get(done.id)).toEqual(done);
    expect(byId.get(cancelled.id)).toEqual(cancelled);
    expect(byId.get(unrelated.id)).toEqual(unrelated);
  });

  it("rejects invalid statuses and non-member owners", () => {
    const { workspaceId, group } = projectGroupFixture();
    const outsider = insertSession(workspaceId);
    const task = createGroupTask({ groupId: group.id, title: "Task" });

    expectStoreError(
      () => updateGroupTask(task.id, { status: "blocked" as "open" }),
      "invalid-value",
    );
    expectStoreError(
      () => createGroupTask({ groupId: group.id, title: "T", status: "blocked" as "open" }),
      "invalid-value",
    );
    expectStoreError(() => updateGroupTask(task.id, { ownerSessionId: outsider }), "not-a-member");
    expectStoreError(() => updateGroupTask("missing", { status: "done" }), "task-not-found");
    expect(listGroupTasks(group.id)[0]?.status).toBe("open");
  });
});

describe("decisions", () => {
  it("adds, supersedes and lists only active decisions", () => {
    const { a, group } = projectGroupFixture();
    const source = appendGroupMessage({
      groupId: group.id,
      authorKind: "user",
      body: "Use SQLite",
    });
    const first = addGroupDecision({
      groupId: group.id,
      text: "Use SQLite",
      sourceMessageId: source.id,
      createdBySessionId: a,
    });
    const other = addGroupDecision({ groupId: group.id, text: "Ship weekly" });

    const replacement = supersedeGroupDecision(first.id, { text: "Use SQLite with WAL" });
    expect(listActiveGroupDecisions(group.id).map((d) => d.id)).toEqual([other.id, replacement.id]);
    expectStoreError(() => supersedeGroupDecision(first.id, { text: "again" }), "invalid-value");
    expectStoreError(() => supersedeGroupDecision("missing", { text: "x" }), "decision-not-found");
  });
});

describe("deletion semantics", () => {
  it("deleting a group removes its rows but keeps sessions, history and listings", () => {
    const { workspaceId, a, b, group } = projectGroupFixture();
    insertEvent(a);
    insertEvent(a);
    insertRun(b);
    appendGroupMessage({ groupId: group.id, authorKind: "agent", authorSessionId: a, body: "hi" });
    createGroupTask({ groupId: group.id, title: "Task", ownerSessionId: b });
    addGroupDecision({ groupId: group.id, text: "Decision" });

    deleteAgentGroup(group.id);

    for (const table of [
      "agent_group_members",
      "group_messages",
      "group_tasks",
      "group_decisions",
    ]) {
      expect(countRows(table, "group_id", group.id)).toBe(0);
    }
    expect(getAgentSession(a)?.workspaceId).toBe(workspaceId);
    expect(getAgentSession(b)?.workspaceId).toBe(workspaceId);
    expect(countRows("agent_events", "session_id", a)).toBe(2);
    expect(countRows("agent_runs", "session_id", b)).toBe(1);
    const listed = listAgentSessions()
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => session.id);
    expect(listed).toEqual(expect.arrayContaining([a, b]));
    expect(listAgentGroupMemberSessionIds()).not.toContain(a);
    expect(getAgentGroupForSession(a)).toBeUndefined();
  });

  it("deleting the Project deletes its groups and (existing behaviour) its sessions", () => {
    const { workspaceId, a, b, group } = projectGroupFixture();
    appendGroupMessage({ groupId: group.id, authorKind: "user", body: "hello" });
    createGroupTask({ groupId: group.id, title: "Task" });

    removeWorkspace(workspaceId);

    expect(getAgentGroup(group.id)).toBeUndefined();
    expect(countRows("group_messages", "group_id", group.id)).toBe(0);
    expect(countRows("group_tasks", "group_id", group.id)).toBe(0);
    expect(countRows("agent_group_members", "group_id", group.id)).toBe(0);
    expect(getAgentSession(a)).toBeUndefined();
    expect(getAgentSession(b)).toBeUndefined();
  });

  it("deleting a session drops its membership and nulls author/owner references", () => {
    const { a, b, group } = projectGroupFixture();
    setAgentGroupLead(group.id, a);
    const message = appendGroupMessage({
      groupId: group.id,
      authorKind: "agent",
      authorSessionId: a,
      body: "from a",
    });
    const task = createGroupTask({
      groupId: group.id,
      title: "Task",
      ownerSessionId: a,
      createdBySessionId: a,
      reviewerSessionId: a,
    });
    const decision = addGroupDecision({ groupId: group.id, text: "D", createdBySessionId: a });

    deleteAgentSession(a);

    expect(listAgentGroupMembers(group.id).map((member) => member.sessionId)).toEqual([b]);
    const reloaded = getAgentGroup(group.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.leadSessionId).toBeUndefined();
    const [storedMessage] = listGroupMessages(group.id);
    expect(storedMessage?.id).toBe(message.id);
    expect(storedMessage?.authorKind).toBe("agent");
    expect(storedMessage?.authorSessionId).toBeUndefined();
    const [storedTask] = listGroupTasks(group.id);
    expect(storedTask?.id).toBe(task.id);
    expect(storedTask?.ownerSessionId).toBeUndefined();
    expect(storedTask?.createdBySessionId).toBeUndefined();
    expect(storedTask?.reviewerSessionId).toBeUndefined();
    const [storedDecision] = listActiveGroupDecisions(group.id);
    expect(storedDecision?.id).toBe(decision.id);
    expect(storedDecision?.createdBySessionId).toBeUndefined();

    // The group keeps working after the deletion.
    expect(
      appendGroupMessage({ groupId: group.id, authorKind: "agent", authorSessionId: b, body: "ok" })
        .authorSessionId,
    ).toBe(b);
  });
});
