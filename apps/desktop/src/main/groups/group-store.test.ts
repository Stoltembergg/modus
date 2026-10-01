import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";
import { isCoordinatorModeActive } from "../../shared/group-coordinator";

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
  appendGroupMessage,
  assignGroupTask,
  cancelGroupTask,
  claimGroupTask,
  createMemberGroupTask,
  getGroupMessage,
  releaseGroupTask,
  requestGroupTaskReview,
  recordGroupDecision,
  reviewGroupTask,
  createAgentGroup,
  createAgentGroupWithMembers,
  createGroupTask,
  deleteGroupDecision,
  fillMemberTaskBranches,
  GROUP_DECISION_LIMIT,
  GROUP_DECISION_MAX_CHARS,
  deleteAgentGroup,
  getAgentGroup,
  getAgentGroupForSession,
  listAgentGroupMembers,
  listAgentGroupMemberSessionIds,
  listAgentGroups,
  listAgentGroupsWithMembers,
  listGroupDecisions,
  listGroupMessages,
  listGroupTasks,
  removeAgentGroupMember,
  renameAgentGroup,
  setAgentGroupLead,
  setAgentGroupMode,
  updateAgentGroupMembers,
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
  const group = createAgentGroup({ name: "Squad", workspaceId, mode: "free" });
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
    const freeWorkspaceId = insertWorkspace();
    const freeGroup = createAgentGroup({
      name: "Free crew",
      workspaceId: freeWorkspaceId,
      mode: "free",
    });

    expect(projectGroup).toMatchObject({ name: "Build crew", workspaceId, mode: "coordinator" });
    expect(projectGroup.leadSessionId).toBeUndefined();
    expect(inboxGroup.mode).toBe("coordinator");
    expect(freeGroup.mode).toBe("free");
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

describe("message chains (startsChain) and lookup", () => {
  it("startsChain opens a new chain even for a reply; replies otherwise inherit", () => {
    const { a, group } = projectGroupFixture();
    const opener = appendGroupMessage({ groupId: group.id, authorKind: "user", body: "first" });
    const inherited = appendGroupMessage({
      groupId: group.id,
      authorKind: "agent",
      authorSessionId: a,
      replyToMessageId: opener.id,
      body: "on it",
    });
    expect(inherited.chainId).toBe(opener.id);
    const restart = appendGroupMessage({
      groupId: group.id,
      authorKind: "user",
      replyToMessageId: inherited.id,
      startsChain: true,
      body: "new request",
    });
    expect(restart.chainId).toBe(restart.id);
    expect(restart.replyToMessageId).toBe(inherited.id);
    expectStoreError(
      () =>
        appendGroupMessage({
          groupId: group.id,
          authorKind: "user",
          startsChain: true,
          chainId: opener.id,
          body: "x",
        }),
      "invalid-value",
    );
  });

  it("getGroupMessage returns a message by id or undefined", () => {
    const { a, group } = projectGroupFixture();
    const message = appendGroupMessage({
      groupId: group.id,
      authorKind: "user",
      body: "@a hi",
      mentions: [a],
    });
    expect(getGroupMessage(message.id)).toEqual(message);
    expect(getGroupMessage("missing")).toBeUndefined();
  });
});

describe("message pagination cursor", () => {
  it("pages messages by persisted sequence without skips or duplicates", () => {
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
    const expected = [first.id, second.id, earlier.id, later.id];
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
    expect(listGroupMessages(group.id, { before: cursor(second), limit: 1 })[0]?.id).toBe(first.id);
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

  it("(c) removing the owner resets the open task to open; closed tasks stay as history", () => {
    const { a, b, group } = projectGroupFixture();
    const owned = createGroupTask({
      groupId: group.id,
      title: "Owned in progress",
      status: "in_progress",
      ownerSessionId: a,
      reviewerSessionId: b,
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
    expect(byId.get(done.id)).toEqual(done);
    expect(byId.get(cancelled.id)).toEqual(cancelled);
    expect(byId.get(unrelated.id)).toEqual(unrelated);
  });

  it("(a) removing only the reviewer keeps an in_progress task in_progress", () => {
    const { a, b, group } = projectGroupFixture();
    const task = createGroupTask({
      groupId: group.id,
      title: "Being built",
      status: "in_progress",
      ownerSessionId: b,
      reviewerSessionId: a,
    });

    removeAgentGroupMember(group.id, a);

    const [stored] = listGroupTasks(group.id);
    expect(stored?.id).toBe(task.id);
    expect(stored).toMatchObject({ status: "in_progress", ownerSessionId: b });
    expect(stored?.reviewerSessionId).toBeUndefined();
  });

  it("(b) removing only the reviewer sends an in_review task back to in_progress", () => {
    const { a, b, group } = projectGroupFixture();
    const task = createGroupTask({
      groupId: group.id,
      title: "Awaiting review",
      status: "in_review",
      ownerSessionId: b,
      reviewerSessionId: a,
    });

    removeAgentGroupMember(group.id, a);

    const [stored] = listGroupTasks(group.id);
    expect(stored?.id).toBe(task.id);
    expect(stored).toMatchObject({ status: "in_progress", ownerSessionId: b });
    expect(stored?.reviewerSessionId).toBeUndefined();
  });

  it("(d) removing a member who is both owner and reviewer clears both and resets to open", () => {
    const { a, group } = projectGroupFixture();
    const task = createGroupTask({
      groupId: group.id,
      title: "Self-reviewed",
      status: "in_review",
      ownerSessionId: a,
      reviewerSessionId: a,
    });

    removeAgentGroupMember(group.id, a);

    const [stored] = listGroupTasks(group.id);
    expect(stored?.id).toBe(task.id);
    expect(stored?.status).toBe("open");
    expect(stored?.ownerSessionId).toBeUndefined();
    expect(stored?.reviewerSessionId).toBeUndefined();
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

/* ── member task transitions (PR 4a) ─────────────────────────────────── */

describe("cancelGroupTask (the room's Cancel task)", () => {
  it("cancels open, in progress and in review tasks; refuses done; cancelled stays", () => {
    const { a, b, group } = projectGroupFixture();
    const open = createGroupTask({ groupId: group.id, title: "Open" });
    const working = createGroupTask({
      groupId: group.id,
      title: "Working",
      status: "in_progress",
      ownerSessionId: a,
    });
    const review = createGroupTask({
      groupId: group.id,
      title: "Review",
      status: "in_review",
      ownerSessionId: a,
      reviewerSessionId: b,
      branch: "feat/x",
    });
    const done = createGroupTask({ groupId: group.id, title: "Done", status: "done" });
    for (const task of [open, working, review]) {
      expect(cancelGroupTask(task.id).status).toBe("cancelled");
    }
    // Owner, reviewer and branch stay as history.
    expect(listGroupTasks(group.id).find((t) => t.id === review.id)).toMatchObject({
      status: "cancelled",
      ownerSessionId: a,
      reviewerSessionId: b,
      branch: "feat/x",
    });
    expect(() => cancelGroupTask(done.id)).toThrow(
      expect.objectContaining({ code: "invalid-transition" }),
    );
    const again = cancelGroupTask(open.id);
    expect(again.status).toBe("cancelled");
    expect(() => cancelGroupTask("missing")).toThrow(
      expect.objectContaining({ code: "task-not-found" }),
    );
  });
});

describe("member task transitions", () => {
  /** Squad with a third member c and a stranger from the same Project. */
  function trio() {
    const fixture = projectGroupFixture();
    const c = insertSession(fixture.workspaceId);
    addAgentGroupMember({ groupId: fixture.group.id, sessionId: c });
    const stranger = insertSession(fixture.workspaceId);
    return { ...fixture, c, stranger };
  }

  it("valid path: create → claim → request review → changes → review → approve (done)", () => {
    const { a, b, c, group } = trio();
    const task = createMemberGroupTask({
      groupId: group.id,
      actorSessionId: c,
      title: "  Parser  ",
      description: "grammar v2",
      reviewerSessionId: b,
    });
    expect(task).toMatchObject({
      status: "open",
      title: "Parser",
      createdBySessionId: c,
      reviewerSessionId: b,
    });
    expect(task.ownerSessionId).toBeUndefined();

    expect(claimGroupTask(group.id, task.id, a)).toMatchObject({
      status: "in_progress",
      ownerSessionId: a,
    });
    expect(requestGroupTaskReview(group.id, task.id, a, b)).toMatchObject({
      status: "in_review",
      ownerSessionId: a,
      reviewerSessionId: b,
    });
    expect(reviewGroupTask(group.id, task.id, b, "changes")).toMatchObject({
      status: "in_progress",
      ownerSessionId: a,
      reviewerSessionId: b,
    });
    // A new review may go to another member.
    expect(requestGroupTaskReview(group.id, task.id, a, c)).toMatchObject({
      status: "in_review",
      reviewerSessionId: c,
    });
    expect(reviewGroupTask(group.id, task.id, c, "approve")).toMatchObject({
      status: "done",
      ownerSessionId: a,
    });
  });

  it("release: the owner gives an in_progress task back (open, no owner); anyone may claim it", () => {
    const { a, b, group } = trio();
    const task = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "T" });
    claimGroupTask(group.id, task.id, a);
    const released = releaseGroupTask(group.id, task.id, a);
    expect(released.status).toBe("open");
    expect(released.ownerSessionId).toBeUndefined();
    expect(claimGroupTask(group.id, task.id, b)).toMatchObject({ ownerSessionId: b });
  });

  it("create: members only; the reviewer must be a member", () => {
    const { a, group, stranger } = trio();
    expectStoreError(
      () => createMemberGroupTask({ groupId: group.id, actorSessionId: stranger, title: "T" }),
      "not-a-member",
    );
    expectStoreError(
      () =>
        createMemberGroupTask({
          groupId: group.id,
          actorSessionId: a,
          title: "T",
          reviewerSessionId: stranger,
        }),
      "not-a-member",
    );
    expectStoreError(
      () => createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "  " }),
      "invalid-value",
    );
    expectStoreError(
      () => createMemberGroupTask({ groupId: "missing", actorSessionId: a, title: "T" }),
      "group-not-found",
    );
  });

  it("claim by the suggested reviewer clears the reviewer atomically; others keep it", () => {
    const { a, b, c, group } = trio();
    const suggested = createMemberGroupTask({
      groupId: group.id,
      actorSessionId: a,
      title: "T",
      reviewerSessionId: b,
    });
    const claimed = claimGroupTask(group.id, suggested.id, b);
    expect(claimed).toMatchObject({ status: "in_progress", ownerSessionId: b });
    expect(claimed.reviewerSessionId).toBeUndefined();
    expectStoreError(() => requestGroupTaskReview(group.id, suggested.id, b, b), "self-review");
    expect(requestGroupTaskReview(group.id, suggested.id, b, c)).toMatchObject({
      status: "in_review",
      reviewerSessionId: c,
    });

    const other = createMemberGroupTask({
      groupId: group.id,
      actorSessionId: a,
      title: "U",
      reviewerSessionId: b,
    });
    expect(claimGroupTask(group.id, other.id, c)).toMatchObject({
      ownerSessionId: c,
      reviewerSessionId: b,
    });
  });

  it("claim: task-taken when owned; invalid-transition when closed; members only", () => {
    const { a, b, group, stranger } = trio();
    const task = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "T" });
    claimGroupTask(group.id, task.id, a);
    expectStoreError(() => claimGroupTask(group.id, task.id, b), "task-taken");
    expectStoreError(() => claimGroupTask(group.id, task.id, a), "task-taken");
    const cancelled = createGroupTask({ groupId: group.id, title: "Old", status: "cancelled" });
    expectStoreError(() => claimGroupTask(group.id, cancelled.id, b), "invalid-transition");
    const done = createGroupTask({ groupId: group.id, title: "Shipped", status: "done" });
    expectStoreError(() => claimGroupTask(group.id, done.id, b), "invalid-transition");
    const open = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "U" });
    expectStoreError(() => claimGroupTask(group.id, open.id, stranger), "not-a-member");
    expectStoreError(() => claimGroupTask(group.id, "missing", a), "task-not-found");
    // A task of another group is not found from this one.
    const other = createAgentGroup({ name: "Other", workspaceId: insertWorkspace() });
    const foreign = createGroupTask({ groupId: other.id, title: "Foreign" });
    expectStoreError(() => claimGroupTask(group.id, foreign.id, a), "task-not-found");
    // A non-closed task whose owner vanished (FK null) reads as open: claimable.
    const orphan = createGroupTask({ groupId: group.id, title: "Orphan", status: "in_progress" });
    expect(claimGroupTask(group.id, orphan.id, b)).toMatchObject({
      status: "in_progress",
      ownerSessionId: b,
    });
  });

  it("release: owner only, and only from in_progress", () => {
    const { a, b, group } = trio();
    const task = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "T" });
    expectStoreError(() => releaseGroupTask(group.id, task.id, a), "not-owner");
    claimGroupTask(group.id, task.id, a);
    expectStoreError(() => releaseGroupTask(group.id, task.id, b), "not-owner");
    requestGroupTaskReview(group.id, task.id, a, b);
    expectStoreError(() => releaseGroupTask(group.id, task.id, a), "invalid-transition");
    reviewGroupTask(group.id, task.id, b, "approve");
    expectStoreError(() => releaseGroupTask(group.id, task.id, a), "invalid-transition");
  });

  it("request review: owner only, another member (self-review), only from in_progress", () => {
    const { a, b, c, group, stranger } = trio();
    const task = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "T" });
    expectStoreError(() => requestGroupTaskReview(group.id, task.id, a, b), "not-owner");
    claimGroupTask(group.id, task.id, a);
    expectStoreError(() => requestGroupTaskReview(group.id, task.id, b, c), "not-owner");
    expectStoreError(() => requestGroupTaskReview(group.id, task.id, a, a), "self-review");
    expectStoreError(() => requestGroupTaskReview(group.id, task.id, a, stranger), "not-a-member");
    requestGroupTaskReview(group.id, task.id, a, b);
    expectStoreError(() => requestGroupTaskReview(group.id, task.id, a, c), "invalid-transition");
    reviewGroupTask(group.id, task.id, b, "approve");
    expectStoreError(() => requestGroupTaskReview(group.id, task.id, a, b), "invalid-transition");
  });

  it("review: the pending review's reviewer only; closed tasks are invalid-transition", () => {
    const { a, b, c, group } = trio();
    const task = createMemberGroupTask({
      groupId: group.id,
      actorSessionId: a,
      title: "T",
      reviewerSessionId: b,
    });
    // A suggested reviewer has no rights before a review is requested.
    expectStoreError(() => reviewGroupTask(group.id, task.id, b, "approve"), "not-reviewer");
    claimGroupTask(group.id, task.id, a);
    expectStoreError(() => reviewGroupTask(group.id, task.id, b, "approve"), "not-reviewer");
    requestGroupTaskReview(group.id, task.id, a, b);
    expectStoreError(() => reviewGroupTask(group.id, task.id, a, "approve"), "not-reviewer");
    expectStoreError(() => reviewGroupTask(group.id, task.id, c, "changes"), "not-reviewer");
    expectStoreError(
      () => reviewGroupTask(group.id, task.id, b, "close" as "approve"),
      "invalid-value",
    );
    reviewGroupTask(group.id, task.id, b, "changes");
    // After changes the review is no longer pending.
    expectStoreError(() => reviewGroupTask(group.id, task.id, b, "approve"), "not-reviewer");
    requestGroupTaskReview(group.id, task.id, a, b);
    reviewGroupTask(group.id, task.id, b, "approve");
    expectStoreError(() => reviewGroupTask(group.id, task.id, b, "approve"), "invalid-transition");
    // `cancelled` is never produced by these transitions.
    expect(listGroupTasks(group.id, { status: "cancelled" })).toEqual([]);
  });

  it("the reviewer leaving during in_review drops the task to in_progress (existing rule)", () => {
    const { a, b, group } = trio();
    const task = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "T" });
    claimGroupTask(group.id, task.id, a);
    requestGroupTaskReview(group.id, task.id, a, b);
    removeAgentGroupMember(group.id, b);
    const [stored] = listGroupTasks(group.id);
    expect(stored).toMatchObject({ id: task.id, status: "in_progress", ownerSessionId: a });
    expect(stored?.reviewerSessionId).toBeUndefined();
    // The owner can ask someone else.
    expectStoreError(() => reviewGroupTask(group.id, task.id, b, "approve"), "not-reviewer");
  });

  it("the owner leaving during review sends it back to open; the old reviewer then gets not-reviewer", () => {
    const { a, b, c, group } = trio();
    const task = createMemberGroupTask({ groupId: group.id, actorSessionId: c, title: "T" });
    claimGroupTask(group.id, task.id, a);
    requestGroupTaskReview(group.id, task.id, a, b);
    removeAgentGroupMember(group.id, a);
    const [stored] = listGroupTasks(group.id);
    expect(stored).toMatchObject({ id: task.id, status: "open" });
    expect(stored?.ownerSessionId).toBeUndefined();
    expectStoreError(() => reviewGroupTask(group.id, task.id, b, "approve"), "not-reviewer");
    expectStoreError(() => reviewGroupTask(group.id, task.id, b, "changes"), "not-reviewer");
    // It is claimable again.
    expect(claimGroupTask(group.id, task.id, c)).toMatchObject({ ownerSessionId: c });
  });
});

describe("coordinator mode (PR 7)", () => {
  /** Squad (lead a) with a third member c and a stranger from the same Project. */
  function coordinated() {
    const fixture = projectGroupFixture();
    const c = insertSession(fixture.workspaceId);
    addAgentGroupMember({ groupId: fixture.group.id, sessionId: c });
    setAgentGroupLead(fixture.group.id, fixture.a);
    setAgentGroupMode(fixture.group.id, "coordinator");
    const stranger = insertSession(fixture.workspaceId);
    return { ...fixture, c, stranger };
  }

  it("persists the flag; without a Lead it is kept but inactive, and a new Lead coordinates", () => {
    const { a, b, group } = coordinated();
    expect(getAgentGroup(group.id)?.mode).toBe("coordinator");
    expect(listAgentGroupsWithMembers().find((item) => item.id === group.id)?.mode).toBe(
      "coordinator",
    );
    expect(isCoordinatorModeActive(getAgentGroup(group.id) ?? group)).toBe(true);
    setAgentGroupLead(group.id, null);
    const leaderless = getAgentGroup(group.id);
    expect(leaderless?.mode).toBe("coordinator");
    expect(isCoordinatorModeActive(leaderless ?? group)).toBe(false);
    setAgentGroupLead(group.id, b);
    expect(isCoordinatorModeActive(getAgentGroup(group.id) ?? group)).toBe(true);
    expect(isCoordinatorModeActive({ mode: "free", leadSessionId: a })).toBe(false);
    setAgentGroupMode(group.id, "free");
    expect(getAgentGroup(group.id)?.mode).toBe("free");
  });

  it("assign: an open task goes in_progress with the assignee (branch filled, reviewer cleared)", () => {
    const { a, b, c, group } = coordinated();
    const task = createMemberGroupTask({
      groupId: group.id,
      actorSessionId: c,
      title: "Parser",
      reviewerSessionId: b,
    });
    const result = assignGroupTask(group.id, task.id, a, b, { branch: "modus/group/b" });
    expect(result.previousOwnerSessionId).toBeUndefined();
    expect(result.task).toMatchObject({
      status: "in_progress",
      ownerSessionId: b,
      branch: "modus/group/b",
    });
    // The assignee was the suggested reviewer: cleared, like a claim.
    expect(result.task.reviewerSessionId).toBeUndefined();
    // The Lead may assign to itself.
    const own = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "Own" });
    expect(assignGroupTask(group.id, own.id, a, a).task).toMatchObject({
      status: "in_progress",
      ownerSessionId: a,
    });
  });

  it("assign: an in_progress task with another owner is reassigned; its branch never changes", () => {
    const { a, b, c, group } = coordinated();
    const task = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "T" });
    claimGroupTask(group.id, task.id, b, { branch: "modus/group/b" });
    // The old owner's branch stays: the record of where the earlier work is.
    const moved = assignGroupTask(group.id, task.id, a, c, { branch: "modus/group/c" });
    expect(moved.previousOwnerSessionId).toBe(b);
    expect(moved.task).toMatchObject({
      status: "in_progress",
      ownerSessionId: c,
      branch: "modus/group/b",
    });
    // The new owner's worktree only fills null branches: this one is kept.
    expect(fillMemberTaskBranches(group.id, c, "modus/group/c")).toEqual([]);
    expect(listGroupTasks(group.id).find((item) => item.id === task.id)?.branch).toBe(
      "modus/group/b",
    );
    // No branch stays no branch on reassignment.
    const bare = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "Bare" });
    claimGroupTask(group.id, bare.id, b);
    expect(assignGroupTask(group.id, bare.id, a, c, { branch: "modus/group/c" }).task.branch).toBe(
      undefined,
    );
    const back = assignGroupTask(group.id, task.id, a, b);
    expect(back.task).toMatchObject({ ownerSessionId: b, branch: "modus/group/b" });
    // Already the owner: nothing to reassign.
    expectStoreError(() => assignGroupTask(group.id, task.id, a, b), "invalid-transition");
  });

  it("assign: in_review, done and cancelled are invalid-transition", () => {
    const { a, b, c, group } = coordinated();
    const review = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "R" });
    claimGroupTask(group.id, review.id, b);
    requestGroupTaskReview(group.id, review.id, b, c);
    const done = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "D" });
    claimGroupTask(group.id, done.id, b);
    requestGroupTaskReview(group.id, done.id, b, c);
    reviewGroupTask(group.id, done.id, c, "approve");
    const cancelled = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "C" });
    cancelGroupTask(cancelled.id);
    for (const task of [review, done, cancelled]) {
      expectStoreError(() => assignGroupTask(group.id, task.id, a, c), "invalid-transition");
    }
  });

  it("assign: coordinator-off, not-coordinator, not-a-member and task-not-found", () => {
    const { a, b, group, stranger } = coordinated();
    const task = createMemberGroupTask({ groupId: group.id, actorSessionId: a, title: "T" });
    expectStoreError(() => assignGroupTask(group.id, task.id, b, a), "not-coordinator");
    expectStoreError(() => assignGroupTask(group.id, task.id, a, stranger), "not-a-member");
    expectStoreError(() => assignGroupTask(group.id, "missing", a, b), "task-not-found");
    const other = createAgentGroup({ name: "Other" });
    const foreign = createGroupTask({ groupId: other.id, title: "Foreign" });
    expectStoreError(() => assignGroupTask(group.id, foreign.id, a, b), "task-not-found");
    setAgentGroupLead(group.id, null);
    expectStoreError(() => assignGroupTask(group.id, task.id, a, b), "coordinator-off");
    setAgentGroupLead(group.id, a);
    setAgentGroupMode(group.id, "free");
    expectStoreError(() => assignGroupTask(group.id, task.id, a, b), "coordinator-off");
    expect(listGroupTasks(group.id).find((item) => item.id === task.id)?.status).toBe("open");
  });
});

describe("decisions", () => {
  it("records trimmed decisions and lists them newest first", () => {
    const { a, group } = projectGroupFixture();
    const source = appendGroupMessage({ groupId: group.id, authorKind: "user", body: "SQLite?" });
    const first = recordGroupDecision({
      groupId: group.id,
      text: "  Use SQLite  ",
      authorSessionId: a,
      sourceMessageId: source.id,
    });
    expect(first).toMatchObject({
      groupId: group.id,
      text: "Use SQLite",
      authorSessionId: a,
      sourceMessageId: source.id,
    });
    const second = recordGroupDecision({ groupId: group.id, text: "Ship weekly" });
    expect(second.authorSessionId).toBeUndefined();
    expect(second.sourceMessageId).toBeUndefined();
    expect(listGroupDecisions(group.id).map((d) => d.id)).toEqual([second.id, first.id]);
    expect(listGroupDecisions(createAgentGroup({ name: "Empty" }).id)).toEqual([]);
  });

  it("rejects empty or over-long text with invalid-text", () => {
    const { a, group } = projectGroupFixture();
    for (const text of ["", "   ", "x".repeat(GROUP_DECISION_MAX_CHARS + 1)]) {
      expectStoreError(
        () => recordGroupDecision({ groupId: group.id, text, authorSessionId: a }),
        "invalid-text",
      );
    }
    const padded = ` ${"y".repeat(GROUP_DECISION_MAX_CHARS)} `;
    expect(recordGroupDecision({ groupId: group.id, text: padded }).text).toHaveLength(
      GROUP_DECISION_MAX_CHARS,
    );
  });

  it("checks the group, the author's membership and the source message", () => {
    const { group } = projectGroupFixture();
    const outsider = insertSession(insertWorkspace());
    expectStoreError(
      () => recordGroupDecision({ groupId: "missing", text: "x" }),
      "group-not-found",
    );
    expectStoreError(
      () => recordGroupDecision({ groupId: group.id, text: "x", authorSessionId: outsider }),
      "not-a-member",
    );
    const other = createAgentGroup({ name: "Other" });
    const foreign = appendGroupMessage({ groupId: other.id, authorKind: "user", body: "hi" });
    expectStoreError(
      () => recordGroupDecision({ groupId: group.id, text: "x", sourceMessageId: foreign.id }),
      "message-not-found",
    );
    expect(listGroupDecisions(group.id)).toEqual([]);
  });

  it(`allows at most ${GROUP_DECISION_LIMIT} decisions per group (limit-reached)`, () => {
    const { a, group } = projectGroupFixture();
    for (let index = 0; index < GROUP_DECISION_LIMIT; index += 1) {
      recordGroupDecision({ groupId: group.id, text: `D${index}`, authorSessionId: a });
    }
    expectStoreError(
      () => recordGroupDecision({ groupId: group.id, text: "one more", authorSessionId: a }),
      "limit-reached",
    );
    expect(listGroupDecisions(group.id)).toHaveLength(GROUP_DECISION_LIMIT);
    // Other groups have their own limit; deleting frees a slot.
    const other = createAgentGroup({ name: "Other" });
    expect(recordGroupDecision({ groupId: other.id, text: "fine" }).text).toBe("fine");
    const [newest] = listGroupDecisions(group.id);
    deleteGroupDecision(newest?.id ?? "");
    expect(recordGroupDecision({ groupId: group.id, text: "again" }).text).toBe("again");
  });

  it("deletes a decision physically", () => {
    const { group } = projectGroupFixture();
    const keep = recordGroupDecision({ groupId: group.id, text: "Keep" });
    const drop = recordGroupDecision({ groupId: group.id, text: "Drop" });
    expect(deleteGroupDecision(drop.id)).toMatchObject({ id: drop.id, text: "Drop" });
    expect(listGroupDecisions(group.id).map((d) => d.id)).toEqual([keep.id]);
    expect(countRows("group_decisions", "id", drop.id)).toBe(0);
    expectStoreError(() => deleteGroupDecision(drop.id), "decision-not-found");
  });

  it("migrates the legacy group_decisions shape (active rows kept, author carried over)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "modus-group-decisions-migrate-"));
    const db = new DatabaseSync(join(dir, "modus.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(db);
      const now = new Date().toISOString();
      db.exec(`drop table group_decisions;
        create table group_decisions (
          id text primary key,
          group_id text not null references agent_groups(id) on delete cascade,
          text text not null,
          source_message_id text references group_messages(id) on delete set null,
          created_by_session_id text references agent_sessions(id) on delete set null,
          created_at text not null,
          superseded_by_id text references group_decisions(id) on delete set null
        );
        create index idx_group_decisions_group_created on group_decisions(group_id, created_at);`);
      db.prepare(
        `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
         values ('w', 'root-w', 'repo', 1, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
         values ('s', 'w', 'Chat', 'root-w', 'idle', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `insert into agent_groups (id, name, workspace_id, mode, created_at, updated_at)
         values ('g', 'G', 'w', 'free', ?, ?)`,
      ).run(now, now);
      const insert = db.prepare(
        `insert into group_decisions (id, group_id, text, created_by_session_id, created_at, superseded_by_id)
         values (?, 'g', ?, ?, ?, ?)`,
      );
      insert.run("new", "Use WAL", "s", now, null);
      insert.run("old", "Use SQLite", "s", now, "new");
      insert.run("user", "Ship weekly", null, now, null);

      migrateDatabase(db);
      migrateDatabase(db);

      const columns = (
        db.prepare("PRAGMA table_info(group_decisions)").all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(columns).toEqual([
        "id",
        "group_id",
        "text",
        "author_session_id",
        "source_message_id",
        "created_at",
        "execution_id",
      ]);
      const rows = db
        .prepare("select id, text, author_session_id from group_decisions order by id")
        .all();
      expect(rows).toEqual([
        { id: "new", text: "Use WAL", author_session_id: "s" },
        { id: "user", text: "Ship weekly", author_session_id: null },
      ]);
      const indexes = (
        db.prepare("PRAGMA index_list(group_decisions)").all() as Array<{ name: string }>
      ).map((index) => index.name);
      expect(indexes).toContain("idx_group_decisions_group_created");
      expect(indexes).toContain("idx_group_decisions_execution");
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("deletion semantics", () => {
  it("deleting a group removes its rows, agents and room sessions and returns them to tear down", () => {
    const { workspaceId, a, b, group } = projectGroupFixture();
    insertEvent(a);
    insertEvent(a);
    insertRun(b);
    appendGroupMessage({ groupId: group.id, authorKind: "agent", authorSessionId: a, body: "hi" });
    createGroupTask({ groupId: group.id, title: "Task", ownerSessionId: b });
    recordGroupDecision({ groupId: group.id, text: "Decision" });

    expect(deleteAgentGroup(group.id).sort()).toEqual([a, b].sort());

    for (const table of [
      "agent_group_members",
      "group_messages",
      "group_tasks",
      "group_decisions",
    ]) {
      expect(countRows(table, "group_id", group.id)).toBe(0);
    }
    // One group per agent (A2): the group takes its agents with it; their hidden
    // room sessions are detached and returned, and the caller tears each tree
    // down after the commit (agents/agent-teardown), which ends with the row.
    expect(getAgentSession(a)?.kind).toBe("group_member");
    for (const id of [a, b]) deleteAgentSession(id);
    expect(getAgentSession(a)).toBeUndefined();
    expect(getAgentSession(b)).toBeUndefined();
    expect(countRows("agents", "group_id", group.id)).toBe(0);
    expect(countRows("agent_events", "session_id", a)).toBe(0);
    expect(countRows("agent_runs", "session_id", b)).toBe(0);
    expect(workspaceId).toBeTruthy();
    const listed = listAgentSessions().map((session) => session.id);
    expect(listed).not.toContain(a);
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
    const decision = recordGroupDecision({ groupId: group.id, text: "D", authorSessionId: a });

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
    const [storedDecision] = listGroupDecisions(group.id);
    expect(storedDecision?.id).toBe(decision.id);
    expect(storedDecision?.authorSessionId).toBeUndefined();

    // The group keeps working after the deletion.
    expect(
      appendGroupMessage({ groupId: group.id, authorKind: "agent", authorSessionId: b, body: "ok" })
        .authorSessionId,
    ).toBe(b);
  });
});

describe("createAgentGroupWithMembers (all or nothing)", () => {
  function groupRowCount(): number {
    return Number(
      (getDatabase().prepare("select count(*) as n from agent_groups").get() as { n: number }).n,
    );
  }
  function memberRowCount(): number {
    return Number(
      (
        getDatabase().prepare("select count(*) as n from agent_group_members").get() as {
          n: number;
        }
      ).n,
    );
  }

  it("creates the group, its members and its lead in one step", () => {
    const workspaceId = insertWorkspace();
    const a = insertSession(workspaceId);
    const b = insertSession(workspaceId);

    const created = createAgentGroupWithMembers({
      name: "  Crew ",
      workspaceId,
      members: [{ sessionId: a, role: "implement" }, { sessionId: b }],
      leadSessionId: b,
    });

    expect(created).toMatchObject({
      name: "Crew",
      workspaceId,
      mode: "coordinator",
      leadSessionId: b,
    });
    expect(created.members).toEqual([
      expect.objectContaining({ sessionId: a, role: "implement" }),
      expect.objectContaining({ sessionId: b }),
    ]);
    expect(listAgentGroupsWithMembers({ workspaceId })).toEqual([created]);
  });

  it("writes nothing when the second member is already in a group", () => {
    const workspaceId = insertWorkspace();
    const a = insertSession(workspaceId);
    const taken = insertSession(workspaceId);
    createAgentGroupWithMembers({
      name: "Existing",
      workspaceId,
      members: [{ sessionId: taken }, { sessionId: insertSession(workspaceId) }],
    });
    const groupsBefore = groupRowCount();
    const membersBefore = memberRowCount();

    expectStoreError(
      () =>
        createAgentGroupWithMembers({
          id: "group-rolled-back",
          name: "Doomed",
          workspaceId,
          members: [{ sessionId: a }, { sessionId: taken }],
          leadSessionId: a,
        }),
      "already-in-group",
    );

    expect(groupRowCount()).toBe(groupsBefore);
    expect(memberRowCount()).toBe(membersBefore);
    expect(getAgentGroup("group-rolled-back")).toBeUndefined();
    expect(getAgentGroupForSession(a)).toBeUndefined();
    expect(countRows("agent_groups", "lead_session_id", a)).toBe(0);
  });

  it("writes nothing when the second member is from another workspace", () => {
    const workspaceId = insertWorkspace();
    const a = insertSession(workspaceId);
    const foreign = insertSession(insertWorkspace());
    const groupsBefore = groupRowCount();
    const membersBefore = memberRowCount();

    expectStoreError(
      () =>
        createAgentGroupWithMembers({
          name: "Mismatch",
          workspaceId,
          members: [{ sessionId: a }, { sessionId: foreign }],
          leadSessionId: a,
        }),
      "workspace-mismatch",
    );

    expect(groupRowCount()).toBe(groupsBefore);
    expect(memberRowCount()).toBe(membersBefore);
    expect(getAgentGroupForSession(a)).toBeUndefined();
  });

  it("rejects a lead outside the members and duplicate members before writing", () => {
    const workspaceId = insertWorkspace();
    const a = insertSession(workspaceId);
    const b = insertSession(workspaceId);
    const groupsBefore = groupRowCount();

    expectStoreError(
      () =>
        createAgentGroupWithMembers({
          name: "Bad lead",
          workspaceId,
          members: [{ sessionId: a }, { sessionId: insertSession(workspaceId) }],
          leadSessionId: b,
        }),
      "not-a-member",
    );
    expectStoreError(
      () =>
        createAgentGroupWithMembers({
          name: "Dupes",
          workspaceId,
          members: [{ sessionId: a }, { sessionId: a }],
        }),
      "invalid-value",
    );
    expectStoreError(
      () =>
        createAgentGroupWithMembers({
          name: "Ghost project",
          workspaceId: "missing-workspace",
          members: [{ sessionId: a }, { sessionId: b }],
        }),
      "workspace-not-found",
    );
    expect(groupRowCount()).toBe(groupsBefore);
  });

  it("groups without a Project take chats from the Chats inbox", () => {
    const inbox = insertSession(CHATS_WORKSPACE_ID);
    const created = createAgentGroupWithMembers({
      name: "Inbox crew",
      members: [{ sessionId: inbox }, { sessionId: insertSession(CHATS_WORKSPACE_ID) }],
      leadSessionId: inbox,
    });
    expect(created.workspaceId).toBeUndefined();
    expect(created.leadSessionId).toBe(inbox);
    expect(listAgentGroupsWithMembers({ workspaceId: null }).map((g) => g.id)).toContain(
      created.id,
    );
  });
});

describe("updateAgentGroupMembers (all or nothing)", () => {
  it("adds, removes and changes the lead in one step; zero members is allowed", () => {
    const { workspaceId, a, b, group } = projectGroupFixture();
    const c = insertSession(workspaceId);
    setAgentGroupLead(group.id, a);
    const task = createGroupTask({
      groupId: group.id,
      title: "T",
      status: "in_progress",
      ownerSessionId: a,
    });

    const updated = updateAgentGroupMembers(group.id, {
      members: [{ sessionId: b }, { sessionId: c, role: "verify" }],
      leadSessionId: c,
    });

    expect(updated.leadSessionId).toBe(c);
    expect(updated.members.map((m) => [m.sessionId, m.role])).toEqual([
      [b, "review"],
      [c, "verify"],
    ]);
    // The removed member went through the removeAgentGroupMember path.
    const [storedTask] = listGroupTasks(group.id);
    expect(storedTask?.id).toBe(task.id);
    expect(storedTask?.status).toBe("open");
    expect(storedTask?.ownerSessionId).toBeUndefined();

    const emptied = updateAgentGroupMembers(group.id, { members: [], leadSessionId: null });
    expect(emptied.members).toEqual([]);
    expect(emptied.leadSessionId).toBeUndefined();
  });

  it("writes nothing when an added member is refused", () => {
    const { workspaceId, a, b, group } = projectGroupFixture();
    setAgentGroupLead(group.id, a);
    const task = createGroupTask({ groupId: group.id, title: "T", ownerSessionId: a });
    const archived = insertSession(workspaceId);
    getDatabase()
      .prepare("update agent_sessions set archived_at = ? where id = ?")
      .run(new Date().toISOString(), archived);
    const before = { group: getAgentGroup(group.id), members: listAgentGroupMembers(group.id) };

    // Would remove `a` and add an archived session: the refusal must undo the removal too.
    expectStoreError(
      () =>
        updateAgentGroupMembers(group.id, {
          members: [{ sessionId: b }, { sessionId: archived }],
          leadSessionId: b,
        }),
      "archived-session",
    );

    expect(getAgentGroup(group.id)).toEqual(before.group);
    expect(listAgentGroupMembers(group.id)).toEqual(before.members);
    expect(listGroupTasks(group.id)).toEqual([task]);
  });

  it("rejects a lead outside the target members before writing", () => {
    const { a, b, group } = projectGroupFixture();
    expectStoreError(
      () => updateAgentGroupMembers(group.id, { members: [{ sessionId: a }], leadSessionId: b }),
      "not-a-member",
    );
    expect(listAgentGroupMembers(group.id).map((m) => m.sessionId)).toEqual([a, b]);
  });
});

describe("archiving a member", () => {
  it("removes it from its group: lead cleared, open task released owner-first", () => {
    const { a, b, group } = projectGroupFixture();
    setAgentGroupLead(group.id, a);
    const task = createGroupTask({
      groupId: group.id,
      title: "Owned",
      status: "in_progress",
      ownerSessionId: a,
      reviewerSessionId: b,
    });

    setAgentSessionArchived(a, true);

    expect(getAgentGroupForSession(a)).toBeUndefined();
    expect(listAgentGroupMembers(group.id).map((m) => m.sessionId)).toEqual([b]);
    expect(getAgentGroup(group.id)?.leadSessionId).toBeUndefined();
    const [stored] = listGroupTasks(group.id);
    expect(stored?.id).toBe(task.id);
    expect(stored?.status).toBe("open");
    expect(stored?.ownerSessionId).toBeUndefined();
    expect(stored?.reviewerSessionId).toBe(b);

    // Restoring does not re-add it.
    setAgentSessionArchived(a, false);
    expect(getAgentGroupForSession(a)).toBeUndefined();
  });

  it("joins a caller's transaction instead of nesting one", () => {
    const { a, group } = projectGroupFixture();
    const db = getDatabase();
    db.exec("begin");
    try {
      setAgentSessionArchived(a, true);
    } finally {
      db.exec("rollback");
    }
    // Rolled back together with the caller's transaction.
    expect(getAgentSession(a)?.archivedAt).toBeUndefined();
    expect(getAgentGroupForSession(a)?.id).toBe(group.id);
  });
});
