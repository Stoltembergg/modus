import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * avatar_seed (PR #278): the nullable column, its migration on an old
 * database, and the store rules (normalize, face mapping, copies, edits).
 */

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase, migrateDatabase, KNOWN_DATABASE_VERSION } = await import("../db/database");
const { listAgentGroupMembers } = await import("../groups/group-store");
const { createAgent, createGroupWithNewAgents, createProfile, getAgent, updateAgent } =
  await import("./agents-store");
const { AGENT_FACE_SEEDS, agentAvatarSeed } = await import("../../shared/agent-avatar-seeds");
const { agentAvatarForId } = await import("../../shared/agent-templates");

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

function expectStoreError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { name?: string }).name).toBe("GroupStoreError");
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected a store error ${code}`);
}

function columns(db: DatabaseSync) {
  return db.prepare("PRAGMA table_info(agents)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }>;
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-avatar-seed-test-"));
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("avatar_seed migration (old database)", () => {
  it("adds a nullable column, leaves old rows NULL (drawn with the id) and keeps user_version", () => {
    const db = getDatabase();
    // An old (pre-#278) database: the agents table without avatar_seed, with
    // rows written by an old build through its explicit column list.
    db.exec("alter table agents drop column avatar_seed");
    expect(columns(db).some((column) => column.name === "avatar_seed")).toBe(false);
    const now = new Date().toISOString();
    const insertOld = db.prepare(
      `insert into agents (id, name, avatar_face, avatar_color, avatar_shape, created_at, updated_at)
       values (?, ?, 'wink', 'teal', 'circle', ?, ?)`,
    );
    insertOld.run("old-1", uid("Old one"), now, now);
    insertOld.run("old-2", uid("Old two"), now, now);
    const versionBefore = db.prepare("PRAGMA user_version").get() as { user_version: number };

    migrateDatabase(db);
    migrateDatabase(db); // idempotent

    const seed = columns(db).find((column) => column.name === "avatar_seed");
    expect(seed).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
    expect(
      db.prepare("select id, avatar_seed from agents where id like 'old-%' order by id").all(),
    ).toEqual([
      { id: "old-1", avatar_seed: null },
      { id: "old-2", avatar_seed: null },
    ]);
    // Additive: the version is not bumped, so an older build still opens the file
    // (its downgrade guard only refuses a user_version above its own).
    expect(db.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
    expect(versionBefore.user_version).toBeLessThanOrEqual(KNOWN_DATABASE_VERSION);
    // An old build's insert (explicit column list) still works and reads NULL.
    insertOld.run("old-3", uid("Old three"), now, now);
    for (const id of ["old-1", "old-2", "old-3"]) {
      const agent = getAgent(id);
      expect(agent?.avatarSeed).toBeNull();
      expect(agent?.avatarFace).toBe("wink");
      // Rendered with the id, exactly as before the column existed.
      expect(agent && agentAvatarSeed(agent)).toBe(id);
    }
  });
});

describe("avatar_seed store rules", () => {
  it("create: no seed is NULL; blank normalizes to NULL (never ''); a face seed sets its face", () => {
    const none = createAgent({ name: uid("None") });
    expect(none.avatarSeed).toBeNull();
    expect(none.avatarFace).toBe(agentAvatarForId(none.id).avatarFace);
    for (const blank of ["", "   ", null]) {
      const agent = createAgent({ name: uid("Blank"), avatarSeed: blank });
      expect(agent.avatarSeed).toBeNull();
      const raw = getDatabase()
        .prepare("select avatar_seed from agents where id = ?")
        .get(agent.id) as { avatar_seed: string | null };
      expect(raw.avatar_seed).toBeNull();
    }
    const calm = createAgent({ name: uid("Calm"), avatarSeed: `  ${AGENT_FACE_SEEDS.calm}  ` });
    expect(calm).toMatchObject({ avatarSeed: AGENT_FACE_SEEDS.calm, avatarFace: "calm" });
    // The seed's face wins over a stale face label.
    const wins = createAgent({
      name: uid("Wins"),
      avatarSeed: AGENT_FACE_SEEDS.sleepy,
      avatarFace: "bright",
    });
    expect(wins.avatarFace).toBe("sleepy");
    // Any other valid seed is stored as given; the face stays as sent / derived.
    const other = createAgent({
      name: uid("Other"),
      avatarSeed: "custom_seed-1",
      avatarFace: "wink",
    });
    expect(other).toMatchObject({ avatarSeed: "custom_seed-1", avatarFace: "wink" });
    expect(
      createProfile({ name: uid("Profile"), avatarSeed: AGENT_FACE_SEEDS.wink }).avatarSeed,
    ).toBe(AGENT_FACE_SEEDS.wink);
  });

  it("rejects a seed with bad characters or over 64 characters", () => {
    for (const bad of ["has space", "emoji-🙂", "slash/seed", "dot.seed", "x".repeat(65)]) {
      expectStoreError(() => createAgent({ name: uid("Bad"), avatarSeed: bad }), "invalid-value");
    }
    expect(createAgent({ name: uid("Max"), avatarSeed: "x".repeat(64) }).avatarSeed).toBe(
      "x".repeat(64),
    );
    const agent = createAgent({ name: uid("Edit bad") });
    expectStoreError(() => updateAgent(agent.id, { avatarSeed: "no way" }), "invalid-value");
  });

  it("edit: untouched keeps seed and face; a new seed sets its face; null / blank clears", () => {
    const agent = createAgent({ name: uid("Edit"), avatarSeed: AGENT_FACE_SEEDS.cheeky });
    const kept = updateAgent(agent.id, { name: uid("Renamed"), avatarColor: "pink" });
    expect(kept).toMatchObject({ avatarSeed: AGENT_FACE_SEEDS.cheeky, avatarFace: "cheeky" });
    const changed = updateAgent(agent.id, { avatarSeed: AGENT_FACE_SEEDS.focused });
    expect(changed).toMatchObject({ avatarSeed: AGENT_FACE_SEEDS.focused, avatarFace: "focused" });
    const blank = updateAgent(agent.id, { avatarSeed: "  " });
    expect(blank.avatarSeed).toBeNull();
    expect(blank.avatarFace).toBe(agentAvatarForId(agent.id).avatarFace);
    updateAgent(agent.id, { avatarSeed: AGENT_FACE_SEEDS.happy });
    expect(updateAgent(agent.id, { avatarSeed: null }).avatarSeed).toBeNull();
  });

  it("a copy of an existing agent never carries a seed; group members read the stored seed", () => {
    const source = createGroupWithNewAgents({
      name: uid("Source"),
      workspaceId: insertWorkspace(),
      members: [
        { name: "Seeded", modelId: "openai/gpt-5", avatarSeed: AGENT_FACE_SEEDS.bright },
        { name: "Plain", modelId: "openai/gpt-5" },
      ],
    });
    const [seeded, plain] = source.members;
    if (!seeded || !plain) throw new Error("expected two members");
    expect(seeded).toMatchObject({ avatarSeed: AGENT_FACE_SEEDS.bright, avatarFace: "bright" });
    expect(plain.avatarSeed).toBeNull();
    expect(listAgentGroupMembers(source.id).map((member) => member.avatarSeed)).toEqual([
      AGENT_FACE_SEEDS.bright,
      null,
    ]);

    const copies = createGroupWithNewAgents({
      name: uid("Copies"),
      workspaceId: insertWorkspace(),
      members: [
        // Even if a seed is sent with a copy, it is dropped: drawn with the new id.
        {
          name: "Copy",
          modelId: "openai/gpt-5",
          copiedFromAgentId: seeded.agentId,
          avatarColor: "teal",
          avatarSeed: AGENT_FACE_SEEDS.bright,
        },
        { name: "Copy plain", modelId: "openai/gpt-5", copiedFromAgentId: seeded.agentId },
      ],
    });
    for (const copy of copies.members) {
      expect(copy.avatarSeed).toBeNull();
      expect(getAgent(copy.agentId)?.avatarSeed).toBeNull();
      expect(agentAvatarSeed({ id: copy.agentId, avatarSeed: copy.avatarSeed })).toBe(copy.agentId);
    }
    // Color (and shape) may still be copied.
    expect(copies.members[0]?.avatarColor).toBe("teal");
  });

  it("a template agent gets no seed unless one is picked", () => {
    const group = createGroupWithNewAgents({
      name: uid("Templates"),
      workspaceId: insertWorkspace(),
      members: [
        { name: "", templateId: "planner" },
        { name: "", templateId: "builder", avatarSeed: AGENT_FACE_SEEDS.curious },
      ],
    });
    const [planner, builder] = group.members;
    expect(planner?.avatarSeed).toBeNull();
    expect(builder).toMatchObject({ avatarSeed: AGENT_FACE_SEEDS.curious, avatarFace: "curious" });
  });
});
