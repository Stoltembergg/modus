import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Agents model, closing rule 2: a group member's room session is
 * kind = 'group_member' and never shows up in a session listing (sidebar,
 * Project archive, @ Past Chats search, Archive/Delete chats). One test per
 * listing, on a real SQLite database.
 */

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));
vi.mock("./runtime-registry", () => ({ getAgentRuntime: () => ({ dispose: async () => {} }) }));
vi.mock("./checkpoint-service", () => ({ deleteSessionCheckpoints: async () => {} }));

const { getDatabase } = await import("../db/database");
const {
  getAgentSession,
  listAgentSessions,
  listArchivedAgentSessions,
  listSubagentSessions,
  setAgentSessionArchived,
} = await import("./agent-store");
const { archiveWorkspaceSessions, deleteWorkspaceSessions } = await import("./session-lifecycle");
const { searchContext } = await import("../context/context-service");

let workspaceId: string;

function insertSession(
  id: string,
  kind: "chat" | "group_member",
  options: { parentId?: string; title?: string } = {},
): void {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into agent_sessions
         (id, workspace_id, title, cwd, status, parent_session_id, kind, created_at, updated_at)
       values (?, ?, ?, ?, 'idle', ?, ?, ?, ?)`,
    )
    .run(
      id,
      workspaceId,
      options.title ?? `Session ${id}`,
      userData,
      options.parentId ?? null,
      kind,
      now,
      now,
    );
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-session-kind-test-"));
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(() => {
  workspaceId = `workspace-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, 'repo', 0, ?, ?)`,
    )
    .run(workspaceId, `${userData}/${workspaceId}`, now, now);
  insertSession(`${workspaceId}-chat`, "chat", { title: "Jennie chat" });
  insertSession(`${workspaceId}-room`, "group_member", { title: "Jennie room" });
});

describe("session listings only list kind = 'chat'", () => {
  it("a new session row defaults to kind 'chat'", () => {
    const now = new Date().toISOString();
    getDatabase()
      .prepare(
        `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
         values (?, ?, 'Plain', ?, 'idle', ?, ?)`,
      )
      .run(`${workspaceId}-plain`, workspaceId, userData, now, now);
    const row = getDatabase()
      .prepare("select kind from agent_sessions where id = ?")
      .get(`${workspaceId}-plain`) as { kind: string };
    expect(row.kind).toBe("chat");
    expect(() => insertSession(`${workspaceId}-bad`, "other" as "chat")).toThrow();
  });

  it("sidebar: listAgentSessions", () => {
    const ids = listAgentSessions().map((session) => session.id);
    expect(ids).toContain(`${workspaceId}-chat`);
    expect(ids).not.toContain(`${workspaceId}-room`);
    // The room session still resolves by id (the runtime keys everything by it).
    expect(getAgentSession(`${workspaceId}-room`)?.title).toBe("Jennie room");
  });

  it("sidebar: includeSessionId never adds a room session", () => {
    const ids = listAgentSessions({ includeSessionId: `${workspaceId}-room` }).map(
      (session) => session.id,
    );
    expect(ids).not.toContain(`${workspaceId}-room`);
  });

  it("Project archive: listArchivedAgentSessions", () => {
    setAgentSessionArchived(`${workspaceId}-chat`, true);
    setAgentSessionArchived(`${workspaceId}-room`, true);
    expect(listArchivedAgentSessions(workspaceId).map((session) => session.id)).toEqual([
      `${workspaceId}-chat`,
    ]);
  });

  it("subagents: listSubagentSessions", () => {
    insertSession(`${workspaceId}-sub`, "chat", { parentId: `${workspaceId}-chat` });
    insertSession(`${workspaceId}-sub-room`, "group_member", { parentId: `${workspaceId}-chat` });
    expect(listSubagentSessions(`${workspaceId}-chat`).map((session) => session.id)).toEqual([
      `${workspaceId}-sub`,
    ]);
  });

  it("search: @ Past Chats", async () => {
    const suggestions = await searchContext({
      workspaceId,
      cwd: userData,
      query: "jennie",
      kind: "past-chat",
    });
    expect(suggestions.map((suggestion) => suggestion.label)).toEqual(["Jennie chat"]);
  });

  it("Archive chats: archiveWorkspaceSessions", async () => {
    await expect(archiveWorkspaceSessions(workspaceId)).resolves.toBe(1);
    expect(getAgentSession(`${workspaceId}-chat`)?.archivedAt).toBeDefined();
    expect(getAgentSession(`${workspaceId}-room`)?.archivedAt).toBeUndefined();
  });

  it("Delete chats: deleteWorkspaceSessions", async () => {
    await expect(deleteWorkspaceSessions(workspaceId)).resolves.toBe(1);
    expect(getAgentSession(`${workspaceId}-chat`)).toBeUndefined();
    expect(getAgentSession(`${workspaceId}-room`)).toBeDefined();
  });
});
