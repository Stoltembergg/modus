import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
const { ensureChatsWorkspace, getWorkspace } = await import("./workspace-store");
const { createAgentGroupWithMembers, getAgentGroup, listAgentGroupMembers } = await import(
  "../groups/group-store"
);
const { archiveProjectChats, deleteProjectChats, removeProject } = await import(
  "./workspace-service"
);

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function insertWorkspace(): string {
  const id = uid("workspace");
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `root-${id}`, "repo", 1, now, now);
  return id;
}

function insertSession(workspaceId: string): string {
  const id = uid("session");
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, workspaceId, `Chat ${id}`, `root-${workspaceId}`, "idle", now, now);
  return id;
}

/** A Project with a two-member group plus two ungrouped chats. */
function fixture() {
  const workspaceId = insertWorkspace();
  const memberA = insertSession(workspaceId);
  const memberB = insertSession(workspaceId);
  const loose1 = insertSession(workspaceId);
  const loose2 = insertSession(workspaceId);
  const group = createAgentGroupWithMembers({
    name: "Squad",
    workspaceId,
    members: [{ sessionId: memberA }, { sessionId: memberB }],
    leadSessionId: memberA,
  });
  return { workspaceId, memberA, memberB, loose1, loose2, group };
}

function expectGroupIntact(groupId: string, memberIds: string[], leadId: string): void {
  expect(getAgentGroup(groupId)?.leadSessionId).toBe(leadId);
  expect(listAgentGroupMembers(groupId).map((m) => m.sessionId)).toEqual(memberIds);
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-workspace-groups-test-"));
  ensureChatsWorkspace();
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("Project chat actions and groups", () => {
  it("Archive chats skips group members and counts only the others", async () => {
    const { workspaceId, memberA, memberB, loose1, loose2, group } = fixture();

    expect(await archiveProjectChats(workspaceId)).toBe(2);

    expect(getAgentSession(loose1)?.archivedAt).toBeTruthy();
    expect(getAgentSession(loose2)?.archivedAt).toBeTruthy();
    expect(getAgentSession(memberA)?.archivedAt).toBeUndefined();
    expect(getAgentSession(memberB)?.archivedAt).toBeUndefined();
    expectGroupIntact(group.id, [memberA, memberB], memberA);
  });

  it("Delete chats skips group members (live and archived non-members go) and counts only the others", async () => {
    const { workspaceId, memberA, memberB, loose1, loose2, group } = fixture();
    // One non-member already archived: still deleted, still counted.
    getDatabase()
      .prepare("update agent_sessions set archived_at = ? where id = ?")
      .run(new Date().toISOString(), loose2);

    expect(await deleteProjectChats(workspaceId)).toBe(2);

    expect(getAgentSession(loose1)).toBeUndefined();
    expect(getAgentSession(loose2)).toBeUndefined();
    expect(getAgentSession(memberA)).toBeDefined();
    expect(getAgentSession(memberB)).toBeDefined();
    expectGroupIntact(group.id, [memberA, memberB], memberA);
  });

  it("Remove project still deletes everything, group members and the group included", async () => {
    const { workspaceId, memberA, memberB, loose1, loose2, group } = fixture();

    await removeProject(workspaceId);

    for (const id of [memberA, memberB, loose1, loose2]) {
      expect(getAgentSession(id)).toBeUndefined();
    }
    expect(getAgentGroup(group.id)).toBeUndefined();
    expect(getWorkspace(workspaceId)).toBeUndefined();
  });
});
