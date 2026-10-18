import { DatabaseSync } from "node:sqlite";
import type { BrowserWindow as BrowserWindowType } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationClock } from "./automation-service";

let databaseRoot = "/tmp/modus-automation-service-test";
vi.mock("electron", () => ({ app: { getPath: () => databaseRoot } }));

const { migrateDatabase } = await import("../db/database");
const { createAutomationStore } = await import("./automation-store");
const { createAutomationService } = await import("./automation-service");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrateDatabase(db);
  const workspaceId = crypto.randomUUID();
  const now = "2026-10-18T12:00:00.000Z";
  db.prepare(
    `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
     values (?, ?, 'Project', 0, ?, ?)`,
  ).run(workspaceId, "/tmp/modus-automation-project", now, now);
  return { db, workspaceId };
}

function makeClock(initial = "2026-10-18T12:00:00.000Z") {
  let current = Date.parse(initial);
  const timers = new Set<{
    at: number;
    callback: () => void;
    cancelled: boolean;
  }>();
  return {
    now: () => new Date(current).toISOString(),
    setTimeout(callback: () => void, delay: number) {
      const timer = { at: current + delay, callback, cancelled: false };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer: unknown) {
      if (timer && typeof timer === "object" && "cancelled" in timer) {
        (timer as { cancelled: boolean }).cancelled = true;
      }
    },
    async advance(milliseconds: number) {
      current += milliseconds;
      for (;;) {
        const due = [...timers]
          .filter((timer) => !timer.cancelled && timer.at <= current)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        due.cancelled = true;
        timers.delete(due);
        due.callback();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    jump(milliseconds: number) {
      current += milliseconds;
    },
    pending: () => [...timers].filter((timer) => !timer.cancelled).length,
  };
}

function makeRuntime() {
  const promptGate = deferred<{ outcome: "ok"; finalText: string }>();
  const turnListeners = new Set<
    (event: { sessionId: string; result: { outcome: "ok" } }) => void
  >();
  const questionListeners = new Set<(sessionId: string) => void>();
  const runtime = {
    create: vi.fn(async (_window: BrowserWindowType, input: { id?: string; title: string }) => ({
      id: input.id ?? crypto.randomUUID(),
      workspaceId: "workspace",
      cwd: "/tmp/modus-automation-project",
      title: input.title,
      status: "starting" as const,
      runtime: "pi-sdk" as const,
      createdAt: "2026-10-18T12:00:00.000Z",
      updatedAt: "2026-10-18T12:00:00.000Z",
    })),
    prompt: vi.fn(() => promptGate.promise),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    listRuns: vi.fn(async () => []),
    onTurnSettled: vi.fn(
      (listener: (event: { sessionId: string; result: { outcome: "ok" } }) => void) => {
        turnListeners.add(listener);
        return () => turnListeners.delete(listener);
      },
    ),
    onQuestionPending: vi.fn((listener: (sessionId: string) => void) => {
      questionListeners.add(listener);
      return () => questionListeners.delete(listener);
    }),
    settle(sessionId: string) {
      for (const listener of turnListeners) listener({ sessionId, result: { outcome: "ok" } });
    },
    ask(sessionId: string) {
      for (const listener of questionListeners) listener(sessionId);
    },
    promptGate,
  };
  return runtime;
}

function makeWindow(minimized = false) {
  return {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindowType;
}

function createFixture() {
  const { db, workspaceId } = makeDb();
  const store = createAutomationStore(db, () => "2026-10-18T12:00:00.000Z");
  const clock = makeClock();
  const runtime = makeRuntime();
  const service = createAutomationService({
    store,
    runtime: runtime as unknown as Parameters<typeof createAutomationService>[0]["runtime"],
    clock: clock as unknown as AutomationClock,
  });
  const definition = store.createDefinition({
    name: "Daily summary",
    instruction: "Summarize the project changes.",
    schedule: { kind: "daily", localTime: "09:15" },
    timeZone: "America/Sao_Paulo",
    workspaceId,
    cwd: "/tmp/modus-automation-project",
    agentId: null,
    providerId: "openai",
    modelId: "openai/gpt-6.1-sol",
    thinkingLevel: "minimal",
    enabled: true,
  });
  return { db, store, clock, runtime, service, definition };
}

describe("automation service", () => {
  beforeEach(() => {
    databaseRoot = `/tmp/modus-automation-service-${crypto.randomUUID()}`;
  });

  it("reuses one scheduler for a live minimized window and admits one run with the saved model", async () => {
    const { db, store, clock, runtime, service, definition } = createFixture();
    const configured = store.updateDefinition(definition.id, definition.revision, {
      agentId: "agent-1",
    });
    const window = makeWindow(true);
    service.start(window);
    service.start(window);

    expect(clock.pending()).toBe(1);
    const accepted = await service.runNow(configured.id);
    await Promise.resolve();

    expect(accepted.status).toBe("running");
    expect(runtime.create).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        workspaceId: definition.workspaceId,
        cwd: definition.cwd,
        model: definition.modelId,
        title: definition.name,
        agentId: "agent-1",
      }),
    );
    expect(runtime.prompt).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        sessionId: accepted.sessionId,
        message: definition.instruction,
        model: definition.modelId,
        thinkingLevel: definition.thinkingLevel,
        context: [],
      }),
    );
    runtime.promptGate.resolve({ outcome: "ok", finalText: "Done" });
    await vi.waitFor(() => expect(store.listHistory(definition.id)[0]?.status).toBe("completed"));
    expect(store.listHistory(definition.id)[0]).toMatchObject({
      sessionId: accepted.sessionId,
      config: {
        workspaceId: configured.workspaceId,
        cwd: configured.cwd,
        agentId: "agent-1",
        providerId: configured.providerId,
        modelId: configured.modelId,
        instruction: configured.instruction,
      },
    });
    await service.stop();
    db.close();
  });

  it("keeps the global slot occupied after window close until runtime cancellation settles", async () => {
    const { db, store, runtime, service, definition } = createFixture();
    const window = makeWindow();
    service.start(window);
    const execution = await service.runNow(definition.id);
    await Promise.resolve();

    service.windowClosed();
    expect(runtime.abort).toHaveBeenCalledWith(execution.sessionId);
    expect(store.listHistory(definition.id)[0]?.status).toBe("cancelling");
    await expect(service.runNow(definition.id)).rejects.toMatchObject({ code: "busy" });

    runtime.promptGate.resolve({ outcome: "ok", finalText: "Done" });
    await vi.waitFor(() => expect(store.listHistory(definition.id)[0]?.status).toBe("cancelled"));
    await service.stop();
    db.close();
  });

  it("requests cancellation at ten minutes but retains the slot until settlement", async () => {
    const { db, store, clock, runtime, service, definition } = createFixture();
    service.start(makeWindow());
    const execution = await service.runNow(definition.id);
    await Promise.resolve();

    await clock.advance(10 * 60 * 1000);

    expect(runtime.abort).toHaveBeenCalledWith(execution.sessionId);
    expect(store.listHistory(definition.id)[0]?.status).toBe("cancelling");
    await expect(service.runNow(definition.id)).rejects.toMatchObject({ code: "busy" });

    runtime.promptGate.resolve({ outcome: "ok", finalText: "Done" });
    await vi.waitFor(() => expect(store.listHistory(definition.id)[0]?.status).toBe("cancelled"));
    await service.stop();
    db.close();
  });

  it("fails closed and retains the slot when session cleanup cannot be confirmed", async () => {
    const { db, store, runtime, service, definition } = createFixture();
    runtime.prompt.mockImplementationOnce(() => {
      throw new Error("Prompt setup failed");
    });
    runtime.dispose.mockRejectedValueOnce(new Error("Dispose failed"));
    service.start(makeWindow());
    await service.runNow(definition.id);

    await vi.waitFor(() =>
      expect(store.listHistory(definition.id)[0]?.status).toBe("cleanup_failed"),
    );
    await expect(service.runNow(definition.id)).rejects.toMatchObject({ code: "busy" });

    await service.stop();
    db.close();
  });

  it("marks a pending interaction without releasing the automation slot", async () => {
    const { db, store, runtime, service, definition } = createFixture();
    service.start(makeWindow());
    const execution = await service.runNow(definition.id);
    await Promise.resolve();
    if (!execution.sessionId) throw new Error("The automation session was not attached.");
    runtime.ask(execution.sessionId);

    expect(store.listHistory(definition.id)[0]?.status).toBe("waiting_for_you");
    await expect(service.runNow(definition.id)).rejects.toMatchObject({ code: "busy" });

    await service.stop();
    runtime.promptGate.resolve({ outcome: "ok", finalText: "Done" });
    await vi.waitFor(() => expect(store.listHistory(definition.id)[0]?.status).toBe("cancelled"));
    db.close();
  });

  it("records missed intervals on wake and schedules only the next future occurrence", async () => {
    const { db, store, clock, runtime, service, definition } = createFixture();
    service.start(makeWindow());
    const before = store.getDefinition(definition.id)?.nextOccurrenceAt;
    expect(before).toBe("2026-10-18T12:15:00.000Z");

    clock.jump(3 * 24 * 60 * 60 * 1000 + 20 * 60 * 1000);
    service.wake();

    expect(store.listHistory(definition.id)).toMatchObject([
      {
        triggerKind: "missed_interval",
        status: "missed",
        missedCount: 4,
        missedFirst: "2026-10-18T12:15:00.000Z",
        missedLast: "2026-10-21T12:15:00.000Z",
      },
    ]);
    expect(store.getDefinition(definition.id)?.nextOccurrenceAt).toBe("2026-10-22T12:15:00.000Z");
    expect(runtime.create).not.toHaveBeenCalled();
    await service.stop();
    db.close();
  });

  it("pauses admission when the window closes and resumes on a new window", async () => {
    const { db, store, clock, runtime, service, definition } = createFixture();
    service.start(makeWindow());
    service.windowClosed();
    await expect(service.runNow(definition.id)).rejects.toMatchObject({ code: "window-closed" });

    clock.jump(24 * 60 * 60 * 1000 + 20 * 60 * 1000);
    service.start(makeWindow(true));

    expect(store.listHistory(definition.id)[0]).toMatchObject({
      status: "missed",
      missedCount: 2,
    });
    expect(runtime.create).not.toHaveBeenCalled();
    await service.stop();
    db.close();
  });

  it("skips occurrences that become due while another automation owns the slot", async () => {
    const { db, store, clock, runtime, service, definition } = createFixture();
    const second = store.createDefinition({
      name: "Weekly review",
      instruction: "Review recent work.",
      schedule: { kind: "daily", localTime: "09:05" },
      timeZone: "America/Sao_Paulo",
      workspaceId: definition.workspaceId,
      cwd: definition.cwd,
      agentId: null,
      providerId: "openai",
      modelId: "openai/gpt-6.1-sol",
      thinkingLevel: "minimal",
      enabled: true,
    });
    service.start(makeWindow());
    await service.runNow(definition.id);
    await Promise.resolve();

    await clock.advance(5 * 60 * 1000);
    await vi.waitFor(() => expect(store.listHistory(second.id)[0]?.status).toBe("skipped"));

    expect(runtime.create).toHaveBeenCalledTimes(1);
    runtime.promptGate.resolve({ outcome: "ok", finalText: "Done" });
    await vi.waitFor(() => expect(store.listHistory(definition.id)[0]?.status).toBe("completed"));
    await service.stop();
    db.close();
  });

  it("reconciles an unresolved occurrence as interrupted and never retries it", async () => {
    const { db, store, runtime, service, definition } = createFixture();
    const claim = store.claimOccurrence({
      automationId: definition.id,
      expectedRevision: definition.revision,
      triggerKey: "manual:crashed-run",
      triggerKind: "manual",
      scheduledFor: null,
      occurredAt: "2026-10-18T12:00:00.000Z",
    });
    expect(claim.execution?.status).toBe("claimed");

    service.start(makeWindow());

    expect(store.listHistory(definition.id)[0]?.status).toBe("interrupted");
    expect(runtime.create).not.toHaveBeenCalled();
    await service.stop();
    db.close();
  });

  it("does not start work after shutdown", async () => {
    const { db, runtime, service, definition } = createFixture();
    service.start(makeWindow());
    await service.stop();

    await expect(service.runNow(definition.id)).rejects.toMatchObject({ code: "window-closed" });
    expect(runtime.create).not.toHaveBeenCalled();
    db.close();
  });
});
