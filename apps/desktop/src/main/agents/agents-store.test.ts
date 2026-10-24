import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase, migrateDatabase } = await import("../db/database");
const {
  createAgent,
  createAgentFromTemplate,
  createProfile,
  getAgent,
  listAgents,
  setAgentArchived,
  updateAgent,
} = await import("./agents-store");
const { AGENT_TEMPLATES, agentAvatarForId, getAgentTemplate } = await import(
  "../../shared/agent-templates"
);
const { CUSTOM_ROLE_CAPABILITIES, capabilitiesForRole } = await import("../../shared/agent-roles");

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
    expect({
      avatarFace: agent.avatarFace,
      avatarColor: agent.avatarColor,
      avatarShape: agent.avatarShape,
    }).toEqual(agentAvatarForId(agent.id));
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
        .prepare("select id, avatar_face, avatar_color, avatar_shape, template_id from agents")
        .all() as Array<{
        id: string;
        avatar_face: string;
        avatar_color: string;
        avatar_shape: string;
        template_id: string | null;
      }>;
      for (const row of avatars) {
        expect({
          avatarFace: row.avatar_face,
          avatarColor: row.avatar_color,
        }).toEqual(
          (({ avatarShape: _avatarShape, ...avatar }) => avatar)(agentAvatarForId(row.id)),
        );
        expect(row.template_id).toBeNull();
      }
      const groupedShapes = db
        .prepare(
          `select a.group_id, a.avatar_shape from agents a
           where a.group_id is not null order by a.group_id, a.avatar_shape`,
        )
        .all() as Array<{ group_id: string; avatar_shape: string }>;
      const shapesByGroup = new Map<string, string[]>();
      for (const row of groupedShapes) {
        const shapes = shapesByGroup.get(row.group_id) ?? [];
        shapes.push(row.avatar_shape);
        shapesByGroup.set(row.group_id, shapes);
      }
      for (const shapes of shapesByGroup.values()) expect(new Set(shapes).size).toBe(shapes.length);
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
});

describe("agent work lists follow the role", () => {
  const savedRow = (id: string) => {
    const row = getDatabase()
      .prepare("select capability_ids_json, supported_task_kinds_json from agents where id = ?")
      .get(id) as { capability_ids_json: string; supported_task_kinds_json: string };
    return {
      capabilityIds: JSON.parse(row.capability_ids_json) as string[],
      supportedTaskKinds: JSON.parse(row.supported_task_kinds_json) as string[],
    };
  };

  const rawRow = (id: string) =>
    getDatabase()
      .prepare("select capability_ids_json, supported_task_kinds_json from agents where id = ?")
      .get(id) as { capability_ids_json: string; supported_task_kinds_json: string };

  it("agents saved before keep their hand-picked lists; empty ones read as the derived role", () => {
    const empty = createAgent({ name: uid("Empty"), role: "Builder", modelId: "m-1" });
    const legacyTemplate = createAgent({
      name: uid("Old oracle"),
      role: "Advisor",
      templateId: "oracle",
    });
    const fromTemplate = createAgentFromTemplate("builder", { name: uid("Builder") });
    const handPicked = createAgent({
      name: uid("Picked"),
      role: "Reviewer",
      modelId: "m-1",
      capabilityIds: ["implement", "review"],
      supportedTaskKinds: ["code", "docs", "design", "review", "research", "question"],
    });
    const freeText = createAgent({ name: uid("Notes"), role: "Release notes", modelId: "m-1" });
    const seeded = [empty, legacyTemplate, fromTemplate, handPicked, freeText];
    // The saved lists, unread.
    const before = new Map(seeded.map((agent) => [agent.id, savedRow(agent.id)]));
    const beforeRaw = new Map(seeded.map((agent) => [agent.id, { ...rawRow(agent.id) }]));
    expect(before.get(empty.id)).toEqual({ capabilityIds: [], supportedTaskKinds: [] });
    expect(before.get(freeText.id)).toEqual({ capabilityIds: [], supportedTaskKinds: [] });

    // Edits that keep the role (what the dialog sends) never touch the lists.
    for (const agent of seeded) {
      updateAgent(agent.id, { name: `${agent.name} 2`, instructions: "Edited", modelId: "m-2" });
      updateAgent(agent.id, { role: ` ${agent.role.toUpperCase()} ` });
      // Byte-for-byte: the stored columns are not even rewritten.
      expect({ ...rawRow(agent.id) }).toEqual(beforeRaw.get(agent.id));
    }
    migrateDatabase(getDatabase());

    for (const agent of seeded) {
      const saved = before.get(agent.id) as ReturnType<typeof savedRow>;
      // Hand-picked (non-empty) lists survive the migration untouched.
      if (saved.capabilityIds.length && saved.supportedTaskKinds.length) {
        expect(getAgent(agent.id), agent.name).toMatchObject(saved);
      }
    }
    // Empty lists read as the derived role: template first, then the label, else Custom.
    expect(getAgent(empty.id)).toMatchObject(capabilitiesForRole("builder"));
    expect(getAgent(legacyTemplate.id)).toMatchObject(capabilitiesForRole("advisor"));
    expect(getAgent(freeText.id)).toMatchObject(CUSTOM_ROLE_CAPABILITIES);
  });

  it("new agents get their template's or their role's lists; Custom otherwise", () => {
    const members = [
      { name: uid("Build"), templateId: "builder" },
      { name: uid("Build as reviewer"), templateId: "builder", role: "Reviewer" },
      { name: uid("Custom Builder"), role: "builder", modelId: "m-1" },
      { name: uid("Planner by name"), role: "Planner", modelId: "m-1" },
      { name: uid("Notes"), role: "Release notes", modelId: "m-1" },
    ].map((input) => createProfile(input));
    expect(
      members.map(({ capabilityIds, supportedTaskKinds }) => ({
        capabilityIds,
        supportedTaskKinds,
      })),
    ).toEqual([
      capabilitiesForRole("builder"),
      capabilitiesForRole("reviewer"),
      capabilitiesForRole("builder"),
      capabilitiesForRole("lead"),
      CUSTOM_ROLE_CAPABILITIES,
    ]);
    for (const member of members) {
      expect(savedRow(member.id)).toMatchObject({
        capabilityIds: member.capabilityIds,
        supportedTaskKinds: member.supportedTaskKinds,
      });
    }
    expectAgentError(() => createAgentFromTemplate("custom-builder"), "invalid-value");
  });

  it("New Agent dialog: a custom agent saved with role '' handles Custom's work; a template keeps its role's", () => {
    // The dialog has no Role field: a custom agent is saved with role "" (the generated
    // role is discarded), which derives Custom, exactly like the old "Generalist" fallback.
    const blank = createProfile({
      name: uid("Blank"),
      role: "",
      instructions: "Help.",
      modelId: "m-1",
    });
    expect(blank.role).toBe("");
    expect(savedRow(blank.id)).toMatchObject(CUSTOM_ROLE_CAPABILITIES);
    const generalist = createProfile({ name: uid("Gen"), role: "Generalist", modelId: "m-1" });
    expect(savedRow(generalist.id)).toMatchObject(CUSTOM_ROLE_CAPABILITIES);
    // A template agent keeps sending its template's role, so it keeps the template's lists.
    const builder = getAgentTemplate("builder");
    if (!builder) throw new Error("builder template");
    const fromTemplate = createProfile({
      name: uid("Build"),
      role: builder.role,
      templateId: "builder",
    });
    expect(fromTemplate.role).toBe("Builder");
    expect(savedRow(fromTemplate.id)).toMatchObject(capabilitiesForRole("builder"));
  });

  it("changing the role recalculates; keeping it keeps hand-picked lists", () => {
    const agent = createAgent({
      name: uid("Picked"),
      role: "Reviewer",
      modelId: "m-1",
      capabilityIds: ["implement", "review"],
      supportedTaskKinds: ["code", "design"],
    });
    updateAgent(agent.id, { role: "reviewer", instructions: "Still a reviewer" });
    expect(getAgent(agent.id)).toMatchObject({
      capabilityIds: ["implement", "review"],
      supportedTaskKinds: ["code", "design"],
    });
    updateAgent(agent.id, { role: "Librarian" });
    expect(getAgent(agent.id)).toMatchObject(capabilitiesForRole("librarian"));
    // Custom labels are one role: renaming within Custom keeps the lists.
    updateAgent(agent.id, { role: "Docs helper" });
    expect(getAgent(agent.id)).toMatchObject(CUSTOM_ROLE_CAPABILITIES);
    updateAgent(agent.id, { role: "Release notes" });
    expect(savedRow(agent.id)).toEqual(CUSTOM_ROLE_CAPABILITIES);
  });

  it("a copy keeps what its source handles: saved lists, or its derived ones when empty", () => {
    const source = createAgent({
      name: uid("Source"),
      role: "Builder",
      modelId: "m-1",
      capabilityIds: ["implement", "review"],
      supportedTaskKinds: ["code", "review"],
    });
    const copy = createProfile({
      name: uid("Copy"),
      role: "Builder",
      modelId: "m-1",
      copiedFromAgentId: source.id,
    });
    expect(copy).toMatchObject({
      capabilityIds: ["implement", "review"],
      supportedTaskKinds: ["code", "review"],
    });
    // A source with empty lists and a template copies what it is shown to handle (its
    // template's lists), not Custom from its free-text label.
    const legacy = createAgent({
      name: uid("Old helper"),
      role: "Old helper",
      templateId: "builder",
    });
    expect(rawRow(legacy.id)).toMatchObject({
      capability_ids_json: "[]",
      supported_task_kinds_json: "[]",
    });
    expect(getAgent(legacy.id)).toMatchObject(capabilitiesForRole("builder"));
    const helperCopy = createProfile({
      name: uid("Helper copy"),
      role: "Old helper",
      modelId: "m-1",
      copiedFromAgentId: legacy.id,
    });
    expect(helperCopy).toMatchObject(capabilitiesForRole("builder"));
    expect(savedRow(helperCopy.id)).toEqual(capabilitiesForRole("builder"));
    expectAgentError(
      () =>
        createProfile({
          name: uid("Missing"),
          modelId: "m-1",
          copiedFromAgentId: "missing-agent",
        }),
      "agent-not-found",
    );
  });

  it("a copy whose role changed in the modal follows the new role; same role keeps the source's", () => {
    const source = createAgent({
      name: uid("Hand"),
      role: "Reviewer",
      modelId: "m-1",
      capabilityIds: ["verify"],
      supportedTaskKinds: ["code"],
    });
    const copies = new Map(
      [
        { key: "Same", role: " reviewer " },
        { key: "Moved", role: "Builder" },
        { key: "Unset" },
      ].map(({ key, ...rest }) => [
        key,
        createProfile({ name: uid(key), modelId: "m-1", copiedFromAgentId: source.id, ...rest }),
      ]),
    );
    const byName = (name: string) => copies.get(name);
    expect(byName("Same")).toMatchObject({
      capabilityIds: ["verify"],
      supportedTaskKinds: ["code"],
    });
    expect(byName("Unset")).toMatchObject({
      capabilityIds: ["verify"],
      supportedTaskKinds: ["code"],
    });
    expect(byName("Moved")).toMatchObject(capabilitiesForRole("builder"));
    expect(savedRow(byName("Moved")?.id ?? "")).toEqual(capabilitiesForRole("builder"));
  });

  it("migrates missing columns to empty and preserves all profile fields idempotently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateDatabase(db);
      db.exec(
        "alter table agents drop column capability_ids_json; alter table agents drop column supported_task_kinds_json;",
      );
      db.prepare(
        "insert into agents (id, name, role, instructions, model_id, avatar_face, avatar_color, avatar_shape, template_id, created_at, updated_at, archived_at) values ('legacy-cap', 'Builder', 'Implement', 'Verify tests', 'm-1', 'wink', 'teal', 'circle', 'builder', 'created', 'updated', 'archived')",
      ).run();
      migrateDatabase(db);
      migrateDatabase(db);
      expect(db.prepare("select * from agents where id = 'legacy-cap'").get()).toMatchObject({
        name: "Builder",
        role: "Implement",
        instructions: "Verify tests",
        model_id: "m-1",
        avatar_face: "wink",
        avatar_color: "teal",
        avatar_shape: "circle",
        template_id: "builder",
        created_at: "created",
        updated_at: "updated",
        archived_at: "archived",
        capability_ids_json: "[]",
        supported_task_kinds_json: "[]",
      });
      db.prepare(
        "update agents set capability_ids_json = ?, supported_task_kinds_json = ? where id = 'legacy-cap'",
      ).run('["docs"]', '["docs"]');
      migrateDatabase(db);
      expect(
        db
          .prepare(
            "select capability_ids_json, supported_task_kinds_json from agents where id = 'legacy-cap'",
          )
          .get(),
      ).toMatchObject({ capability_ids_json: '["docs"]', supported_task_kinds_json: '["docs"]' });
    } finally {
      db.close();
    }
  });
});
