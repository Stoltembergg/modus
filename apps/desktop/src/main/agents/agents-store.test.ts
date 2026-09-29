import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase, migrateDatabase } = await import("../db/database");
const { getAgentSession } = await import("../agent/agent-store");
const {
  appendGroupMessage,
  createAgentGroupWithMembers,
  createGroupTask,
  getAgentGroup,
  listAgentGroupMembers,
  listGroupTasks,
} = await import("../groups/group-store");
const {
  createAgent,
  createAgentFromTemplate,
  deleteAgent,
  getAgent,
  listAgents,
  setAgentArchived,
  updateAgent,
} = await import("./agents-store");
const { AGENT_TEMPLATES, agentAvatarForId, getAgentTemplate } = await import(
  "../../shared/agent-templates"
);

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function insertWorkspace(db: DatabaseSync = getDatabase()): string {
  const id = uid("workspace");
  const now = new Date().toISOString();
  db.prepare(
    `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
     values (?, ?, 'repo', 1, ?, ?)`,
  ).run(id, `root-${id}`, now, now);
  return id;
}

function insertSession(workspaceId: string, title: string, db: DatabaseSync = getDatabase()) {
  const id = uid("session");
  const now = new Date().toISOString();
  db.prepare(
    `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
     values (?, ?, ?, ?, 'idle', ?, ?)`,
  ).run(id, workspaceId, title, `root-${workspaceId}`, now, now);
  return id;
}

function expectAgentError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { name?: string }).name).toBe("GroupStoreError");
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected an agent store error ${code}`);
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-agents-store-test-"));
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("agents store", () => {
  it("creates an agent with trimmed fields and empty role/instructions by default", () => {
    const name = uid("Ada");
    const agent = createAgent({ name: `  ${name}  ` });
    expect(agent).toMatchObject({ name, role: "", instructions: "" });
    expect(agent.archivedAt).toBeUndefined();
    expect(agent.modelId).toBeUndefined();
    expect(agent.defaultWorkspaceId).toBeUndefined();
    expect(getAgent(agent.id)).toEqual(agent);
    expect(listAgents().map((item) => item.id)).toContain(agent.id);
  });

  it("defaults the avatar from the id; an explicit or updated avatar is validated", () => {
    const agent = createAgent({ name: uid("Avatar") });
    expect({ avatarFace: agent.avatarFace, avatarColor: agent.avatarColor }).toEqual(
      agentAvatarForId(agent.id),
    );
    expect(agent.templateId).toBeUndefined();
    const picked = createAgent({ name: uid("Pick"), avatarFace: "wink", avatarColor: "teal" });
    expect(picked).toMatchObject({ avatarFace: "wink", avatarColor: "teal" });
    expect(updateAgent(picked.id, { avatarColor: "red" })).toMatchObject({
      avatarFace: "wink",
      avatarColor: "red",
    });
    expectAgentError(
      () => createAgent({ name: uid("Bad"), avatarFace: "angry" as "happy" }),
      "invalid-value",
    );
    expectAgentError(
      () => updateAgent(picked.id, { avatarColor: "black" as "red" }),
      "invalid-value",
    );
    // The CHECK constraints back the store validation.
    expect(() =>
      getDatabase().prepare("update agents set avatar_face = 'angry' where id = ?").run(picked.id),
    ).toThrow(/CHECK constraint/);
  });

  it("picking a template creates an editable copy with template_id", () => {
    const template = getAgentTemplate("reviewer");
    if (!template) throw new Error("missing reviewer template");
    const first = createAgentFromTemplate("reviewer");
    expect(first).toMatchObject({
      name: "Reviewer",
      role: template.role,
      instructions: template.instructions,
      avatarFace: template.avatarFace,
      avatarColor: template.avatarColor,
      templateId: "reviewer",
    });
    expect(first.modelId).toBeUndefined();
    // Picking it again gets the next free name; a given name is used as is.
    expect(createAgentFromTemplate("reviewer").name).toBe("Reviewer 2");
    const named = createAgentFromTemplate("reviewer", { name: uid("Rita") });
    expect(named.templateId).toBe("reviewer");
    // Editing the copy never changes the template.
    updateAgent(first.id, { instructions: "Only check tests.", role: "QA" });
    expect(getAgentTemplate("reviewer")).toEqual(template);
    expect(getAgent(first.id)).toMatchObject({ role: "QA", templateId: "reviewer" });
    expectAgentError(() => createAgentFromTemplate("missing"), "invalid-value");
    expect(AGENT_TEMPLATES.length).toBe(7);
  });

  it("stores role, instructions, model and default Project", () => {
    const workspaceId = insertWorkspace();
    const agent = createAgent({
      name: uid("Rev"),
      role: " Reviewer ",
      instructions: "Review every diff.",
      modelId: "openai/gpt-5",
      defaultWorkspaceId: workspaceId,
    });
    expect(agent).toMatchObject({
      role: "Reviewer",
      instructions: "Review every diff.",
      modelId: "openai/gpt-5",
      defaultWorkspaceId: workspaceId,
    });
  });

  it("rejects an empty name, a taken name (case-insensitive) and an unknown Project", () => {
    const name = uid("Jennie");
    createAgent({ name });
    expectAgentError(() => createAgent({ name: "   " }), "invalid-value");
    expectAgentError(() => createAgent({ name: name.toUpperCase() }), "agent-name-taken");
    expectAgentError(
      () => createAgent({ name: uid("X"), defaultWorkspaceId: "missing" }),
      "workspace-not-found",
    );
  });

  it("lists agents by name, case-insensitively", () => {
    const prefix = uid("sort");
    createAgent({ name: `${prefix} b` });
    createAgent({ name: `${prefix} A` });
    createAgent({ name: `${prefix} c` });
    expect(
      listAgents()
        .map((agent) => agent.name)
        .filter((name) => name.startsWith(prefix)),
    ).toEqual([`${prefix} A`, `${prefix} b`, `${prefix} c`]);
  });

  it("updates fields; clearing model/Project with null; renaming keeps the name unique", () => {
    const workspaceId = insertWorkspace();
    const other = createAgent({ name: uid("Other") });
    const agent = createAgent({
      name: uid("Bo"),
      modelId: "m",
      defaultWorkspaceId: workspaceId,
    });
    const renamed = updateAgent(agent.id, { name: `${agent.name} v2`, role: "Planner" });
    expect(renamed).toMatchObject({ name: `${agent.name} v2`, role: "Planner", modelId: "m" });
    const cleared = updateAgent(agent.id, { modelId: null, defaultWorkspaceId: null });
    expect(cleared.modelId).toBeUndefined();
    expect(cleared.defaultWorkspaceId).toBeUndefined();
    // Same name with a different case is still this agent: allowed.
    expect(updateAgent(agent.id, { name: renamed.name.toUpperCase() }).name).toBe(
      renamed.name.toUpperCase(),
    );
    expectAgentError(() => updateAgent(agent.id, { name: other.name }), "agent-name-taken");
    expectAgentError(() => updateAgent(agent.id, { name: "" }), "invalid-value");
    expectAgentError(() => updateAgent("missing", { role: "x" }), "agent-not-found");
  });

  it("archives and restores an agent", () => {
    const agent = createAgent({ name: uid("Arch") });
    const archived = setAgentArchived(agent.id, true);
    expect(archived.archivedAt).toBeDefined();
    expect(listAgents().find((item) => item.id === agent.id)?.archivedAt).toBe(archived.archivedAt);
    expect(setAgentArchived(agent.id, false).archivedAt).toBeUndefined();
    expectAgentError(() => setAgentArchived("missing", true), "agent-not-found");
  });

  it("deleting a Project clears it as the agent's default and keeps the agent", async () => {
    const { removeWorkspace } = await import("../workspace/workspace-store");
    const workspaceId = insertWorkspace();
    const agent = createAgent({ name: uid("Proj"), defaultWorkspaceId: workspaceId });
    removeWorkspace(workspaceId);
    expect(getAgent(agent.id)).toBeDefined();
    expect(getAgent(agent.id)?.defaultWorkspaceId).toBeUndefined();
  });

  it("deleting an agent removes it from its groups (lead cleared, tasks released) and keeps the session", () => {
    const workspaceId = insertWorkspace();
    const jennie = insertSession(workspaceId, "Jennie");
    const bob = insertSession(workspaceId, "Bob");
    const group = createAgentGroupWithMembers({
      name: "Room",
      workspaceId,
      members: [{ sessionId: jennie }, { sessionId: bob }],
      leadSessionId: jennie,
    });
    const agent = createAgent({ name: uid("Jennie") });
    getDatabase()
      .prepare("update agent_group_members set agent_id = ? where session_id = ?")
      .run(agent.id, jennie);
    const task = createGroupTask({
      groupId: group.id,
      title: "T",
      status: "in_progress",
      ownerSessionId: jennie,
    });
    appendGroupMessage({
      groupId: group.id,
      authorKind: "agent",
      authorSessionId: jennie,
      body: "hi",
    });

    deleteAgent(agent.id);

    expect(getAgent(agent.id)).toBeUndefined();
    expect(listAgentGroupMembers(group.id).map((member) => member.sessionId)).toEqual([bob]);
    expect(getAgentGroup(group.id)?.leadSessionId).toBeUndefined();
    expect(listGroupTasks(group.id).find((item) => item.id === task.id)).toMatchObject({
      status: "open",
    });
    expect(listGroupTasks(group.id)[0]?.ownerSessionId).toBeUndefined();
    expect(getAgentSession(jennie)).toBeDefined();
    expectAgentError(() => deleteAgent(agent.id), "agent-not-found");
  });
});

describe("migration: group members become agents", () => {
  it("creates one agent per member (deduped names), links it and keeps the session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "modus-agents-migrate-"));
    const db = new DatabaseSync(join(dir, "modus.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(db);
      // Pre-agents shape of agent_group_members (no agent_id).
      db.exec(`drop table agent_group_members;
        create table agent_group_members (
          group_id text not null references agent_groups(id) on delete cascade,
          session_id text not null unique references agent_sessions(id) on delete cascade,
          role text,
          joined_at text not null,
          primary key (group_id, session_id)
        );`);
      const workspaceId = insertWorkspace(db);
      const sessions: string[] = [
        insertSession(workspaceId, "Jennie", db),
        insertSession(workspaceId, "jennie", db),
        insertSession(workspaceId, "Bob", db),
        insertSession(workspaceId, "   ", db),
      ];
      const now = new Date().toISOString();
      const addGroup = db.prepare(
        `insert into agent_groups (id, name, workspace_id, mode, created_at, updated_at)
         values (?, ?, ?, 'free', ?, ?)`,
      );
      addGroup.run("g1", "One", workspaceId, now, now);
      addGroup.run("g2", "Two", workspaceId, now, now);
      const addMember = db.prepare(
        "insert into agent_group_members (group_id, session_id, role, joined_at) values (?, ?, ?, ?)",
      );
      const [jennie = "", jennieLower = "", bob = "", blank = ""] = sessions;
      addMember.run("g1", jennie, "research", "2026-01-01T00:00:00.000Z");
      addMember.run("g1", bob, null, "2026-01-01T00:00:01.000Z");
      addMember.run("g2", jennieLower, null, "2026-01-02T00:00:00.000Z");
      addMember.run("g2", blank, null, "2026-01-02T00:00:01.000Z");

      migrateDatabase(db);
      migrateDatabase(db);

      const rows = db
        .prepare(
          `select m.session_id, a.name, a.role, a.instructions
           from agent_group_members m join agents a on a.id = m.agent_id
           order by m.joined_at`,
        )
        .all() as Array<{ session_id: string; name: string; role: string; instructions: string }>;
      expect(rows.map((row) => [row.session_id, row.name])).toEqual([
        [sessions[0], "Jennie"],
        [sessions[2], "Bob"],
        [sessions[1], "jennie 2"],
        [sessions[3], "Agent"],
      ]);
      expect(rows.every((row) => row.role === "" && row.instructions === "")).toBe(true);
      const avatars = db
        .prepare("select id, avatar_face, avatar_color, template_id from agents")
        .all() as Array<{
        id: string;
        avatar_face: string;
        avatar_color: string;
        template_id: string | null;
      }>;
      for (const row of avatars) {
        expect({ avatarFace: row.avatar_face, avatarColor: row.avatar_color }).toEqual(
          agentAvatarForId(row.id),
        );
        expect(row.template_id).toBeNull();
      }
      expect((db.prepare("select count(*) as n from agents").get() as { n: number }).n).toBe(4);
      // The member keeps its session (history) and its per-group role label.
      const member = db
        .prepare("select role from agent_group_members where session_id = ?")
        .get(jennie) as { role: string };
      expect(member.role).toBe("research");
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("exposes the member's agent id", () => {
    const workspaceId = insertWorkspace();
    const session = insertSession(workspaceId, "Linked");
    const group = createAgentGroupWithMembers({
      name: "Linked room",
      workspaceId,
      members: [{ sessionId: session }],
    });
    expect(listAgentGroupMembers(group.id)[0]?.agentId).toBeUndefined();
    const agent = createAgent({ name: uid("Linked") });
    getDatabase()
      .prepare("update agent_group_members set agent_id = ? where session_id = ?")
      .run(agent.id, session);
    expect(listAgentGroupMembers(group.id)[0]?.agentId).toBe(agent.id);
  });
});
