import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * After the groups → projects migration, agent_group_members rows remain and
 * still link the converted read-only "(room work)" chats to their group.
 * "Remove project" must tear those sessions down too, even when a session
 * lives in another workspace than its group.
 */

let userData: string;

vi.mock("electron", () => ({
  app: { getPath: () => userData },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
}));
// Session teardown side effects that need a live app; the DB work stays real.
vi.mock("../agent/runtime-registry", () => ({
  getAgentRuntime: () => ({ dispose: vi.fn(async () => undefined) }),
}));
vi.mock("../agent/checkpoint-service", () => ({
  deleteSessionCheckpoints: vi.fn(async () => undefined),
}));
vi.mock("../memory/project-memory-service", () => ({ finalizeProjectMemoryRun: vi.fn() }));
vi.mock("../git/git-service", () => ({ isGitRepository: vi.fn(async () => true) }));

const { getDatabase } = await import("../db/database");
const { getAgentSession } = await import("../agent/agent-store");
const { createProfile } = await import("../agents/agents-store");
const { ensureChatsWorkspace, getWorkspace } = await import("./workspace-store");
const { deleteProjectChats, removeProject } = await import("./workspace-service");

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const now = () => new Date().toISOString();

function insertWorkspace(): string {
  const id = uid("workspace");
  getDatabase()
    .prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `root-${id}`, "repo", 1, now(), now());
  return id;
}

function insertSession(workspaceId: string, readOnly = false): string {
  const id = uid("session");
  getDatabase()
    .prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, read_only, created_at, updated_at)
       values (?, ?, ?, ?, 'idle', ?, ?, ?)`,
    )
    .run(id, workspaceId, `Chat ${id}`, `root-${workspaceId}`, readOnly ? 1 : 0, now(), now());
  return id;
}

/** The post-migration shape: a legacy group whose membership rows point at read-only chats. */
function migratedFixture() {
  const workspaceId = insertWorkspace();
  const otherWorkspaceId = insertWorkspace();
  const groupId = uid("group");
  getDatabase()
    .prepare(
      "insert into agent_groups (id, name, workspace_id, mode, created_at, updated_at) values (?, 'Squad', ?, 'free', ?, ?)",
    )
    .run(groupId, workspaceId, now(), now());
  const roomHere = insertSession(workspaceId, true);
  const roomElsewhere = insertSession(otherWorkspaceId, true);
  const loose = insertSession(workspaceId);
  const untouched = insertSession(otherWorkspaceId);
  for (const sessionId of [roomHere, roomElsewhere]) {
    const agent = createProfile({ name: uid("Member"), modelId: "m-1" });
    getDatabase()
      .prepare(
        "insert into agent_group_members (group_id, session_id, joined_at, agent_id) values (?, ?, ?, ?)",
      )
      .run(groupId, sessionId, now(), agent.id);
  }
  return { workspaceId, otherWorkspaceId, groupId, roomHere, roomElsewhere, loose, untouched };
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-workspace-groups-test-"));
  ensureChatsWorkspace();
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("Project removal with legacy group memberships", () => {
  it("Remove project deletes every session linked to its legacy groups, wherever it lives", async () => {
    const f = migratedFixture();

    await removeProject(f.workspaceId);

    for (const id of [f.roomHere, f.roomElsewhere, f.loose]) {
      expect(getAgentSession(id)).toBeUndefined();
    }
    expect(getAgentSession(f.untouched)).toBeDefined();
    expect(getWorkspace(f.workspaceId)).toBeUndefined();
    const left = getDatabase()
      .prepare("select count(*) as n from agent_group_members where group_id = ?")
      .get(f.groupId) as { n: number };
    expect(left.n).toBe(0);
  });

  it("Delete chats keeps another workspace's linked session (only Remove project reaches it)", async () => {
    const f = migratedFixture();

    await deleteProjectChats(f.workspaceId);

    expect(getAgentSession(f.roomHere)).toBeUndefined();
    expect(getAgentSession(f.loose)).toBeUndefined();
    expect(getAgentSession(f.roomElsewhere)).toBeDefined();
    expect(getAgentSession(f.untouched)).toBeDefined();
  });
});
