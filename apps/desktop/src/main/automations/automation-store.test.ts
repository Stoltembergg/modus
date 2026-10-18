import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

let databaseRoot = "/tmp/modus-automation-store-test";
vi.mock("electron", () => ({ app: { getPath: () => databaseRoot } }));

const { migrateDatabase } = await import("../db/database");
const storeModule = await import("./automation-store").catch(() => null);

function automationInput(workspaceId: string, name = "Daily summary") {
  return {
    name,
    instruction: "Summarize the project changes.",
    schedule: { kind: "daily" as const, localTime: "09:15" },
    timeZone: "America/Sao_Paulo",
    workspaceId,
    cwd: "/tmp/modus-project",
    agentId: null,
    providerId: "openai",
    modelId: "openai/gpt-6.1-sol",
    thinkingLevel: "minimal" as const,
    enabled: true,
  };
}

function makeDatabase(): { db: DatabaseSync; workspaceId: string } {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrateDatabase(db);
  migrateDatabase(db);
  const workspaceId = crypto.randomUUID();
  const now = "2026-10-18T12:00:00.000Z";
  db.prepare(
    `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
     values (?, ?, 'Project', 0, ?, ?)`,
  ).run(workspaceId, "/tmp/modus-project", now, now);
  return { db, workspaceId };
}

describe("automation store", () => {
  beforeEach(() => {
    databaseRoot = `/tmp/modus-automation-store-${crypto.randomUUID()}`;
  });

  it("persists revisions and keeps each execution's configuration snapshot immutable", () => {
    expect(storeModule).not.toBeNull();
    if (!storeModule) return;

    const { db, workspaceId } = makeDatabase();
    const store = storeModule.createAutomationStore(db, () => "2026-10-18T12:00:00.000Z");
    const created = store.createDefinition(automationInput(workspaceId));
    expect(created).toMatchObject({
      revision: 1,
      instruction: "Summarize the project changes.",
      nextOccurrenceAt: "2026-10-18T12:15:00.000Z",
    });

    const claim = store.claimOccurrence({
      automationId: created.id,
      expectedRevision: 1,
      triggerKey: `scheduled:${created.id}:2026-10-18T12:15:00.000Z`,
      triggerKind: "scheduled",
      scheduledFor: "2026-10-18T12:15:00.000Z",
      nextOccurrenceAt: "2026-10-19T12:15:00.000Z",
      occurredAt: "2026-10-18T12:15:01.000Z",
    });
    expect(claim.kind).toBe("claimed");

    const updated = store.updateDefinition(created.id, 1, {
      instruction: "Use a shorter summary.",
    });
    expect(updated).toMatchObject({ revision: 2, instruction: "Use a shorter summary." });
    expect(store.listHistory(created.id)[0]?.config.instruction).toBe(
      "Summarize the project changes.",
    );
    db.close();
  });

  it("allows an explicit update to clear the saved thinking variant", () => {
    expect(storeModule).not.toBeNull();
    if (!storeModule) return;

    const { db, workspaceId } = makeDatabase();
    const store = storeModule.createAutomationStore(db, () => "2026-10-18T12:00:00.000Z");
    const created = store.createDefinition({
      ...automationInput(workspaceId),
      thinkingVariant: "reasoning-high",
    });
    const updated = store.updateDefinition(created.id, created.revision, { thinkingVariant: null });

    expect(updated.thinkingVariant).toBeUndefined();
    db.close();
  });

  it("deduplicates a claimed occurrence and skips due work while the global automation slot is occupied", () => {
    expect(storeModule).not.toBeNull();
    if (!storeModule) return;

    const { db, workspaceId } = makeDatabase();
    const store = storeModule.createAutomationStore(db, () => "2026-10-18T12:00:00.000Z");
    const first = store.createDefinition(automationInput(workspaceId, "First"));
    const second = store.createDefinition(automationInput(workspaceId, "Second"));
    const firstOccurrence = {
      automationId: first.id,
      expectedRevision: first.revision,
      triggerKey: `scheduled:${first.id}:2026-10-18T12:15:00.000Z`,
      triggerKind: "scheduled" as const,
      scheduledFor: "2026-10-18T12:15:00.000Z",
      nextOccurrenceAt: "2026-10-19T12:15:00.000Z",
      occurredAt: "2026-10-18T12:15:01.000Z",
    };

    expect(store.claimOccurrence(firstOccurrence).kind).toBe("claimed");
    expect(store.claimOccurrence(firstOccurrence).kind).toBe("duplicate");
    const skipped = store.claimOccurrence({
      ...firstOccurrence,
      automationId: second.id,
      expectedRevision: second.revision,
      triggerKey: `scheduled:${second.id}:2026-10-18T12:15:00.000Z`,
    });
    expect(skipped.kind).toBe("skipped");
    expect(store.listHistory(second.id)[0]?.status).toBe("skipped");
    expect(
      store.claimOccurrence({
        automationId: second.id,
        expectedRevision: second.revision,
        triggerKey: `manual:${second.id}:run-1`,
        triggerKind: "manual",
        scheduledFor: null,
        occurredAt: firstOccurrence.occurredAt,
      }).kind,
    ).toBe("busy");
    db.close();
  });

  it("blocks deleting active runs and retains conversation history after a settled definition is deleted", () => {
    expect(storeModule).not.toBeNull();
    if (!storeModule) return;

    const { db, workspaceId } = makeDatabase();
    const store = storeModule.createAutomationStore(db, () => "2026-10-18T12:00:00.000Z");
    const definition = store.createDefinition(automationInput(workspaceId));
    const claim = store.claimOccurrence({
      automationId: definition.id,
      expectedRevision: definition.revision,
      triggerKey: `scheduled:${definition.id}:2026-10-18T12:15:00.000Z`,
      triggerKind: "scheduled",
      scheduledFor: "2026-10-18T12:15:00.000Z",
      nextOccurrenceAt: "2026-10-19T12:15:00.000Z",
      occurredAt: "2026-10-18T12:15:01.000Z",
    });
    if (!claim.execution) throw new Error("expected a claimed execution");
    store.attachSession(claim.execution.id, "session-1", "2026-10-18T12:15:02.000Z");
    expect(() => store.softDeleteDefinition(definition.id, "2026-10-18T12:16:00.000Z")).toThrow(
      /wait for it to finish/i,
    );
    store.setExecutionStatus(claim.execution.id, "completed", { at: "2026-10-18T12:15:10.000Z" });
    store.softDeleteDefinition(definition.id, "2026-10-18T12:16:00.000Z");

    expect(store.listDefinitions()).toEqual([]);
    expect(store.listHistory(definition.id)).toHaveLength(1);
    expect(store.listHistory(definition.id)[0]?.sessionId).toBe("session-1");
    expect(store.listHistory(definition.id)[0]?.status).toBe("completed");
    db.close();
  });

  it("marks unresolved executions interrupted on restart without retrying them", () => {
    expect(storeModule).not.toBeNull();
    if (!storeModule) return;

    const { db, workspaceId } = makeDatabase();
    const store = storeModule.createAutomationStore(db, () => "2026-10-18T12:00:00.000Z");
    const definition = store.createDefinition(automationInput(workspaceId));
    const claim = store.claimOccurrence({
      automationId: definition.id,
      expectedRevision: definition.revision,
      triggerKey: `scheduled:${definition.id}:2026-10-18T12:15:00.000Z`,
      triggerKind: "scheduled",
      scheduledFor: "2026-10-18T12:15:00.000Z",
      nextOccurrenceAt: "2026-10-19T12:15:00.000Z",
      occurredAt: "2026-10-18T12:15:01.000Z",
    });
    if (!claim.execution) throw new Error("expected a claimed execution");
    store.attachSession(claim.execution.id, "session-2", "2026-10-18T12:15:02.000Z");
    store.reconcileUnresolved("2026-10-18T13:00:00.000Z");
    expect(store.listHistory(definition.id)[0]?.status).toBe("interrupted");
    db.close();
  });

  it("records one compact missed interval and advances the persisted occurrence", () => {
    expect(storeModule).not.toBeNull();
    if (!storeModule) return;

    const { db, workspaceId } = makeDatabase();
    let currentTime = "2026-10-18T11:59:00.000Z";
    const store = storeModule.createAutomationStore(db, () => currentTime);
    const definition = store.createDefinition(automationInput(workspaceId));
    currentTime = "2026-10-20T13:00:00.000Z";
    const missed = {
      automationId: definition.id,
      expectedRevision: definition.revision,
      first: "2026-10-18T12:15:00.000Z",
      last: "2026-10-20T12:15:00.000Z",
      count: 3,
      nextOccurrenceAt: "2026-10-21T12:15:00.000Z",
      through: currentTime,
    };

    expect(
      store.recordMissedInterval({
        ...missed,
        first: "2026-10-19T12:15:00.000Z",
        last: "2026-10-19T12:15:00.000Z",
        count: 1,
        nextOccurrenceAt: "2026-10-20T12:15:00.000Z",
      }),
    ).toBeNull();

    const recorded = store.recordMissedInterval(missed);
    expect(recorded).toMatchObject({ status: "missed", missedCount: 3 });
    expect(store.recordMissedInterval(missed)?.id).toBe(recorded?.id);
    expect(store.getDefinition(definition.id)?.nextOccurrenceAt).toBe(missed.nextOccurrenceAt);
    expect(store.listHistory(definition.id)).toHaveLength(1);
    db.close();
  });
});
