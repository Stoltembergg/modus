import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { GroupProactivityDecision } from "../../shared/group-work-state";

const userData = mkdtempSync(join(tmpdir(), "modus-proactivity-store-"));
vi.mock("electron", () => ({ app: { getPath: () => userData } }));
const { getDatabase, migrateDatabase } = await import("../db/database");
const { createAgentGroup, createGroupTask, appendGroupMessage } = await import("./group-store");
const { persistGroupChain, persistGroupJob } = await import("./group-job-store");
const {
  getGroupProactivityMode,
  setGroupProactivityMode,
  persistGroupProactivityDecision,
  listPendingGroupActions,
  getGroupAction,
  markGroupActionDispatched,
  invalidateGroupAction,
} = await import("./group-proactivity-store");

function fixture() {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "insert into workspaces (id, root_path, display_name, last_opened_at, created_at) values (?, ?, ?, ?, ?)",
  ).run(id, id, id, now, now);
  const group = createAgentGroup({ name: id, workspaceId: id });
  const task = createGroupTask({ groupId: group.id, title: "Task", status: "in_progress" });
  db.prepare(`insert into group_task_events
    (id, group_id, task_id, task_version, action, from_status, to_status, created_at)
    values (?, ?, ?, ?, 'assign', 'open', 'in_progress', ?)`).run(
    `event-${id}`,
    group.id,
    task.id,
    task.stateVersion ?? 1,
    now,
  );
  return { db, group, task, sourceEventId: `event-${id}` };
}

function decision(
  taskId: string,
  sourceEventId: string,
  kind: GroupProactivityDecision["kind"] = "wake_owner",
): GroupProactivityDecision {
  return {
    kind,
    taskId,
    sourceEventId,
    reasonCode: "owner-ready",
    ...(kind === "suggest" ? {} : { targetSessionId: "owner" }),
    idempotencyKey: JSON.stringify([sourceEventId, taskId, kind]),
  };
}

afterAll(() => {
  getDatabase().close();
  rmSync(userData, { recursive: true, force: true });
});

describe("group proactivity outbox", () => {
  it("defaults each group to suggest and persists independent opt-in", () => {
    const first = fixture();
    const second = fixture();
    expect(getGroupProactivityMode(first.group.id)).toBe("suggest");
    setGroupProactivityMode(first.group.id, "opt_in_auto");
    expect(getGroupProactivityMode(first.group.id)).toBe("opt_in_auto");
    expect(getGroupProactivityMode(second.group.id)).toBe("suggest");
  });

  it("keeps one pending action per key, its source, version and delivery identity", () => {
    const { group, task, sourceEventId } = fixture();
    const proposed = decision(task.id, sourceEventId);
    const first = persistGroupProactivityDecision(proposed);
    expect(first).toMatchObject({
      groupId: group.id,
      taskId: task.id,
      taskVersion: task.stateVersion,
      sourceEventId,
      deliveryState: "pending",
      version: 1,
    });
    expect(persistGroupProactivityDecision(proposed)).toEqual(first);
    expect(() =>
      persistGroupProactivityDecision({
        ...proposed,
        idempotencyKey: `${proposed.idempotencyKey}-other`,
      }),
    ).toThrow();
    expect(listPendingGroupActions(group.id)).toEqual([first]);
    expect(() => persistGroupProactivityDecision({ ...proposed, reasonCode: "changed" })).toThrow();
    const root = appendGroupMessage({ groupId: group.id, authorKind: "user", body: "Ask" });
    const message = appendGroupMessage({
      groupId: group.id,
      authorKind: "system",
      kind: "status",
      body: "Ready",
      chainId: root.id,
    });
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workspaceId = (
      getDatabase().prepare("select workspace_id from agent_groups where id = ?").get(group.id) as {
        workspace_id: string;
      }
    ).workspace_id;
    getDatabase()
      .prepare(
        "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, 'idle', ?, ?)",
      )
      .run(sessionId, workspaceId, "Owner", workspaceId, now, now);
    const jobId = crypto.randomUUID();
    persistGroupChain({
      groupId: group.id,
      chainId: root.id,
      hops: 0,
      agentMessages: 0,
      inputTokens: 0,
      wakesByMember: new Map(),
    });
    persistGroupJob({
      id: jobId,
      messageId: message.id,
      groupId: group.id,
      sessionId,
      chainId: root.id,
      triggerMessageId: message.id,
      seq: 1,
      prompt: "Work",
    });
    const dispatched = markGroupActionDispatched(first.id, message.id, jobId);
    expect(dispatched).toMatchObject({
      deliveryState: "dispatched",
      wakeMessageId: message.id,
      jobId,
      version: 2,
    });
    expect(getGroupAction(first.id)).toEqual(dispatched);
    expect(listPendingGroupActions(group.id)).toEqual([]);
  });

  it("preserves suggestions and invalidations without listing another group's pending action", () => {
    const a = fixture();
    const b = fixture();
    const suggested = persistGroupProactivityDecision(
      decision(a.task.id, a.sourceEventId, "suggest"),
    );
    const pending = persistGroupProactivityDecision(decision(b.task.id, b.sourceEventId));
    expect(suggested.deliveryState).toBe("suggested");
    expect(listPendingGroupActions(a.group.id)).toEqual([]);
    expect(listPendingGroupActions(b.group.id)).toEqual([pending]);
    expect(invalidateGroupAction(pending.id).deliveryState).toBe("invalidated");
    expect(listPendingGroupActions()).not.toContainEqual(pending);
  });

  it("reopens mode, pending state and source identity on a second SQLite connection", () => {
    const { group, task, sourceEventId } = fixture();
    setGroupProactivityMode(group.id, "opt_in_auto");
    const action = persistGroupProactivityDecision(decision(task.id, sourceEventId));
    const reopened = new DatabaseSync(join(userData, "modus.sqlite"));
    try {
      reopened.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(reopened);
      expect(
        reopened.prepare("select proactivity_mode from agent_groups where id = ?").get(group.id),
      ).toMatchObject({ proactivity_mode: "opt_in_auto" });
      expect(
        reopened
          .prepare(
            "select source_event_id, task_version, delivery_state, version from group_proactivity_actions where id = ?",
          )
          .get(action.id),
      ).toMatchObject({
        source_event_id: sourceEventId,
        task_version: task.stateVersion,
        delivery_state: "pending",
        version: 1,
      });
    } finally {
      reopened.close();
    }
  });

  it("rejects unknown source, cross-group task and malformed decision", () => {
    const a = fixture();
    const b = fixture();
    expect(() => persistGroupProactivityDecision(decision(b.task.id, a.sourceEventId))).toThrow();
    expect(() => persistGroupProactivityDecision(decision(a.task.id, "unknown"))).toThrow();
    expect(() =>
      persistGroupProactivityDecision({
        ...decision(a.task.id, a.sourceEventId),
        idempotencyKey: "",
      }),
    ).toThrow();
  });
});
