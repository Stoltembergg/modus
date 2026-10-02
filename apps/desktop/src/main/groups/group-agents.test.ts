import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { allocateUniqueGroupAvatarShapes, CHATS_WORKSPACE_ID } from "../../shared/contracts";

/* Agents model (A2): membership by agent, the folder rule, and the A2 migration. */

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

/* The session teardown's side effects (A3 review): runtime dispose and checkpoint refs. */
const teardown = vi.hoisted(() => ({
  disposed: [] as string[],
  checkpoints: [] as Array<{ sessionId: string; cwd: string }>,
}));
vi.mock("../agent/runtime-registry", () => ({
  getAgentRuntime: () => ({
    dispose: async (sessionId: string) => {
      teardown.disposed.push(sessionId);
    },
  }),
}));
vi.mock("../agent/checkpoint-service", () => ({
  deleteSessionCheckpoints: async (sessionId: string, cwd: string) => {
    teardown.checkpoints.push({ sessionId, cwd });
  },
}));

const { getDatabase, migrateDatabase } = await import("../db/database");
const { getAgentSession, listAgentSessions } = await import("../agent/agent-store");
const { ensureChatsWorkspace } = await import("../workspace/workspace-store");
const {
  createAgent,
  createAgentInGroup,
  createGroupWithNewAgents,
  deleteAgent,
  getAgent,
  agentChatBlockedReason,
  agentChatPersonaPrompt,
  openAgentChat,
  requireAgentChatWritable,
  updateAgent,
  updateGroupMembers,
} = await import("../agents/agents-store");
const {
  addAgentToGroup,
  appendGroupMessage,
  createAgentGroupWithMembers,
  deleteAgentGroup,
  getAgentGroup,
  getAgentGroupWithMembers,
  listAgentGroupMembers,
  listGroupMessages,
  removeAgentFromGroup,
  setAgentGroupWorkspace,
  setGroupMembershipMessageSink,
} = await import("./group-store");
const { groupBlockedReason } = await import("../../shared/group-blocked");
const { insertLegacyGroup } = await import("./legacy-group.fixture");
const {
  deleteAgentWithSessions,
  deleteGroupWithSessions,
  removeMemberWithSessions,
  teardownDetachedSessions,
} = await import("../agents/agent-teardown");
const { removeProject } = await import("../workspace/workspace-service");

/**
 * The store detaches sessions; the caller tears them down after the commit.
 * Tests that go through the store directly do the same (the argument is
 * evaluated first, so a store error still throws synchronously).
 */
async function torn<T extends string[] | { removedSessionIds: string[] }>(result: T): Promise<T> {
  await teardownDetachedSessions(Array.isArray(result) ? result : result.removedSessionIds);
  return result;
}

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function insertWorkspace(db: DatabaseSync = getDatabase()): string {
  const id = uid("ws");
  const now = new Date().toISOString();
  db.prepare(
    `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
     values (?, ?, 'repo', 1, ?, ?)`,
  ).run(id, `/root/${id}`, now, now);
  return id;
}

function insertSession(workspaceId: string, title: string, db: DatabaseSync = getDatabase()) {
  const id = uid("s");
  const now = new Date().toISOString();
  db.prepare(
    `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
     values (?, ?, ?, ?, 'idle', ?, ?)`,
  ).run(id, workspaceId, title, `/root/${workspaceId}`, now, now);
  return id;
}

function expectCode(fn: () => unknown, code: string): void {
  expect(fn).toThrow(expect.objectContaining({ code }));
}

function replaceAgentsWithLegacyAvatarCheck(db: DatabaseSync): void {
  db.exec(`pragma foreign_keys = off;
    begin;
    create table agents_legacy_avatar_check (
      id text primary key,
      group_id text references agent_groups(id) on delete cascade,
      name text not null collate nocase,
      role text not null default '',
      instructions text not null default '',
      model_id text,
      default_workspace_id text references workspaces(id) on delete set null,
      avatar_face text not null,
      avatar_color text not null,
      avatar_shape text not null check (avatar_shape in (
        'circle','squircle','roundedSquare','hexagon','capsule','blob','diamond','shield'
      )),
      template_id text,
      created_at text not null,
      updated_at text not null,
      archived_at text,
      unique (group_id, name)
    );
    insert into agents_legacy_avatar_check
      (id, group_id, name, role, instructions, model_id, default_workspace_id,
       avatar_face, avatar_color, avatar_shape, template_id, created_at, updated_at, archived_at)
      select id, group_id, name, role, instructions, model_id, default_workspace_id,
       avatar_face, avatar_color, avatar_shape, template_id, created_at, updated_at, archived_at
      from agents;
    drop table agents;
    alter table agents_legacy_avatar_check rename to agents;
    commit;
    pragma foreign_keys = on;`);
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-group-agents-test-"));
  ensureChatsWorkspace();
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

const MODEL = "openai/gpt-5";

function newAgents(count: number, prefix = "Agent") {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix} ${index + 1}`,
    role: index === 0 ? "Lead" : "Builder",
    modelId: MODEL,
  }));
}

function newGroup(count = 2, workspaceId: string | null = insertWorkspace()) {
  return createGroupWithNewAgents({ name: uid("G"), workspaceId, members: newAgents(count) });
}

/** A legacy group outside 2..10 (rows written directly: the stores refuse to build one). */
function legacyGroup(count: number) {
  const workspaceId = insertWorkspace();
  return insertLegacyGroup({
    name: uid("Legacy"),
    workspaceId,
    sessionIds: Array.from({ length: count }, (_, index) =>
      insertSession(workspaceId, `Old ${index + 1}`),
    ),
  });
}

function statusLines(groupId: string): string[] {
  return listGroupMessages(groupId, { limit: 200 })
    .filter((message) => message.kind === "status")
    .map((message) => message.body);
}

function countRows(table: string, column: string, value: string): number {
  const row = getDatabase()
    .prepare(`select count(*) as count from ${table} where ${column} = ?`)
    .get(value) as { count: number };
  return Number(row.count);
}

/** 1:1 chats (A3) whose agent is gone, and agent chats with no agent link: both must be 0. */
function orphanAgentChats(): number {
  const row = getDatabase()
    .prepare(
      `select count(*) as count from agent_sessions
       where agent_id is not null and agent_id not in (select id from agents)`,
    )
    .get() as { count: number };
  return Number(row.count);
}

function orphanRoomSessions(): number {
  const row = getDatabase()
    .prepare(
      `select count(*) as count from agent_sessions where kind = 'group_member'
       and id not in (select session_id from agent_group_members)`,
    )
    .get() as { count: number };
  return Number(row.count);
}

describe("one group per agent", () => {
  it("group:create makes its NEW agents, each with a hidden room session in the Project", () => {
    const ws = insertWorkspace();
    const group = createGroupWithNewAgents({
      name: "Squad",
      workspaceId: ws,
      members: [
        { name: "Jennie", role: "Fixer", modelId: MODEL },
        { name: "Bob", modelId: MODEL },
      ],
      leadName: "jennie",
    });
    const [jennie, bob] = group.members;
    expect(jennie).toMatchObject({ name: "Jennie", agentRole: "Fixer" });
    expect(getAgent(jennie?.agentId ?? "")?.groupId).toBe(group.id);
    expect(group.leadSessionId).toBe(jennie?.sessionId);
    expect(getAgentSession(jennie?.sessionId ?? "")).toMatchObject({
      workspaceId: ws,
      cwd: `/root/${ws}`,
      title: "Jennie",
      model: MODEL,
      kind: "group_member",
    });
    expect(bob?.sessionId).not.toBe(jennie?.sessionId);
    const listed = listAgentSessions().map((session) => session.id);
    expect(listed).not.toContain(jennie?.sessionId);
    // Creating a group posts no join lines.
    expect(statusLines(group.id)).toEqual([]);
  });

  it("assigns unique avatar shapes when a group is built from existing sessions", () => {
    const workspaceId = insertWorkspace();
    const sessions = Array.from({ length: 10 }, (_, index) =>
      insertSession(workspaceId, `Session member ${index + 1}`),
    );

    const group = createAgentGroupWithMembers({
      name: uid("Adopt sessions"),
      workspaceId,
      members: sessions.map((sessionId) => ({ sessionId })),
    });

    expect(new Set(group.members.map((member) => member.avatarShape)).size).toBe(10);
  });

  it("assigns different shapes when group members share a template default", () => {
    const group = createGroupWithNewAgents({
      name: uid("Template shapes"),
      workspaceId: insertWorkspace(),
      members: [
        { name: "Member 1", templateId: "reviewer" },
        { name: "Member 5", templateId: "reviewer" },
      ],
    });

    expect(group.members.map((member) => member.avatarShape)).toEqual(["roundedSquare", "circle"]);
    expect(new Set(group.members.map((member) => member.avatarShape)).size).toBe(2);
  });

  it("assigns an unused shape when a deterministic template default is already taken", () => {
    const group = createGroupWithNewAgents({
      name: uid("Template addition"),
      workspaceId: insertWorkspace(),
      members: [
        { name: "Member 1", templateId: "reviewer" },
        { name: "Member 5", templateId: "reviewer" },
      ],
    });

    const added = createAgentInGroup({
      groupId: group.id,
      name: "Member 6",
      templateId: "reviewer",
    });

    expect(added.avatarShape).toBe("squircle");
    expect(new Set([...group.members, added].map((member) => member.avatarShape)).size).toBe(3);
  });

  it("assigns an available shape when adopting an ungrouped agent", () => {
    const group = createGroupWithNewAgents({
      name: uid("Adopt shape"),
      workspaceId: insertWorkspace(),
      members: [
        { name: "Circle", modelId: MODEL, avatarShape: "circle" },
        { name: "Pentagon", modelId: MODEL, avatarShape: "pentagon" },
      ],
    });
    const legacy = createAgent({ name: uid("Legacy"), avatarShape: "circle" });

    expect(group.members.map((member) => member.avatarShape)).toEqual(["circle", "pentagon"]);
    const existing = getDatabase()
      .prepare("select id, avatar_shape from agents where group_id = ? order by id")
      .all(group.id) as Array<{ id: string; avatar_shape: "circle" | "pentagon" }>;
    expect(new Set(existing.map((member) => member.avatar_shape))).toEqual(
      new Set(["circle", "pentagon"]),
    );
    expect(
      allocateUniqueGroupAvatarShapes([
        ...existing.map((member) => ({ agentId: member.id, preferredShape: member.avatar_shape })),
        { agentId: legacy.id, preferredShape: "circle" },
      ]).get(legacy.id),
    ).toBe("squircle");

    addAgentToGroup({ groupId: group.id, agentId: legacy.id });

    expect(getAgent(legacy.id)?.avatarShape).toBe("squircle");
    expect(
      new Set([
        ...group.members.map((member) => member.avatarShape),
        getAgent(legacy.id)?.avatarShape,
      ]).size,
    ).toBe(3);
  });

  it("names are unique per group: the same name is fine in another group", () => {
    const one = createGroupWithNewAgents({
      name: "One",
      workspaceId: insertWorkspace(),
      members: [
        { name: "Twin", modelId: MODEL },
        { name: "Other", modelId: MODEL },
      ],
    });
    const two = createGroupWithNewAgents({
      name: "Two",
      workspaceId: insertWorkspace(),
      members: [
        { name: "twin", modelId: MODEL },
        { name: "Other", modelId: MODEL },
      ],
    });
    expect(two.members.map((member) => member.name)).toEqual(["twin", "Other"]);
    expectCode(
      () => createAgentInGroup({ groupId: one.id, name: "TWIN", modelId: MODEL }),
      "agent-name-taken",
    );
    // An agent cannot join a second group.
    const agentOfOne = one.members[0]?.agentId ?? "";
    expectCode(() => addAgentToGroup({ groupId: two.id, agentId: agentOfOne }), "already-in-group");
  });

  it.each([
    [1, "group-min-members"],
    [2, null],
    [10, null],
    [11, "group-max-members"],
  ])("create with %i members → %s", (count, code) => {
    const ws = insertWorkspace();
    const create = () =>
      createGroupWithNewAgents({ name: uid("N"), workspaceId: ws, members: newAgents(count) });
    if (code) {
      expectCode(create, code);
      expect(
        getDatabase().prepare("select 1 from agent_groups where workspace_id = ?").get(ws),
      ).toBeUndefined();
    } else {
      expect(create().members).toHaveLength(count);
    }
  });

  it("an 11th member is refused; archived agents count toward the total", () => {
    const group = newGroup(10);
    const archived = group.members[3]?.agentId ?? "";
    getDatabase().prepare("update agents set archived_at = ? where id = ?").run("x", archived);
    expectCode(
      () => createAgentInGroup({ groupId: group.id, name: "Eleventh", modelId: MODEL }),
      "group-max-members",
    );
    expect(listAgentGroupMembers(group.id)).toHaveLength(10);
  });

  it("removing a member = deleting its agent; refused when only 2 are left", async () => {
    const group = newGroup(3);
    const [a, b, c] = group.members;
    await torn(removeAgentFromGroup(group.id, c?.sessionId ?? ""));
    expect(getAgent(c?.agentId ?? "")).toBeUndefined();
    expect(getAgentSession(c?.sessionId ?? "")).toBeUndefined();
    expect(statusLines(group.id)).toEqual(["Agent 3 left the group"]);
    expectCode(() => removeAgentFromGroup(group.id, b?.sessionId ?? ""), "group-min-members");
    expectCode(() => deleteAgent(a?.agentId ?? ""), "group-min-members");
    expect(listAgentGroupMembers(group.id)).toHaveLength(2);
    expectCode(
      () =>
        updateGroupMembers({
          groupId: group.id,
          add: [],
          removeAgentIds: [b?.agentId ?? ""],
          lead: null,
        }),
      "group-min-members",
    );
  });

  it("joining posts 'X joined as <role>' (the agent role, else 'member')", () => {
    const group = newGroup(2);
    createAgentInGroup({ groupId: group.id, name: "Rita", role: "Reviewer", modelId: MODEL });
    createAgentInGroup({ groupId: group.id, name: "Plain", modelId: MODEL });
    // Both events can share one millisecond (messages then tie-break by id), so compare as a set.
    expect(statusLines(group.id).sort()).toEqual([
      "Plain joined as member",
      "Rita joined as Reviewer",
    ]);
    const rita = listAgentGroupMembers(group.id).find((member) => member.name === "Rita");
    expect(getAgent(rita?.agentId ?? "")?.groupId).toBe(group.id);
  });

  it("a legacy group left with 1 member is blocked (min-members) until an agent is added", () => {
    const group = legacyGroup(1);
    expect(groupBlockedReason(group, listAgentGroupMembers(group.id))).toBe("min-members");
    createAgentInGroup({ groupId: group.id, name: "Rescuer", modelId: MODEL });
    expect(groupBlockedReason(group, listAgentGroupMembers(group.id))).toBeNull();
  });

  it("a legacy group with 11 members is not blocked, but adding is refused", async () => {
    const group = legacyGroup(11);
    expect(groupBlockedReason(group, listAgentGroupMembers(group.id))).toBeNull();
    expectCode(
      () => createAgentInGroup({ groupId: group.id, name: "Twelfth", modelId: MODEL }),
      "group-max-members",
    );
    // Shrinking stays allowed.
    await torn(removeAgentFromGroup(group.id, group.members[0]?.sessionId ?? ""));
    expect(listAgentGroupMembers(group.id)).toHaveLength(10);
  });

  it.each([
    ["null", null],
    ["the Chats inbox", CHATS_WORKSPACE_ID],
  ])("a group needs a Project: %s fails with group-project-required", (_label, workspaceId) => {
    expectCode(
      () => createGroupWithNewAgents({ name: "G", workspaceId, members: newAgents(2) }),
      "group-project-required",
    );
    const group = newGroup(2);
    expectCode(() => setAgentGroupWorkspace(group.id, workspaceId), "group-project-required");
    getDatabase()
      .prepare("update agent_groups set workspace_id = ? where id = ?")
      .run(workspaceId, group.id);
    expect(groupBlockedReason(getAgentGroup(group.id) ?? {}, 2)).toBe("project-required");
    // No Project: no room session can be made, so no agent can join either.
    expectCode(
      () => createAgentInGroup({ groupId: group.id, name: "Late", modelId: MODEL }),
      "group-project-required",
    );
  });

  it("moving a group moves its room sessions with it (workspace and cwd), in one step", () => {
    const to = insertWorkspace();
    const group = newGroup(2);
    const sessionId = group.members[0]?.sessionId ?? "";
    expect(setAgentGroupWorkspace(group.id, to).workspaceId).toBe(to);
    expect(getAgentSession(sessionId)).toMatchObject({ workspaceId: to, cwd: `/root/${to}` });
    expectCode(() => setAgentGroupWorkspace(group.id, "missing"), "workspace-not-found");
    expect(getAgentSession(sessionId)?.workspaceId).toBe(to);
  });

  it("deleting a group deletes its agents, their room sessions, 1:1 chats and all messages: no orphans", async () => {
    const group = newGroup(3);
    appendGroupMessage({ groupId: group.id, authorKind: "user", body: "hi" });
    const chats = group.members.slice(0, 2).map((member) => openAgentChat(member.agentId).id);
    const ids = await torn(deleteAgentGroup(group.id));
    expect(ids.sort()).toEqual(
      [...group.members.map((member) => member.sessionId), ...chats].sort(),
    );
    for (const member of group.members) {
      expect(getAgent(member.agentId)).toBeUndefined();
      expect(getAgentSession(member.sessionId)).toBeUndefined();
    }
    for (const chat of chats) expect(getAgentSession(chat)).toBeUndefined();
    expect(listGroupMessages(group.id, { limit: 10 })).toEqual([]);
    expect(orphanRoomSessions()).toBe(0);
    expect(orphanAgentChats()).toBe(0);
  });

  it("deleting a Project deletes its groups, their agents and sessions; other chats stay", async () => {
    const ws = insertWorkspace();
    const chat = insertSession(CHATS_WORKSPACE_ID, "A chat elsewhere");
    const ungrouped = createAgent({ name: uid("Loose") });
    const group = newGroup(2, ws);
    appendGroupMessage({ groupId: group.id, authorKind: "user", body: "hi" });
    const oneToOne = openAgentChat(group.members[0]?.agentId ?? "").id;
    // "Remove project": tears its chats (the 1:1 included) and room sessions down, then the row.
    await removeProject(ws);
    expect(getAgentSession(oneToOne)).toBeUndefined();
    expect(orphanAgentChats()).toBe(0);
    expect(getAgentGroup(group.id)).toBeUndefined();
    expect(countRows("agents", "group_id", group.id)).toBe(0);
    for (const member of group.members) {
      expect(getAgent(member.agentId)).toBeUndefined();
      expect(getAgentSession(member.sessionId)).toBeUndefined();
    }
    expect(listGroupMessages(group.id, { limit: 10 })).toEqual([]);
    expect(orphanRoomSessions()).toBe(0);
    expect(getAgentSession(chat)).toBeDefined();
    expect(getAgent(ungrouped.id)).toBeDefined();
  });
});

describe("an agent's 1:1 chat (A3)", () => {
  it("is made on first open: a normal chat in the group's Project, linked to the agent, reused", () => {
    const ws = insertWorkspace();
    const group = newGroup(2, ws);
    const agentId = group.members[0]?.agentId ?? "";
    const chat = openAgentChat(agentId);
    expect(chat).toMatchObject({
      workspaceId: ws,
      cwd: `/root/${ws}`,
      title: "Agent 1",
      model: MODEL,
      agentId,
      status: "idle",
    });
    expect(chat.kind).toBeUndefined();
    expect(listAgentSessions().map((session) => session.id)).toContain(chat.id);
    expect(openAgentChat(agentId).id).toBe(chat.id);
    expect(countRows("agent_sessions", "agent_id", agentId)).toBe(1);
    // Renaming the agent renames its chat; moving the group moves the chat with it.
    updateAgent(agentId, { name: "Renamed" });
    expect(getAgentSession(chat.id)?.title).toBe("Renamed");
    const to = insertWorkspace();
    setAgentGroupWorkspace(group.id, to);
    expect(getAgentSession(chat.id)).toMatchObject({ workspaceId: to, cwd: `/root/${to}` });
  });

  it("changing modelId rebinds the room session and the 1:1 chat for the next turn", () => {
    const group = newGroup(2);
    const member = group.members[0];
    const agentId = member?.agentId ?? "";
    const roomSessionId = member?.sessionId ?? "";
    const chat = openAgentChat(agentId);
    expect(getAgentSession(roomSessionId)?.model).toBe(MODEL);
    expect(chat.model).toBe(MODEL);

    const nextModel = "openai/gpt-6-luna";
    updateAgent(agentId, { modelId: nextModel });
    expect(getAgent(agentId)?.modelId).toBe(nextModel);
    expect(getAgentSession(roomSessionId)?.model).toBe(nextModel);
    expect(getAgentSession(chat.id)?.model).toBe(nextModel);
  });

  it("a group without a Project lists its agents but cannot make a new chat", () => {
    const group = newGroup(2);
    const [first, second] = group.members;
    const existing = openAgentChat(first?.agentId ?? "").id;
    expect(agentChatBlockedReason(existing)).toBeNull();
    getDatabase().prepare("update agent_groups set workspace_id = null where id = ?").run(group.id);
    expect(listAgentGroupMembers(group.id)).toHaveLength(2);
    // The existing chat still opens, READ-ONLY: sending is refused like in the room.
    expect(openAgentChat(first?.agentId ?? "").id).toBe(existing);
    expect(agentChatBlockedReason(existing)).toBe("project-required");
    expectCode(() => requireAgentChatWritable(existing), "group-project-required");
    expectCode(() => openAgentChat(second?.agentId ?? ""), "group-project-required");
    // Other sessions are never blocked by this rule.
    expect(agentChatBlockedReason(group.members[0]?.sessionId ?? "")).toBeNull();
  });

  it("removing a member (deleting its agent) deletes its 1:1 chat too", async () => {
    const group = newGroup(3);
    const leaving = group.members[2];
    const chat = openAgentChat(leaving?.agentId ?? "").id;
    expect(await torn(removeAgentFromGroup(group.id, leaving?.sessionId ?? ""))).toEqual([
      leaving?.sessionId,
      chat,
    ]);
    expect(getAgentSession(chat)).toBeUndefined();
    const other = group.members[1];
    const otherChat = openAgentChat(other?.agentId ?? "").id;
    const result = await torn(
      updateGroupMembers({
        groupId: group.id,
        add: newAgents(1, "New"),
        removeAgentIds: [other?.agentId ?? ""],
        lead: null,
      }),
    );
    expect(result.removedSessionIds).toEqual([other?.sessionId, otherChat]);
    expect(getAgentSession(otherChat)).toBeUndefined();
    expect(orphanAgentChats()).toBe(0);
  });
});

describe("1:1 chat teardown keeps its tree (A3 review)", () => {
  /** A subagent session under `parentId` (parent_session_id cascades in SQL). */
  function insertSubagent(parentId: string): string {
    const parent = getAgentSession(parentId);
    const id = uid("sub");
    const now = new Date().toISOString();
    getDatabase()
      .prepare(
        `insert into agent_sessions (id, workspace_id, title, cwd, status, parent_session_id, created_at, updated_at)
         values (?, ?, 'child', ?, 'idle', ?, ?, ?)`,
      )
      .run(id, parent?.workspaceId ?? "", parent?.cwd ?? "", parentId, now, now);
    return id;
  }

  function setup() {
    teardown.disposed.length = 0;
    teardown.checkpoints.length = 0;
    const ws = insertWorkspace();
    const group = newGroup(3, ws);
    const member = group.members[2];
    const chat = openAgentChat(member?.agentId ?? "").id;
    const child = insertSubagent(chat);
    const roomChild = insertSubagent(member?.sessionId ?? "");
    return { ws, group, member, chat, child, roomChild, cwd: `/root/${ws}` };
  }

  function expectTornDown(ids: string[], cwd: string): void {
    for (const id of ids) {
      expect(teardown.disposed).toContain(id);
      expect(teardown.checkpoints).toContainEqual({ sessionId: id, cwd });
      expect(getAgentSession(id)).toBeUndefined();
    }
    // Children first: a subagent is disposed before its parent.
    expect(orphanAgentChats()).toBe(0);
    expect(orphanRoomSessions()).toBe(0);
  }

  it("deleting the agent disposes and cleans the chat, its subagent and the room session tree", async () => {
    const { member, chat, child, roomChild, cwd } = setup();
    await deleteAgentWithSessions(member?.agentId ?? "");
    expectTornDown([chat, child, member?.sessionId ?? "", roomChild], cwd);
    expect(teardown.disposed.indexOf(child)).toBeLessThan(teardown.disposed.indexOf(chat));
    expect(teardown.disposed.indexOf(roomChild)).toBeLessThan(
      teardown.disposed.indexOf(member?.sessionId ?? ""),
    );
  });

  it("removing the member does the same", async () => {
    const { group, member, chat, child, roomChild, cwd } = setup();
    await removeMemberWithSessions(group.id, member?.sessionId ?? "");
    expectTornDown([chat, child, member?.sessionId ?? "", roomChild], cwd);
  });

  it("deleting the group does the same for every member", async () => {
    const { group, member, chat, child, roomChild, cwd } = setup();
    await deleteGroupWithSessions(group.id);
    const rooms = group.members.map((item) => item.sessionId);
    expectTornDown([chat, child, roomChild, ...rooms], cwd);
    expect(rooms).toContain(member?.sessionId);
  });

  it("deleting the Project does the same", async () => {
    const { ws, group, chat, child, roomChild, cwd } = setup();
    await removeProject(ws);
    expectTornDown([chat, child, roomChild, ...group.members.map((item) => item.sessionId)], cwd);
    expect(getAgentGroup(group.id)).toBeUndefined();
  });

  it("a refused removal tears nothing down (the store throws before any teardown)", () => {
    teardown.disposed.length = 0;
    const group = newGroup(2);
    const chat = openAgentChat(group.members[0]?.agentId ?? "").id;
    expectCode(() => deleteAgentWithSessions(group.members[0]?.agentId ?? ""), "group-min-members");
    expect(teardown.disposed).toEqual([]);
    expect(getAgentSession(chat)?.agentId).toBe(group.members[0]?.agentId);
  });
});

describe("A3 migration and persona", () => {
  it("widens the avatar check and repairs duplicate group shapes in membership order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "modus-avatar-shape-migrate-"));
    const db = new DatabaseSync(join(dir, "modus.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(db);
      db.exec("drop index if exists idx_agents_group_avatar_shape");
      db.exec(`drop trigger if exists agents_group_avatar_shape_unique_insert;
        drop trigger if exists agents_group_avatar_shape_unique_update;`);
      const workspaceId = insertWorkspace(db);
      const now = "2026-01-01T00:00:00.000Z";
      db.prepare(
        `insert into agent_groups (id, name, workspace_id, mode, created_at, updated_at)
         values ('shape-group', 'Shapes', ?, 'free', ?, ?)`,
      ).run(workspaceId, now, now);
      const insertAgent = db.prepare(
        `insert into agents
          (id, group_id, name, role, instructions, model_id, default_workspace_id,
           avatar_face, avatar_color, avatar_shape, template_id, created_at, updated_at, archived_at)
         values (?, 'shape-group', ?, ?, ?, ?, ?, ?, ?, 'circle', ?, ?, ?, ?)`,
      );
      insertAgent.run(
        "shape-first",
        "First",
        "Lead",
        "Keep first instructions",
        "openai/gpt-5",
        workspaceId,
        "wink",
        "teal",
        "template-first",
        "created-first",
        "updated-first",
        null,
      );
      insertAgent.run(
        "shape-second",
        "Second",
        "Reviewer",
        "Keep second instructions",
        "openai/gpt-5-mini",
        workspaceId,
        "curious",
        "pink",
        "template-second",
        "created-second",
        "updated-second",
        "archived-second",
      );
      const firstSession = insertSession(workspaceId, "First", db);
      const secondSession = insertSession(workspaceId, "Second", db);
      const insertMember = db.prepare(
        `insert into agent_group_members (group_id, session_id, role, joined_at, agent_id)
         values ('shape-group', ?, null, ?, ?)`,
      );
      insertMember.run(firstSession, "2026-01-01T00:00:01.000Z", "shape-first");
      insertMember.run(secondSession, "2026-01-01T00:00:02.000Z", "shape-second");
      replaceAgentsWithLegacyAvatarCheck(db);

      const preservedFields = db
        .prepare(
          `select id, group_id, name, role, instructions, model_id, default_workspace_id,
                  avatar_face, avatar_color, template_id, created_at, updated_at, archived_at
           from agents order by id`,
        )
        .all();
      migrateDatabase(db);

      const snapshot = () =>
        db
          .prepare("select id, avatar_shape from agents where group_id = 'shape-group' order by id")
          .all();
      expect(
        db
          .prepare(
            `select id, avatar_shape from agents where group_id = 'shape-group'
             order by (select joined_at from agent_group_members where agent_id = agents.id), id`,
          )
          .all(),
      ).toEqual([
        { id: "shape-first", avatar_shape: "circle" },
        { id: "shape-second", avatar_shape: "squircle" },
      ]);
      expect(
        db
          .prepare(
            `select id, group_id, name, role, instructions, model_id, default_workspace_id,
                    avatar_face, avatar_color, template_id, created_at, updated_at, archived_at
             from agents order by id`,
          )
          .all(),
      ).toEqual(preservedFields);
      const afterFirstMigration = snapshot();
      migrateDatabase(db);
      expect(snapshot()).toEqual(afterFirstMigration);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

      db.prepare("update agents set avatar_shape = 'triangle' where id = 'shape-first'").run();
      expect(() =>
        db.prepare("update agents set avatar_shape = 'triangle' where id = 'shape-second'").run(),
      ).toThrow(/UNIQUE/);
      const insertUngrouped = db.prepare(
        `insert into agents (id, name, avatar_face, avatar_color, avatar_shape, created_at, updated_at)
         values (?, ?, 'happy', 'blue', 'pentagon', ?, ?)`,
      );
      insertUngrouped.run("shape-loose-one", "Loose One", now, now);
      insertUngrouped.run("shape-loose-two", "Loose Two", now, now);
      expect(
        db
          .prepare(
            "select count(*) as count from agents where group_id is null and avatar_shape = 'pentagon'",
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("agent_sessions.agent_id: one 1:1 chat per agent, unlinked (not deleted) with the agent; idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "modus-a3-migrate-"));
    const db = new DatabaseSync(join(dir, "modus.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(db);
      migrateDatabase(db);
      const columns = db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{
        name: string;
      }>;
      expect(columns.filter((column) => column.name === "agent_id")).toHaveLength(1);
      const ws = insertWorkspace(db);
      const now = new Date().toISOString();
      db.prepare(
        `insert into agents (id, name, avatar_face, avatar_color, avatar_shape, created_at, updated_at)
         values ('a1', 'Ana', 'happy', 'blue', 'circle', ?, ?)`,
      ).run(now, now);
      const first = insertSession(ws, "Ana", db);
      const second = insertSession(ws, "Ana again", db);
      db.prepare("update agent_sessions set agent_id = 'a1' where id = ?").run(first);
      expect(() =>
        db.prepare("update agent_sessions set agent_id = 'a1' where id = ?").run(second),
      ).toThrow(/UNIQUE/);
      // ON DELETE SET NULL: the row stays for the teardown (subagents, checkpoints).
      db.prepare("delete from agents where id = 'a1'").run();
      expect(db.prepare("select agent_id from agent_sessions where id = ?").get(first)).toEqual({
        agent_id: null,
      });
      expect(db.prepare("select 1 from agent_sessions where id = ?").get(second)).toBeDefined();
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("the 1:1 chat carries the agent's persona; other sessions do not", () => {
    const group = createGroupWithNewAgents({
      name: uid("Persona"),
      workspaceId: insertWorkspace(),
      members: [
        { name: "Ana", role: "Reviewer", instructions: "Review every diff.", modelId: MODEL },
        { name: "Bo", modelId: MODEL },
      ],
    });
    const [ana, bo] = group.members;
    const chat = openAgentChat(ana?.agentId ?? "").id;
    expect(agentChatPersonaPrompt(chat)).toBe(
      "<agent_instructions>\nYou are Ana, the Reviewer.\nReview every diff.\n</agent_instructions>",
    );
    expect(agentChatPersonaPrompt(openAgentChat(bo?.agentId ?? "").id)).toBeUndefined();
    expect(agentChatPersonaPrompt(ana?.sessionId ?? "")).toBeUndefined();
  });
});

describe("live membership lines (A3)", () => {
  it("joined / left lines reach the sink once committed; a rolled-back change sends nothing", async () => {
    const sent: Array<{ groupId: string; body: string; kind: string }> = [];
    setGroupMembershipMessageSink((message) => sent.push(message));
    try {
      const group = newGroup(2);
      // Creating a group posts no join lines.
      expect(sent).toEqual([]);
      createAgentInGroup({ groupId: group.id, name: "Rita", role: "Reviewer", modelId: MODEL });
      expect(sent).toEqual([
        expect.objectContaining({
          groupId: group.id,
          kind: "status",
          body: "Rita joined as Reviewer",
        }),
      ]);
      // Saved and sent are the same message.
      expect(listGroupMessages(group.id, { limit: 10 }).map((m) => m.id)).toContain(
        (sent[0] as { id?: string }).id,
      );
      sent.length = 0;
      expectCode(
        () =>
          updateGroupMembers({
            groupId: group.id,
            add: [
              { name: "Fresh", modelId: MODEL },
              { name: "Rita", modelId: MODEL },
            ],
            removeAgentIds: [group.members[0]?.agentId ?? ""],
            lead: null,
          }),
        "agent-name-taken",
      );
      expect(sent).toEqual([]);
      await torn(removeAgentFromGroup(group.id, group.members[0]?.sessionId ?? ""));
      expect(sent.map((message) => message.body)).toEqual(["Agent 1 left the group"]);
    } finally {
      setGroupMembershipMessageSink(undefined);
    }
  });
});

describe("group:update-members (one transaction, final-state rules)", () => {
  const ids = (group: { members: Array<{ agentId: string }> }) =>
    group.members.map((member) => member.agentId);

  it("a 2-member group can replace both members at once (add 2, remove 2)", async () => {
    const group = newGroup(2);
    const { group: after, removedSessionIds } = await torn(
      updateGroupMembers({
        groupId: group.id,
        add: newAgents(2, "New"),
        removeAgentIds: ids(group),
        lead: { name: "new 2" },
      }),
    );
    expect(after.members.map((member) => member.name)).toEqual(["New 1", "New 2"]);
    expect(after.leadSessionId).toBe(after.members[1]?.sessionId);
    expect(removedSessionIds.sort()).toEqual(group.members.map((m) => m.sessionId).sort());
    for (const member of group.members) {
      expect(getAgent(member.agentId)).toBeUndefined();
      expect(getAgentSession(member.sessionId)).toBeUndefined();
    }
    for (const member of after.members) expect(getAgent(member.agentId)?.groupId).toBe(group.id);
    expect(countRows("agents", "group_id", group.id)).toBe(2);
    expect(orphanRoomSessions()).toBe(0);
    // A removed name is free for a new agent in the same change.
    const again = await torn(
      updateGroupMembers({
        groupId: group.id,
        add: [{ name: "New 1", modelId: MODEL }],
        removeAgentIds: [after.members[0]?.agentId ?? ""],
        lead: { agentId: after.members[1]?.agentId ?? "" },
      }),
    );
    expect(again.group.members.map((member) => member.name)).toEqual(["New 2", "New 1"]);
    expect(again.group.leadSessionId).toBe(after.members[1]?.sessionId);
  });

  it("a final state below 2 is refused and nothing changes", () => {
    const group = newGroup(3);
    expectCode(
      () =>
        updateGroupMembers({
          groupId: group.id,
          add: newAgents(1, "Only"),
          removeAgentIds: ids(group),
          lead: null,
        }),
      "group-min-members",
    );
    expect(ids(getAgentGroupWithMembers(group.id))).toEqual(ids(group));
  });

  it("a lead outside the final set is refused (a removed member or an unknown name)", () => {
    const group = newGroup(3);
    const [first, second] = ids(group);
    expectCode(
      () =>
        updateGroupMembers({
          groupId: group.id,
          add: [],
          removeAgentIds: [first ?? ""],
          lead: { agentId: first ?? "" },
        }),
      "not-a-member",
    );
    expectCode(
      () =>
        updateGroupMembers({
          groupId: group.id,
          add: newAgents(1, "Fresh"),
          removeAgentIds: [],
          lead: { name: "Nobody" },
        }),
      "not-a-member",
    );
    // Removing an agent that is not in the group is refused too.
    expectCode(
      () =>
        updateGroupMembers({
          groupId: group.id,
          add: [],
          removeAgentIds: [createAgent({ name: uid("Loose") }).id],
          lead: null,
        }),
      "not-a-member",
    );
    expect(ids(getAgentGroupWithMembers(group.id))).toEqual(ids(group));
    expect(getAgentGroupWithMembers(group.id).leadSessionId ?? null).toBeNull();
    expect(second).toBeDefined();
  });

  it("a failure after some steps rolls back every step (all or nothing)", () => {
    const group = newGroup(2);
    const before = [countRows("agents", "group_id", group.id), orphanRoomSessions()];
    // The second new agent takes a kept member's name: refused after the removal and first add.
    expectCode(
      () =>
        updateGroupMembers({
          groupId: group.id,
          add: [
            { name: "Fresh", modelId: MODEL },
            { name: "Agent 2", modelId: MODEL },
          ],
          removeAgentIds: [ids(group)[0] ?? ""],
          lead: null,
        }),
      "agent-name-taken",
    );
    expect(ids(getAgentGroupWithMembers(group.id))).toEqual(ids(group));
    expect([countRows("agents", "group_id", group.id), orphanRoomSessions()]).toEqual(before);
    expect(statusLines(group.id)).toEqual([]);
  });

  it("an 11th member via update is refused; a legacy group of 11 may shrink but not swap", async () => {
    const ten = newGroup(10);
    expectCode(
      () =>
        updateGroupMembers({
          groupId: ten.id,
          add: newAgents(1, "X"),
          removeAgentIds: [],
          lead: null,
        }),
      "group-max-members",
    );
    const legacy = legacyGroup(11);
    expectCode(
      () =>
        updateGroupMembers({
          groupId: legacy.id,
          add: newAgents(1, "X"),
          removeAgentIds: [ids(legacy)[0] ?? ""],
          lead: null,
        }),
      "group-max-members",
    );
    const shrunk = await torn(
      updateGroupMembers({
        groupId: legacy.id,
        add: [],
        removeAgentIds: [ids(legacy)[0] ?? ""],
        lead: null,
      }),
    );
    expect(shrunk.group.members).toHaveLength(10);
  });
});

describe("A2 migration (on an A1-shaped database)", () => {
  it("backfills, gives each agent its group, splits multi-group agents, keeps loose ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "modus-a2-migrate-"));
    const db = new DatabaseSync(join(dir, "modus.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(db);
      // The A1 shapes: agents without group_id (globally unique name), members
      // with a nullable agent_id and no unique index on it.
      db.exec(`drop table agent_group_members;
        drop table agents;
        create table agents (
          id text primary key,
          name text not null collate nocase unique,
          role text not null default '',
          instructions text not null default '',
          model_id text,
          default_workspace_id text references workspaces(id) on delete set null,
          avatar_face text not null,
          avatar_color text not null,
          template_id text,
          created_at text not null,
          updated_at text not null,
          archived_at text
        );
        create table agent_group_members (
          group_id text not null references agent_groups(id) on delete cascade,
          session_id text not null unique references agent_sessions(id) on delete cascade,
          role text,
          joined_at text not null,
          agent_id text references agents(id) on delete set null,
          primary key (group_id, session_id)
        );`);
      const ws = insertWorkspace(db);
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 1000).toISOString();
      const group = db.prepare(
        `insert into agent_groups (id, name, workspace_id, mode, created_at, updated_at)
         values (?, ?, ?, 'free', ?, ?)`,
      );
      group.run("g1", "One", ws, now, now);
      group.run("g2", "Two", ws, now, now);
      // A1 table has no avatar_shape (N5 adds it during migrateDatabase below).
      const agent = db.prepare(
        `insert into agents (id, name, role, instructions, model_id, avatar_face, avatar_color, created_at, updated_at)
         values (?, ?, ?, ?, ?, 'happy', 'blue', ?, ?)`,
      );
      agent.run("shared", "Shared", "Fixer", "Fix things.", MODEL, now, now);
      agent.run("loose", "Loose", "", "", null, now, now);
      const inOne = insertSession(ws, "Shared", db);
      const inTwo = insertSession(ws, "Shared", db);
      const late = insertSession(ws, "Late", db);
      const orphan = insertSession(ws, "Orphan room", db);
      db.prepare("update agent_sessions set kind = 'group_member' where id = ?").run(orphan);
      const add = db.prepare(
        "insert into agent_group_members (group_id, session_id, role, joined_at, agent_id) values (?, ?, null, ?, ?)",
      );
      add.run("g1", inOne, now, "shared");
      add.run("g2", inTwo, later, "shared");
      // Added between A1 and A2: no agent yet.
      add.run("g1", late, later, null);

      migrateDatabase(db);
      const snapshot = () =>
        db
          .prepare(
            `select a.id, a.group_id, a.name, a.role, a.instructions, a.model_id, m.session_id
             from agents a left join agent_group_members m on m.agent_id = a.id
             order by a.name, a.group_id`,
          )
          .all();
      const first = snapshot();
      migrateDatabase(db);
      expect(snapshot()).toEqual(first);

      const rows = first as Array<{
        id: string;
        group_id: string | null;
        name: string;
        role: string;
        instructions: string;
        model_id: string | null;
        session_id: string | null;
      }>;
      expect(rows.map((row) => [row.name, row.group_id, row.session_id])).toEqual([
        ["Late", "g1", late],
        // (b) undecided → conservative: not deleted, group_id stays NULL.
        ["Loose", null, null],
        // (a) undecided → conservative split: the original stays in its first group,
        ["Shared", "g1", inOne],
        // and a copy (new id, same persona) takes the other membership.
        ["Shared", "g2", inTwo],
      ]);
      const [, , original, copy] = rows;
      expect(original?.id).toBe("shared");
      expect(copy?.id).not.toBe("shared");
      expect(copy).toMatchObject({ role: "Fixer", instructions: "Fix things.", model_id: MODEL });
      // Member sessions stay in the Project, marked group_member; the orphan is swept.
      const kinds = db
        .prepare("select id, kind, workspace_id from agent_sessions where id in (?, ?, ?)")
        .all(inOne, inTwo, late) as Array<{ kind: string; workspace_id: string }>;
      expect(new Set(kinds.map((row) => `${row.kind}@${row.workspace_id}`))).toEqual(
        new Set([`group_member@${ws}`]),
      );
      expect(db.prepare("select 1 from agent_sessions where id = ?").get(orphan)).toBeUndefined();
      // Schema: group_id column (nullable, cascade), unique (group_id, name), 1:1 membership.
      const columns = db.prepare("PRAGMA table_info(agents)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        "id",
        "group_id",
        "name",
        "role",
        "instructions",
        "model_id",
        "default_workspace_id",
        "avatar_face",
        "avatar_color",
        "avatar_shape",
        "template_id",
        "created_at",
        "updated_at",
        "archived_at",
      ]);
      expect(columns.find((column) => column.name === "group_id")?.notnull).toBe(0);
      const memberAgent = (
        db.prepare("PRAGMA table_info(agent_group_members)").all() as Array<{
          name: string;
          notnull: number;
        }>
      ).find((column) => column.name === "agent_id");
      expect(memberAgent?.notnull).toBe(1);
      const insertAgent = (id: string, groupId: string | null, name: string) =>
        db
          .prepare(
            `insert into agents (id, group_id, name, avatar_face, avatar_color, avatar_shape, created_at, updated_at)
             values (?, ?, ?, 'happy', 'blue', 'circle', ?, ?)`,
          )
          .run(id, groupId, name, now, now);
      expect(() => insertAgent("dup", "g1", "shared")).toThrow(/UNIQUE/);
      insertAgent("ok", "g2", "Late");
      const plain = insertSession(ws, "Plain", db);
      expect(() => add.run("g2", plain, now, "shared")).toThrow(/UNIQUE/);
      expect(() => add.run("g2", plain, now, null)).toThrow(/NOT NULL/);
      // Deleting a group cascades to its agents.
      db.prepare("delete from agent_groups where id = 'g2'").run();
      expect(db.prepare("select id from agents where group_id = 'g2'").all()).toEqual([]);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
