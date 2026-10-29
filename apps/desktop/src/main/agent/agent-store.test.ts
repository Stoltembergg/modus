import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_FACES,
  AGENT_AVATAR_SHAPES,
} from "../../shared/contracts";

let userData: string;

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
  },
}));

const { getDatabase } = await import("../db/database");
const {
  getAgentSession,
  createAgentSessionRecord,
  listAgentSessions,
  listOtherAgentSessionPiSessionFiles,
  listArchivedAgentSessions,
  setAgentSessionArchived,
  setAgentSessionPinned,
  touchAgentSession,
  updateAgentSessionMetadata,
  updateAgentSessionStatus,
  updateAgentSessionTitle,
} = await import("./agent-store");
const { recordAgentEvent } = await import("./agent-event-store");

function insertWorkspace(workspaceId: string): void {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(workspaceId, `root-${workspaceId}`, "repo", 1, now, now);
}

function insertSession(
  workspaceId: string,
  sessionId: string,
  title: string,
  updatedAt = new Date().toISOString(),
): void {
  getDatabase()
    .prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, workspaceId, title, `root-${workspaceId}`, "idle", updatedAt, updatedAt);
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-agent-store-test-"));
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("agent-store", () => {
  it("includes pending input IDs and the event cursor in the session list snapshot", () => {
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    const sessionId = `session-${crypto.randomUUID()}`;
    insertWorkspace(workspaceId);
    insertSession(workspaceId, sessionId, "Waiting session");
    recordAgentEvent({
      type: "question.requested",
      sessionId,
      request: { id: "question-1", questions: [] },
    });

    const listed = listAgentSessions().find((session) => session.id === sessionId);

    expect(listed?.activitySnapshot).toMatchObject({
      pendingInputRequestIds: ["question:question-1"],
      eventCursor: expect.any(Number),
    });
  });

  it("lists all other Pi file references, including archived and group-member sessions", () => {
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertWorkspace(workspaceId);
    const ids = ["target", "active", "archived", "group", "no-file"].map(
      (name) => `${name}-${crypto.randomUUID()}`,
    );
    for (const id of ids) insertSession(workspaceId, id, id);
    const paths = ids.slice(0, 4).map((id) => join(userData, `${id}.jsonl`));
    ids.slice(0, 4).forEach((id, index) => {
      updateAgentSessionMetadata(id, { piSessionFile: paths[index]! });
    });
    setAgentSessionArchived(ids[2]!, true);
    getDatabase()
      .prepare("update agent_sessions set kind = 'group_member' where id = ?")
      .run(ids[3]!);

    expect(listOtherAgentSessionPiSessionFiles(ids[0]!).sort()).toEqual(paths.slice(1).sort());
  });

  it("persists an optional Agent identity on a newly created session", () => {
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    const agentId = `agent-${crypto.randomUUID()}`;
    insertWorkspace(workspaceId);
    getDatabase()
      .prepare(
        `insert into agents (id, name, avatar_face, avatar_color, avatar_shape, created_at, updated_at)
         values (?, 'Automation Agent', ?, ?, ?, ?, ?)`,
      )
      .run(
        agentId,
        AGENT_AVATAR_FACES[0],
        AGENT_AVATAR_COLORS[0],
        AGENT_AVATAR_SHAPES[0],
        new Date().toISOString(),
        new Date().toISOString(),
      );

    const session = createAgentSessionRecord({
      workspaceId,
      cwd: `root-${workspaceId}`,
      title: "Scheduled conversation",
      agentId,
    });

    expect(session.agentId).toBe(agentId);
    expect(getAgentSession(session.id)?.agentId).toBe(agentId);
  });

  it("hides archived sessions from the default list", () => {
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    const visibleId = `session-${crypto.randomUUID()}`;
    const archivedId = `session-${crypto.randomUUID()}`;
    insertWorkspace(workspaceId);
    insertSession(workspaceId, visibleId, "Visible");
    insertSession(workspaceId, archivedId, "Archived");

    setAgentSessionArchived(archivedId, true);

    expect(listAgentSessions().map((session) => session.id)).toContain(visibleId);
    expect(listAgentSessions().map((session) => session.id)).not.toContain(archivedId);
    expect(
      listAgentSessions({ includeSessionId: archivedId }).map((session) => session.id),
    ).toEqual(expect.arrayContaining([visibleId, archivedId]));
    expect(listArchivedAgentSessions(workspaceId).map((session) => session.id)).toEqual([
      archivedId,
    ]);
  });

  it("sorts pinned sessions before regular sessions", () => {
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    const regularId = `session-${crypto.randomUUID()}`;
    const pinnedId = `session-${crypto.randomUUID()}`;
    insertWorkspace(workspaceId);
    insertSession(workspaceId, regularId, "Regular");
    insertSession(workspaceId, pinnedId, "Pinned");

    setAgentSessionPinned(pinnedId, true);

    const orderedIds = listAgentSessions()
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => session.id);
    expect(orderedIds).toEqual([pinnedId, regularId]);
  });

  it("keeps updated_at stable across open-side writes; only touch advances sort key", async () => {
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    const olderId = `session-${crypto.randomUUID()}`;
    const newerId = `session-${crypto.randomUUID()}`;
    insertWorkspace(workspaceId);
    insertSession(workspaceId, olderId, "Older", "2026-01-01T00:00:00.000Z");
    insertSession(workspaceId, newerId, "Newer", "2026-01-02T00:00:00.000Z");

    updateAgentSessionStatus(olderId, "running");
    updateAgentSessionMetadata(olderId, { model: "test/model" });
    updateAgentSessionTitle(olderId, "Renamed without activity");
    setAgentSessionPinned(olderId, true);
    setAgentSessionPinned(olderId, false);

    expect(getAgentSession(olderId)?.updatedAt).toBe("2026-01-01T00:00:00.000Z");

    const beforeTouch = listAgentSessions()
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => session.id);
    expect(beforeTouch).toEqual([newerId, olderId]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    touchAgentSession(olderId);

    const afterTouch = listAgentSessions()
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => session.id);
    expect(afterTouch).toEqual([olderId, newerId]);
    expect(getAgentSession(olderId)?.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });
});
