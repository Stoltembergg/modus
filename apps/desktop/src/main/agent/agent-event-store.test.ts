import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HarnessTaskClassification, HarnessTaskState } from "../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";

let userData: string;
let fixtureRoot: string;

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
  },
}));

const { getDatabase } = await import("../db/database");
const { createAgentRun } = await import("./agent-run-store");
const {
  getLatestCheckpointRestoreRowId,
  getLatestHarnessTaskState,
  getLatestTodoContinuationAttempt,
  getRunToolEvidence,
  getHarnessQAEventByRowId,
  listAgentEvents,
  recordAgentEvent,
} = await import("./agent-event-store");
const { getSessionCodeGraphDiscoveries } = await import("./agent-event-store");
const { getWorkspaceHarnessInsightEvidence } = await import("./agent-event-store");
const { recognizeCheckInvocation } = await import("./harness/qa-evidence");
const { summarizeRunQA } = await import("./harness/qa-evidence");

const taskStateClassification: HarnessTaskClassification = {
  taskType: "implementation",
  complexity: "simple",
  risk: "low",
  confidence: "high",
  reasons: [],
};

function taskStateFixture(
  sessionId: string,
  workspaceId: string,
  runId: string,
  updatedAt: string,
): HarnessTaskState {
  return {
    version: 1,
    sessionId,
    runId,
    workspaceId,
    goalMessageId: "message-1",
    classification: taskStateClassification,
    phase: "executing",
    verificationStatus: "not_required",
    criteria: [],
    constraintRefs: [],
    openQuestionRefs: [],
    todoIds: [],
    hypothesisRefs: [],
    evidenceRefs: [],
    updatedAt,
  };
}

function insertSession(sessionId: string): void {
  const now = new Date().toISOString();
  const db = getDatabase();
  db.prepare(
    `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(`workspace-${sessionId}`, `root-${sessionId}`, "repo", 1, now, now);
  db.prepare(
    `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, `workspace-${sessionId}`, "session", userData, "idle", now, now);
}

function insertSessionInWorkspace(sessionId: string, workspaceId: string): void {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, workspaceId, "sibling session", userData, "idle", now, now);
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "modus-event-store-test-"));
  userData = join(fixtureRoot, "data");
  await mkdir(join(userData, "apps", "desktop"), { recursive: true });
  await writeFile(
    join(userData, "package.json"),
    JSON.stringify({
      scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
      workspaces: ["apps/*"],
    }),
  );
  await writeFile(
    join(userData, "apps", "desktop", "package.json"),
    JSON.stringify({ name: "@modus/desktop", scripts: { typecheck: "tsc --noEmit" } }),
  );
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe("getLatestHarnessTaskState", () => {
  it("reads only the exact persisted QA row for its session and run", () => {
    const sessionId = `qa-row-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const result = {
      required: true,
      status: "passed" as const,
      reasonCode: "ok",
      sourceFingerprint: "final",
      evidence: [],
    };
    const rowId = recordAgentEvent({ type: "harness.qa", sessionId, runId: "run-a", result });
    expect(getHarnessQAEventByRowId(rowId, sessionId, "run-a")?.result).toEqual(result);
    expect(getHarnessQAEventByRowId(rowId, sessionId, "run-b")).toBeUndefined();
    expect(getHarnessQAEventByRowId(rowId, "other", "run-a")).toBeUndefined();
  });
  it("returns only the latest valid snapshot owned by the exact session and run", () => {
    const sessionId = `state-${crypto.randomUUID()}`;
    const siblingSessionId = `sibling-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const workspaceId = `workspace-${sessionId}`;
    insertSessionInWorkspace(siblingSessionId, workspaceId);
    const run = createAgentRun({ sessionId, prompt: "PRIVATE_PROMPT" });
    const otherRun = createAgentRun({ sessionId, prompt: "OTHER_PRIVATE_PROMPT" });
    const earlier = taskStateFixture(sessionId, workspaceId, run.id, "2026-09-27T00:00:00.000Z");
    const latest = taskStateFixture(sessionId, workspaceId, run.id, "2026-09-27T00:01:00.000Z");
    recordAgentEvent({ type: "harness.task_state", sessionId, runId: run.id, state: earlier });
    recordAgentEvent({ type: "harness.task_state", sessionId, runId: run.id, state: latest });
    recordAgentEvent({
      type: "harness.task_state",
      sessionId: siblingSessionId,
      runId: run.id,
      state: taskStateFixture(siblingSessionId, workspaceId, run.id, "2026-09-27T00:02:00.000Z"),
    });
    recordAgentEvent({
      type: "harness.task_state",
      sessionId,
      runId: otherRun.id,
      state: taskStateFixture(sessionId, workspaceId, otherRun.id, "2026-09-27T00:03:00.000Z"),
    });

    expect(getLatestHarnessTaskState(sessionId, run.id)).toEqual(latest);
    expect(JSON.stringify(getLatestHarnessTaskState(sessionId, run.id))).not.toContain(
      "PRIVATE_PROMPT",
    );
    expect(getLatestHarnessTaskState(siblingSessionId, run.id)).toBeUndefined();
    expect(getLatestHarnessTaskState(sessionId, otherRun.id)).toEqual(
      taskStateFixture(sessionId, workspaceId, otherRun.id, "2026-09-27T00:03:00.000Z"),
    );
  });

  it("fails closed on malformed latest snapshots instead of returning an older pass", () => {
    const cases = [
      { suffix: "invalid-json", payload: () => "{" },
      {
        suffix: "missing-run-id",
        payload: (sessionId: string, _runId: string, state: HarnessTaskState) =>
          JSON.stringify({ type: "harness.task_state", sessionId, state }),
      },
      {
        suffix: "unsafe-run-id",
        payload: (sessionId: string, _runId: string, state: HarnessTaskState) =>
          JSON.stringify({ type: "harness.task_state", sessionId, runId: "PRIVATE RUN", state }),
      },
      {
        suffix: "wrong-session",
        payload: (_sessionId: string, runId: string, state: HarnessTaskState) =>
          JSON.stringify({ type: "harness.task_state", sessionId: "other-session", runId, state }),
      },
      {
        suffix: "invalid-state",
        payload: (sessionId: string, runId: string, state: HarnessTaskState) =>
          JSON.stringify({
            type: "harness.task_state",
            sessionId,
            runId,
            state: { ...state, version: 9 },
          }),
      },
      {
        suffix: "unexpected-field",
        payload: (sessionId: string, runId: string, state: HarnessTaskState) =>
          JSON.stringify({
            type: "harness.task_state",
            sessionId,
            runId,
            state: { ...state, prompt: "PRIVATE_PROMPT" },
          }),
      },
      {
        suffix: "oversized",
        payload: (sessionId: string, runId: string, state: HarnessTaskState) =>
          JSON.stringify({ type: "harness.task_state", sessionId, runId, state }).padEnd(
            262145,
            " ",
          ),
      },
    ] as const;

    for (const invalid of cases) {
      const sessionId = `malformed-${invalid.suffix}-${crypto.randomUUID()}`;
      insertSession(sessionId);
      const workspaceId = `workspace-${sessionId}`;
      const run = createAgentRun({ sessionId, prompt: "PRIVATE_PROMPT" });
      const earlier = taskStateFixture(sessionId, workspaceId, run.id, "2026-09-27T00:00:00.000Z");
      recordAgentEvent({ type: "harness.task_state", sessionId, runId: run.id, state: earlier });
      const payload = invalid.payload(sessionId, run.id, earlier);
      getDatabase()
        .prepare(
          "insert into agent_events (id, session_id, type, payload_json, created_at) values (?, ?, ?, ?, ?)",
        )
        .run(
          `malformed-state-${invalid.suffix}-${crypto.randomUUID()}`,
          sessionId,
          "harness.task_state",
          payload,
          new Date().toISOString(),
        );
      expect(getLatestHarnessTaskState(sessionId, run.id)).toBeUndefined();
    }
  });

  it("rejects verified state with zero checks and a fabricated passing event ID", () => {
    const sessionId = `verified-empty-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const workspaceId = `workspace-${sessionId}`;
    const run = createAgentRun({ sessionId, prompt: "Verify work" });
    const state = {
      ...taskStateFixture(sessionId, workspaceId, run.id, "2026-09-27T00:00:00.000Z"),
      phase: "terminal" as const,
      verificationStatus: "verified" as const,
      criteria: [],
      evidenceRefs: [],
    };
    recordAgentEvent({ type: "harness.task_state", sessionId, runId: run.id, state });

    expect(getLatestHarnessTaskState(sessionId, run.id)).toBeUndefined();

    const verified = {
      ...state,
      criteria: [
        {
          criterionId: "check:tests",
          source: "check" as const,
          status: "verified" as const,
          evidenceEventIds: ["passing-test-event"],
          requiredCheckKinds: ["tests" as const],
        },
      ],
      evidenceRefs: [
        { eventId: "passing-test-event", kind: "check" as const, status: "passed" as const },
      ],
    };
    const userConfirmedInsteadOfChecked = {
      ...verified,
      evidenceRefs: [
        {
          eventId: "passing-test-event",
          kind: "user_confirmation" as const,
          status: "user_confirmed" as const,
        },
      ],
    };
    recordAgentEvent({
      type: "harness.task_state",
      sessionId,
      runId: run.id,
      state: userConfirmedInsteadOfChecked,
    });
    expect(getLatestHarnessTaskState(sessionId, run.id)).toBeUndefined();

    recordAgentEvent({ type: "harness.task_state", sessionId, runId: run.id, state: verified });

    expect(getRunToolEvidence(sessionId, run.id)).toEqual([]);
    expect(
      getDatabase()
        .prepare(
          "select 1 from agent_events where session_id = ? and type = 'harness.qa' and json_extract(payload_json, '$.runId') = ? limit 1",
        )
        .get(sessionId, run.id),
    ).toBeUndefined();
    expect(getLatestHarnessTaskState(sessionId, run.id)).toBeUndefined();
  });

  it("fails closed when a newer envelope run disagrees with the state run", () => {
    const sessionId = `run-mismatch-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const workspaceId = `workspace-${sessionId}`;
    const requestedRun = createAgentRun({ sessionId, prompt: "Requested run" });
    const envelopeRun = createAgentRun({ sessionId, prompt: "Envelope run" });
    const older = taskStateFixture(
      sessionId,
      workspaceId,
      requestedRun.id,
      "2026-09-27T00:00:00.000Z",
    );
    const mismatched = taskStateFixture(
      sessionId,
      workspaceId,
      requestedRun.id,
      "2026-09-27T00:01:00.000Z",
    );
    recordAgentEvent({
      type: "harness.task_state",
      sessionId,
      runId: requestedRun.id,
      state: older,
    });
    recordAgentEvent({
      type: "harness.task_state",
      sessionId,
      runId: envelopeRun.id,
      state: mismatched,
    });

    expect(getLatestHarnessTaskState(sessionId, requestedRun.id)).toBeUndefined();
  });

  it("rejects a snapshot whose workspace does not match the owning session", () => {
    const sessionId = `workspace-state-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const workspaceId = `workspace-${sessionId}`;
    const run = createAgentRun({ sessionId, prompt: "PRIVATE_PROMPT" });
    const state = taskStateFixture(sessionId, workspaceId, run.id, "2026-09-27T00:00:00.000Z");
    recordAgentEvent({
      type: "harness.task_state",
      sessionId,
      runId: run.id,
      state: { ...state, workspaceId: "foreign-workspace" },
    });
    expect(getLatestHarnessTaskState(sessionId, run.id)).toBeUndefined();
  });

  it("rejects valid-looking Task State events for a Chats workspace session", () => {
    const sessionId = `chats-task-state-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const db = getDatabase();
    const workspaceExists = db
      .prepare("select 1 from workspaces where id = ?")
      .get(CHATS_WORKSPACE_ID);
    if (!workspaceExists) {
      db.prepare(
        `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      ).run(CHATS_WORKSPACE_ID, `root-${sessionId}`, "Chats", 0, now, now);
    }
    db.prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, CHATS_WORKSPACE_ID, "Chats task-state test", userData, "idle", now, now);
    try {
      const run = createAgentRun({ sessionId, prompt: "PRIVATE_PROMPT" });
      const state = taskStateFixture(
        sessionId,
        CHATS_WORKSPACE_ID,
        run.id,
        "2026-09-27T00:00:00.000Z",
      );
      recordAgentEvent({ type: "harness.task_state", sessionId, runId: run.id, state });

      expect(getLatestHarnessTaskState(sessionId, run.id)).toBeUndefined();
    } finally {
      db.prepare("delete from agent_events where session_id = ?").run(sessionId);
      db.prepare("delete from agent_runs where session_id = ?").run(sessionId);
      db.prepare("delete from agent_sessions where id = ?").run(sessionId);
      if (!workspaceExists) {
        db.prepare("delete from workspaces where id = ?").run(CHATS_WORKSPACE_ID);
      }
    }
  });

  it("returns the durable SQLite rowid from recordAgentEvent", () => {
    const sessionId = `rowid-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const rowId = recordAgentEvent({ type: "agent.started", sessionId });
    expect(Number.isSafeInteger(rowId)).toBe(true);
    expect(rowId).toBeGreaterThan(0);
  });

  it("deduplicates matching idempotent events and rejects key reuse for a different payload", () => {
    const sessionId = `idempotent-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const event = { type: "runtime.error", sessionId, message: "publish once" } as const;
    const options = { idempotencyKey: "hyperplan-selection-1" };

    const firstRowId = recordAgentEvent(event, options);
    const retryRowId = recordAgentEvent(event, options);
    const rowCount = getDatabase()
      .prepare("select count(*) as count from agent_events where session_id = ? and type = ?")
      .get(sessionId, event.type) as { count: number };

    expect(retryRowId).toBe(firstRowId);
    expect(rowCount.count).toBe(1);
    expect(() => recordAgentEvent({ ...event, message: "different payload" }, options)).toThrow(
      /idempotency key.*different event/i,
    );
  });

  it("keeps original-build idempotency unique across a process-style restart", async () => {
    const sessionId = `epoch-restart-${crypto.randomUUID()}`;
    const ownerId = 73;
    const requestId = "same-request";
    insertSession(sessionId);

    const firstStore = await import("./harness/hyperplan-draft-store");
    const firstEpoch = firstStore.registerHyperPlanDraftOwner(ownerId);
    const firstIdentity = firstStore.getHyperPlanOwnerEpochIdentity(firstEpoch);
    if (!firstIdentity) throw new Error("First owner epoch has no durable identity.");
    const firstKey = `original:${ownerId}:${firstIdentity}:${requestId}`;
    const original = {
      type: "message.started",
      sessionId,
      messageId: firstKey,
      role: "user",
    } as const;
    const firstRowId = recordAgentEvent(original, { idempotencyKey: firstKey });
    expect(recordAgentEvent(original, { idempotencyKey: firstKey })).toBe(firstRowId);

    // Reload only the in-memory draft store to model Electron restarting while retaining SQLite.
    await vi.resetModules();
    const restartedStore = await import("./harness/hyperplan-draft-store");
    const secondEpoch = restartedStore.registerHyperPlanDraftOwner(ownerId);
    const secondIdentity = restartedStore.getHyperPlanOwnerEpochIdentity(secondEpoch);
    if (!secondIdentity) throw new Error("Restarted owner epoch has no durable identity.");
    const secondKey = `original:${ownerId}:${secondIdentity}:${requestId}`;
    const replacement = {
      type: "message.started",
      sessionId,
      messageId: secondKey,
      role: "user",
    } as const;

    expect(secondKey).not.toBe(firstKey);
    const secondRowId = recordAgentEvent(replacement, {
      idempotencyKey: secondKey,
    });
    expect(secondRowId).not.toBe(firstRowId);
    const rows = getDatabase()
      .prepare("select id, payload_json from agent_events where session_id = ? order by rowid")
      .all(sessionId) as Array<{ id: string; payload_json: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
    expect(rows.map(({ payload_json }) => JSON.parse(payload_json).messageId)).toEqual([
      firstKey,
      secondKey,
    ]);
    expect(recordAgentEvent(replacement, { idempotencyKey: secondKey })).toBe(secondRowId);
  });
});

describe("post-restore QA evidence", () => {
  it("rejects a passing check from before restore and accepts a rerun afterward", () => {
    const sessionId = `restore-state-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "Run tests" });
    recordAgentEvent({
      type: "checkpoint.restored",
      sessionId,
      checkpointId: "restore-before-run",
    });
    const runStartedRowId = recordAgentEvent({
      type: "run.started",
      sessionId,
      runId: run.id,
      userMessageId: "message-1",
      delivery: "normal",
    });
    const recordPassingTests = (toolCallId: string) => {
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId,
        toolName: "bash",
        args: { command: "vitest run" },
      });
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId,
        toolName: "bash",
        isError: false,
        exitCode: 0,
      });
    };

    recordPassingTests("before-restore");
    const restoreRowId = recordAgentEvent({
      type: "checkpoint.restored",
      sessionId,
      checkpointId: "checkpoint-1",
    });
    expect(getLatestCheckpointRestoreRowId(sessionId, runStartedRowId)).toBe(restoreRowId);
    expect(restoreRowId).toBeGreaterThan(0);
    expect(getRunToolEvidence(sessionId, run.id, restoreRowId)).toEqual([]);
    expect(
      summarizeRunQA({
        sessionId,
        runId: run.id,
        changedPaths: [],
        requiredChecks: ["tests"],
        events: getRunToolEvidence(sessionId, run.id, restoreRowId),
      }).status,
    ).toBe("missing");

    recordPassingTests("after-restore");
    expect(
      summarizeRunQA({
        sessionId,
        runId: run.id,
        changedPaths: [],
        requiredChecks: ["tests"],
        events: getRunToolEvidence(sessionId, run.id, restoreRowId),
      }).status,
    ).toBe("passed");
  });
});

describe("agent-event-store", () => {
  it("normalizes SQLite boolean encodings for QA and tool evidence only when exactly zero or one", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "PRIVATE_PROMPT" });
    recordAgentEvent({
      type: "harness.qa",
      sessionId,
      runId: run.id,
      result: {
        required: true,
        status: "missing",
        reasonCode: "required_check_missing",
        evidence: [],
      },
    });
    recordAgentEvent({
      type: "harness.qa",
      sessionId,
      runId: run.id,
      result: {
        required: false,
        status: "missing",
        reasonCode: "required_check_missing",
        evidence: [],
      },
    });
    recordAgentEvent({
      type: "harness.qa",
      sessionId,
      runId: run.id,
      result: {
        required: "true",
        status: "missing",
        reasonCode: "required_check_missing",
        evidence: [],
      },
    } as never);
    recordAgentEvent({
      type: "harness.qa",
      sessionId,
      runId: run.id,
      result: {
        required: 1,
        status: "failed",
        reasonCode: "required_check_missing",
        evidence: [],
      },
    } as never);
    recordAgentEvent({
      type: "tool.ended",
      sessionId,
      runId: run.id,
      toolCallId: "strict-flags",
      toolName: "terminal_run",
      isError: true,
      aborted: false,
      skipped: true,
    });
    recordAgentEvent({
      type: "tool.ended",
      sessionId,
      runId: run.id,
      toolCallId: "strict-false-flags",
      toolName: "strict-false-flags",
      isError: false,
      aborted: false,
      skipped: false,
    });
    recordAgentEvent({
      type: "tool.ended",
      sessionId,
      runId: run.id,
      toolCallId: "invalid-flags",
      toolName: "terminal_run",
      isError: "true",
      aborted: 2,
      skipped: null,
    } as never);
    recordAgentEvent({
      type: "tool.ended",
      sessionId,
      runId: run.id,
      toolCallId: "numeric-flags",
      toolName: "numeric-flags",
      isError: 1,
      aborted: 0,
      skipped: 1,
    } as never);

    const evidence = getWorkspaceHarnessInsightEvidence(
      `workspace-${sessionId}`,
      "2000-01-01T00:00:00.000Z",
      "2100-01-01T00:00:00.000Z",
    );

    expect(evidence.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "harness.qa",
          runId: run.id,
          qaRequired: true,
          qaStatus: "missing",
        }),
        expect.objectContaining({ type: "harness.qa", qaRequired: false }),
        expect.objectContaining({
          type: "tool.ended",
          isError: true,
          aborted: false,
          skipped: true,
        }),
        expect.objectContaining({
          type: "tool.ended",
          toolName: "strict-false-flags",
          isError: false,
          aborted: false,
          skipped: false,
        }),
      ]),
    );
    const invalidFlags = evidence.events.find(
      (event) => event.type === "tool.ended" && event.isError === undefined,
    );
    expect(invalidFlags).not.toHaveProperty("aborted");
    expect(invalidFlags).not.toHaveProperty("skipped");
    const invalidRequired = evidence.events.find(
      (event) => event.type === "harness.qa" && event.qaRequired === undefined,
    );
    expect(invalidRequired).toBeDefined();
    const numericRequired = evidence.events.find(
      (event) => event.type === "harness.qa" && event.qaStatus === "failed",
    );
    expect(numericRequired).not.toHaveProperty("qaRequired");
    const numericFlags = evidence.events.find(
      (event) => event.type === "tool.ended" && event.toolName === "numeric-flags",
    );
    expect(numericFlags).not.toHaveProperty("isError");
    expect(numericFlags).not.toHaveProperty("aborted");
    expect(numericFlags).not.toHaveProperty("skipped");
  });

  it("drops event payload run IDs owned by another session in the same workspace", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const siblingId = `sibling-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${sessionId}`;
    insertSession(sessionId);
    insertSessionInWorkspace(siblingId, workspaceId);
    const run = createAgentRun({ sessionId, prompt: "PRIVATE_PROMPT" });
    createAgentRun({ sessionId: siblingId, prompt: "OTHER_PRIVATE_PROMPT" });
    recordAgentEvent({
      type: "run.failed",
      sessionId,
      runId: run.id,
      message: "own run failure",
    });
    recordAgentEvent({
      type: "run.failed",
      sessionId: siblingId,
      runId: run.id,
      message: "cross-session forged run reference",
    });

    const evidence = getWorkspaceHarnessInsightEvidence(
      workspaceId,
      "2000-01-01T00:00:00.000Z",
      "2100-01-01T00:00:00.000Z",
    );

    expect(
      evidence.events.some((event) => event.sessionId === siblingId && event.runId === run.id),
    ).toBe(false);
    expect(
      evidence.events.some((event) => event.sessionId === sessionId && event.runId === run.id),
    ).toBe(true);
  });

  it("returns empty Harness Insights evidence for the Chats sentinel workspace", () => {
    const sessionId = `chats-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    getDatabase()
      .prepare(
        `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(CHATS_WORKSPACE_ID, `root-${sessionId}`, "Chats", 0, now, now);
    insertSessionInWorkspace(sessionId, CHATS_WORKSPACE_ID);
    const run = createAgentRun({ sessionId, prompt: "PRIVATE_CHAT_PROMPT" });
    recordAgentEvent({
      type: "run.failed",
      sessionId,
      runId: run.id,
      message: "PRIVATE_CHAT_FAILURE",
    });

    expect(
      getWorkspaceHarnessInsightEvidence(
        CHATS_WORKSPACE_ID,
        "2000-01-01T00:00:00.000Z",
        "2100-01-01T00:00:00.000Z",
      ),
    ).toEqual({ runs: [], events: [] });
  });

  it("queries bounded workspace-scoped insight metadata without prompts or event text", () => {
    const sessionId = `insight-session-${crypto.randomUUID()}`;
    const otherSessionId = `insight-other-${crypto.randomUUID()}`;
    insertSession(sessionId);
    insertSession(otherSessionId);
    const run = createAgentRun({ sessionId, prompt: "PRIVATE_RUN_PROMPT" });
    const otherRun = createAgentRun({ sessionId: otherSessionId, prompt: "PRIVATE_OTHER_PROMPT" });
    recordAgentEvent({
      type: "harness.route",
      sessionId,
      runId: run.id,
      taskType: "implementation",
      selectedRole: "explore",
      reasonCodes: ["PRIVATE_REASON_TEXT"],
    } as never);
    recordAgentEvent({
      type: "run.failed",
      sessionId,
      runId: run.id,
      message: "PRIVATE_FAILURE_TEXT",
    });
    recordAgentEvent({
      type: "tool.ended",
      sessionId,
      runId: run.id,
      toolCallId: "tool-safe-id",
      toolName: "terminal_run",
      isError: true,
      exitCode: 1,
      command: "PRIVATE_COMMAND",
      output: "PRIVATE_OUTPUT",
    } as never);
    recordAgentEvent({
      type: "run.failed",
      sessionId: otherSessionId,
      runId: otherRun.id,
      message: "FOREIGN_FAILURE",
    });

    const evidence = getWorkspaceHarnessInsightEvidence(
      `workspace-${sessionId}`,
      "2000-01-01T00:00:00.000Z",
      "2100-01-01T00:00:00.000Z",
      { runLimit: 20, eventLimit: 100 },
    );

    expect(evidence.runs.map(({ runId }) => runId)).toEqual([run.id]);
    expect(evidence.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["harness.route", "run.failed", "tool.ended"]),
    );
    const serialized = JSON.stringify(evidence);
    for (const privateText of [
      "PRIVATE_RUN_PROMPT",
      "PRIVATE_FAILURE_TEXT",
      "PRIVATE_REASON_TEXT",
      "PRIVATE_COMMAND",
      "PRIVATE_OUTPUT",
      "FOREIGN_FAILURE",
    ]) {
      expect(serialized).not.toContain(privateText);
    }
  });

  it("applies the time window and requested run cap before projecting evidence", () => {
    const sessionId = `insight-window-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const olderRun = createAgentRun({ sessionId, prompt: "older private prompt" });
    const recentRun = createAgentRun({ sessionId, prompt: "recent private prompt" });
    getDatabase()
      .prepare("update agent_runs set started_at = ? where id = ?")
      .run("2020-01-01T00:00:00.000Z", olderRun.id);
    getDatabase()
      .prepare("update agent_runs set started_at = ? where id = ?")
      .run("2026-01-15T00:00:00.000Z", recentRun.id);
    recordAgentEvent({
      type: "run.failed",
      sessionId,
      runId: olderRun.id,
      message: "older failure",
    });
    recordAgentEvent({
      type: "run.failed",
      sessionId,
      runId: recentRun.id,
      message: "recent failure",
    });

    const evidence = getWorkspaceHarnessInsightEvidence(
      `workspace-${sessionId}`,
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      { runLimit: 1, eventLimit: 10 },
    );

    expect(evidence.runs.map(({ runId }) => runId)).toEqual([recentRun.id]);
    expect(evidence.events.every((event) => event.runId === recentRun.id)).toBe(true);
  });

  it("projects deduplicated CodeGraph references without event prose or source body", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const runId = "discovery-run";
    const hit = { path: "src/run.ts", symbol: "Agent.run", line: 7, kind: "function" };
    recordAgentEvent({
      type: "codegraph.discoveries",
      sessionId,
      runId,
      hits: [hit, hit, { path: "../escape.ts", symbol: "escape" }],
      query: "PRIVATE_QUERY_TEXT",
      text: "PRIVATE_PROSE_TEXT",
      sourceBody: "PRIVATE_SOURCE_BODY",
    } as never);
    recordAgentEvent({
      type: "message.delta",
      sessionId,
      messageId: "private-message",
      delta: "PRIVATE_TRANSCRIPT_TEXT",
    });

    const discoveries = getSessionCodeGraphDiscoveries(sessionId);

    expect(discoveries).toEqual([{ runId, ...hit }]);
    expect(JSON.stringify(discoveries)).not.toContain("PRIVATE_QUERY_TEXT");
    expect(JSON.stringify(discoveries)).not.toContain("PRIVATE_PROSE_TEXT");
    expect(JSON.stringify(discoveries)).not.toContain("PRIVATE_SOURCE_BODY");
    expect(JSON.stringify(discoveries)).not.toContain("PRIVATE_TRANSCRIPT_TEXT");
  });

  it("bounds session CodeGraph discovery projection", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    for (let index = 0; index < 250; index += 1) {
      recordAgentEvent({
        type: "codegraph.discoveries",
        sessionId,
        runId: `discovery-run-${index}`,
        hits: [{ path: `src/file-${index}.ts`, symbol: `symbol-${index}` }],
      } as never);
    }

    const discoveries = getSessionCodeGraphDiscoveries(sessionId);

    expect(discoveries.length).toBeLessThanOrEqual(200);
    expect(discoveries.every((hit) => hit.runId && hit.path.startsWith("src/"))).toBe(true);
  });

  it("resolves a package test script body for QA classification", () => {
    expect(recognizeCheckInvocation("terminal_run", "npm test", userData)).toMatchObject({
      checkName: "tests",
    });
  });
  it("does not reclassify a package check after its manifest changes during execution", async () => {
    await writeFile(
      join(userData, "package.json"),
      JSON.stringify({
        scripts: { test: "node mutate-package.js", posttest: "node cleanup.js" },
        workspaces: ["apps/*"],
      }),
    );
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "private prompt" });
    try {
      expect(recognizeCheckInvocation("terminal_run", "npm test", userData)).toBeUndefined();
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId: "mutating-package-check-call",
        toolName: "terminal_run",
        args: { command: "npm test" },
        __qaCheckSnapshot: { version: 1, checkName: "tests", fullProject: true },
      } as never);

      await writeFile(
        join(userData, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" }, workspaces: ["apps/*"] }),
      );
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId: "mutating-package-check-call",
        toolName: "terminal_run",
        isError: false,
        exitCode: 0,
      } as never);

      const events = getRunToolEvidence(sessionId, run.id);
      const qa = summarizeRunQA({
        sessionId,
        runId: run.id,
        changedPaths: [],
        requiredChecks: ["tests"],
        events,
      });

      expect(events.every((event) => event.checkName === undefined)).toBe(true);
      expect(qa.status).toBe("missing");
      expect(qa.evidence.every((ref) => ref.status !== "passed")).toBe(true);
    } finally {
      await writeFile(
        join(userData, "package.json"),
        JSON.stringify({
          scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
          workspaces: ["apps/*"],
        }),
      );
    }
  });
  it("keeps a safe package classification captured at tool start", async () => {
    await writeFile(
      join(userData, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" }, workspaces: ["apps/*"] }),
    );
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "private prompt" });
    try {
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId: "frozen-safe-package-check-call",
        toolName: "terminal_run",
        args: { command: "npm test" },
      } as never);
      const startRow = getDatabase()
        .prepare(
          `select payload_json from agent_events
           where session_id = ? and json_extract(payload_json, '$.runId') = ?
             and json_extract(payload_json, '$.toolCallId') = ?`,
        )
        .get(sessionId, run.id, "frozen-safe-package-check-call") as
        | { payload_json: string }
        | undefined;
      const persistedStart = JSON.parse(startRow?.payload_json ?? "{}") as Record<string, unknown>;
      expect(persistedStart.__qaCheckSnapshot).toMatchObject({
        version: 1,
        checkName: "tests",
        packageConfigDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(JSON.stringify(persistedStart.__qaCheckSnapshot)).not.toContain("vitest run");
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId: "frozen-safe-package-check-call",
        toolName: "terminal_run",
        isError: false,
        exitCode: 0,
      } as never);

      const events = getRunToolEvidence(sessionId, run.id);
      const qa = summarizeRunQA({
        sessionId,
        runId: run.id,
        changedPaths: [],
        requiredChecks: ["tests"],
        events,
      });

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "tool.started", checkName: "tests" }),
          expect.objectContaining({ type: "tool.ended", checkName: "tests", exitCode: 0 }),
        ]),
      );
      expect(events.find((event) => event.type === "tool.ended")?.checkConfigStable).toBe(true);
      expect(qa.status).toBe("passed");
    } finally {
      await writeFile(
        join(userData, "package.json"),
        JSON.stringify({
          scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
          workspaces: ["apps/*"],
        }),
      );
    }
  });
  it("rejects package QA when a recognized script definition changes before tool end", async () => {
    await writeFile(
      join(userData, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" }, workspaces: ["apps/*"] }),
    );
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "private prompt" });
    try {
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId: "changed-package-check-call",
        toolName: "terminal_run",
        args: { command: "npm test" },
      } as never);
      await writeFile(
        join(userData, "package.json"),
        JSON.stringify({ scripts: { test: "jest" }, workspaces: ["apps/*"] }),
      );
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId: "changed-package-check-call",
        toolName: "terminal_run",
        isError: false,
        exitCode: 0,
      } as never);

      const events = getRunToolEvidence(sessionId, run.id);
      const qa = summarizeRunQA({
        sessionId,
        runId: run.id,
        changedPaths: [],
        requiredChecks: ["tests"],
        events,
      });

      expect(events.find((event) => event.type === "tool.started")?.checkName).toBe("tests");
      expect(events.find((event) => event.type === "tool.ended")?.checkConfigStable).toBe(false);
      expect(qa.status).toBe("missing");
      expect(qa.evidence.every((ref) => ref.status !== "passed")).toBe(true);
    } finally {
      await writeFile(
        join(userData, "package.json"),
        JSON.stringify({
          scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
          workspaces: ["apps/*"],
        }),
      );
    }
  });
  it("rejects a package script that changes and is restored before tool end", async () => {
    const safeManifest = JSON.stringify({
      scripts: { test: "vitest run" },
      workspaces: ["apps/*"],
    });
    await writeFile(join(userData, "package.json"), safeManifest);
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "private prompt" });
    try {
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId: "restored-package-check-call",
        toolName: "terminal_run",
        args: { command: "npm test" },
      } as never);
      await writeFile(
        join(userData, "package.json"),
        JSON.stringify({ scripts: { test: "jest" }, workspaces: ["apps/*"] }),
      );
      await writeFile(join(userData, "package.json"), safeManifest);
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId: "restored-package-check-call",
        toolName: "terminal_run",
        isError: false,
        exitCode: 0,
      } as never);

      const events = getRunToolEvidence(sessionId, run.id);
      const qa = summarizeRunQA({
        sessionId,
        runId: run.id,
        changedPaths: [],
        requiredChecks: ["tests"],
        events,
      });

      expect(events.find((event) => event.type === "tool.ended")?.checkConfigStable).toBe(false);
      expect(qa.status).toBe("missing");
      expect(qa.evidence.every((ref) => ref.status !== "passed")).toBe(true);
    } finally {
      await writeFile(
        join(userData, "package.json"),
        JSON.stringify({
          scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
          workspaces: ["apps/*"],
        }),
      );
    }
  });
  it("preserves the first package snapshot when tool lifecycle events are replayed", async () => {
    const manifestPath = join(userData, "package.json");
    await writeFile(manifestPath, JSON.stringify({ scripts: { test: "node unsafe.js" } }));
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "private prompt" });
    const start = {
      type: "tool.started" as const,
      sessionId,
      runId: run.id,
      toolCallId: "replayed-package-check",
      toolName: "terminal_run",
      args: { command: "npm test" },
    };
    const end = {
      type: "tool.ended" as const,
      sessionId,
      runId: run.id,
      toolCallId: start.toolCallId,
      toolName: start.toolName,
      isError: false,
      exitCode: 0,
    };
    const qa = () =>
      summarizeRunQA({
        sessionId,
        runId: run.id,
        changedPaths: [],
        requiredChecks: ["tests"],
        events: getRunToolEvidence(sessionId, run.id),
      });
    try {
      const startRowId = recordAgentEvent(start);
      await writeFile(manifestPath, JSON.stringify({ scripts: { test: "vitest run" } }));
      const endRowId = recordAgentEvent(end);
      expect(qa().status).toBe("missing");
      const replayStartRowId = recordAgentEvent(start);
      const replayEndRowId = recordAgentEvent(end);
      expect(qa().status).toBe("missing");
      expect(qa().evidence.every((ref) => ref.status !== "passed")).toBe(true);
      expect(replayStartRowId).toBe(startRowId);
      expect(replayEndRowId).toBe(endRowId);
      const keyedStartRowId = recordAgentEvent(start, { idempotencyKey: "replayed-start-key" });
      const keyedEndRowId = recordAgentEvent(end, { idempotencyKey: "replayed-end-key" });
      expect(recordAgentEvent(start, { idempotencyKey: "replayed-start-key" })).toBe(
        keyedStartRowId,
      );
      expect(recordAgentEvent(end, { idempotencyKey: "replayed-end-key" })).toBe(keyedEndRowId);
      expect(qa().status).toBe("missing");
      expect(getRunToolEvidence(sessionId, run.id)).toHaveLength(2);
      expect(getRunToolEvidence(sessionId, run.id, endRowId)).toEqual([]);
      expect(() =>
        recordAgentEvent(
          { ...start, toolCallId: "different-call" },
          { idempotencyKey: "replayed-start-key" },
        ),
      ).toThrow(/idempotency key.*different event/i);
      expect(() =>
        recordAgentEvent(
          { ...start, args: { command: "vitest run" } },
          { idempotencyKey: "different-start-key" },
        ),
      ).toThrow(/tool event identity.*different event/i);
      expect(() => recordAgentEvent({ ...start, args: { command: "vitest run" } })).toThrow(
        /tool event identity.*different event/i,
      );
      // A new execution has a new call ID and can collect fresh trusted evidence.
      recordAgentEvent({ ...start, toolCallId: "fresh-package-check" });
      recordAgentEvent({ ...end, toolCallId: "fresh-package-check" });
      expect(qa().status).toBe("passed");
    } finally {
      await writeFile(
        manifestPath,
        JSON.stringify({
          scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
          workspaces: ["apps/*"],
        }),
      );
    }
  });

  it("rejects a conflicting end that would turn a failed call into a pass", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "private prompt" });
    recordAgentEvent({
      type: "tool.started",
      sessionId,
      runId: run.id,
      toolCallId: "failed-call",
      toolName: "terminal_run",
      args: { command: "vitest run" },
    });
    const end = {
      type: "tool.ended" as const,
      sessionId,
      runId: run.id,
      toolCallId: "failed-call",
      toolName: "terminal_run",
      isError: true,
      exitCode: 1,
    };
    const rowId = recordAgentEvent(end);
    expect(recordAgentEvent(end)).toBe(rowId);
    expect(() => recordAgentEvent({ ...end, isError: false, exitCode: 0 })).toThrow(
      /tool event identity.*different event/i,
    );
    expect(
      summarizeRunQA({
        sessionId,
        runId: run.id,
        changedPaths: [],
        requiredChecks: ["tests"],
        events: getRunToolEvidence(sessionId, run.id),
      }).status,
    ).toBe("failed");
  });

  it.for([
    "cwd",
    "workspace",
  ])("rejects QA after its %s directory is swapped and restored", async (scope) => {
    const sandbox = await mkdtemp(join(userData, "directory-qa-"));
    const cwd = join(sandbox, "repo");
    const workspaceRoot = join(cwd, "apps", "desktop");
    const savedDirectory = join(sandbox, "saved-directory");
    const swappedDirectory = scope === "cwd" ? cwd : workspaceRoot;
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run" },
        workspaces: ["apps/*"],
      }),
    );
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify({
        name: "@modus/desktop",
        scripts: { typecheck: "tsc --noEmit" },
      }),
    );
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    getDatabase().prepare("update agent_sessions set cwd = ? where id = ?").run(cwd, sessionId);
    const run = createAgentRun({ sessionId, prompt: "private prompt" });
    const command = scope === "cwd" ? "npm test" : "npm --workspace @modus/desktop run typecheck";
    const checkName = scope === "cwd" ? "tests" : "typecheck";
    try {
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId: "swapped-directory",
        toolName: "terminal_run",
        args: { command },
      });
      await rename(swappedDirectory, savedDirectory);
      await mkdir(swappedDirectory);
      await writeFile(
        join(swappedDirectory, "package.json"),
        JSON.stringify({
          name: "@modus/desktop",
          scripts: { test: "node unsafe.js", typecheck: "node unsafe.js" },
        }),
      );
      expect(recognizeCheckInvocation("terminal_run", command, cwd)).toBeUndefined();
      await rm(swappedDirectory, { recursive: true });
      await rename(savedDirectory, swappedDirectory);
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId: "swapped-directory",
        toolName: "terminal_run",
        isError: false,
        exitCode: 0,
      });
      const events = getRunToolEvidence(sessionId, run.id);
      expect(events.find((event) => event.type === "tool.ended")).toMatchObject({
        checkConfigStable: false,
      });
      expect(
        summarizeRunQA({
          sessionId,
          runId: run.id,
          changedPaths: [],
          requiredChecks: [checkName],
          events,
        }).status,
      ).toBe("missing");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.for([
    "container",
    "outer",
  ])("rejects actual unsafe npm execution after the %s ancestor is restored", async (scope) => {
    const sandbox = await mkdtemp(join(userData, "regular-ancestor-qa-"));
    const outer = join(sandbox, "outer");
    const container = join(outer, "container");
    const cwd = join(container, "project");
    const swappedDirectory = scope === "outer" ? outer : container;
    const relativeProject = scope === "outer" ? join("container", "project") : "project";
    const saved = join(sandbox, "saved");
    const alternate = join(sandbox, "alternate");
    const executed = join(sandbox, "executed");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(alternate, relativeProject), { recursive: true });
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    await writeFile(
      join(alternate, relativeProject, "package.json"),
      JSON.stringify({
        scripts: { test: "node bypass.cjs" },
      }),
    );
    await writeFile(
      join(alternate, relativeProject, "bypass.cjs"),
      `const fs = require("node:fs");
fs.writeFileSync("unsafe-marker", "yes");
fs.renameSync(${JSON.stringify(swappedDirectory)}, ${JSON.stringify(executed)});
fs.renameSync(${JSON.stringify(saved)}, ${JSON.stringify(swappedDirectory)});
console.log("unsafe-ancestor-script-ran");
`,
    );
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    getDatabase().prepare("update agent_sessions set cwd = ? where id = ?").run(cwd, sessionId);
    const run = createAgentRun({ sessionId, prompt: "private prompt" });
    try {
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId: "regular-ancestor",
        toolName: "terminal_run",
        args: { command: "npm test" },
      });
      await rename(swappedDirectory, saved);
      await rename(alternate, swappedDirectory);
      expect(recognizeCheckInvocation("terminal_run", "npm test", cwd)).toBeUndefined();
      const output = execFileSync("npm", ["test", "--ignore-scripts=false"], {
        cwd,
        timeout: 10_000,
        stdio: "pipe",
        encoding: "utf8",
        env: { ...process.env, npm_config_update_notifier: "false", npm_config_audit: "false" },
      });
      expect(output).toContain("unsafe-ancestor-script-ran");
      expect(await readFile(join(executed, relativeProject, "unsafe-marker"), "utf8")).toBe("yes");
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId: "regular-ancestor",
        toolName: "terminal_run",
        isError: false,
        exitCode: 0,
      });
      const events = getRunToolEvidence(sessionId, run.id);
      expect(events.find((event) => event.type === "tool.ended")).toMatchObject({
        checkConfigStable: false,
      });
      const qa = summarizeRunQA({
        sessionId,
        runId: run.id,
        changedPaths: [],
        requiredChecks: ["tests"],
        events,
      });
      expect(qa.status).toBe("missing");
      expect(qa.evidence.every((ref) => ref.status !== "passed")).toBe(true);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects unsafe npm execution after a direct temporary cwd is restored", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "modus-direct-cwd-"));
    const sandbox = await mkdtemp(join(tmpdir(), "modus-direct-cwd-control-"));
    const saved = join(sandbox, "saved");
    const alternate = join(sandbox, "alternate");
    const executed = join(sandbox, "executed");
    await mkdir(alternate);
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    await writeFile(
      join(alternate, "package.json"),
      JSON.stringify({ scripts: { test: "node bypass.cjs" } }),
    );
    await writeFile(
      join(alternate, "bypass.cjs"),
      `const fs = require("node:fs");
fs.writeFileSync("unsafe-marker", "yes");
fs.renameSync(${JSON.stringify(cwd)}, ${JSON.stringify(executed)});
fs.renameSync(${JSON.stringify(saved)}, ${JSON.stringify(cwd)});
console.log("unsafe-direct-cwd-script-ran");
`,
    );
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    getDatabase().prepare("update agent_sessions set cwd = ? where id = ?").run(cwd, sessionId);
    const run = createAgentRun({ sessionId, prompt: "private prompt" });
    try {
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId: "direct-temp-cwd",
        toolName: "terminal_run",
        args: { command: "npm test" },
      });
      await rename(cwd, saved);
      await rename(alternate, cwd);
      const output = execFileSync("npm", ["test", "--ignore-scripts=false"], {
        cwd,
        timeout: 10_000,
        stdio: "pipe",
        encoding: "utf8",
        env: { ...process.env, npm_config_update_notifier: "false", npm_config_audit: "false" },
      });
      expect(output).toContain("unsafe-direct-cwd-script-ran");
      expect(await readFile(join(executed, "unsafe-marker"), "utf8")).toBe("yes");
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId: "direct-temp-cwd",
        toolName: "terminal_run",
        isError: false,
        exitCode: 0,
      });
      const events = getRunToolEvidence(sessionId, run.id);
      expect(events.find((event) => event.type === "tool.ended")).toMatchObject({
        checkConfigStable: false,
      });
      const qa = summarizeRunQA({
        sessionId,
        runId: run.id,
        changedPaths: [],
        requiredChecks: ["tests"],
        events,
      });
      expect(qa.status).toBe("missing");
      expect(qa.evidence.every((ref) => ref.status !== "passed")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects QA after a symlink above cwd is swapped and restored", async (context) => {
    const sandbox = await mkdtemp(join(userData, "ancestor-link-qa-"));
    const safeDirectory = join(sandbox, "safe");
    const unsafeDirectory = join(sandbox, "unsafe");
    const link = join(sandbox, "current");
    const savedLink = join(sandbox, "saved-link");
    await mkdir(join(safeDirectory, "repo"), { recursive: true });
    await mkdir(join(unsafeDirectory, "repo"), { recursive: true });
    await writeFile(
      join(safeDirectory, "repo", "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run" },
      }),
    );
    await writeFile(
      join(unsafeDirectory, "repo", "package.json"),
      JSON.stringify({
        scripts: { test: "node unsafe.js" },
      }),
    );
    try {
      try {
        await symlink(safeDirectory, link, "dir");
      } catch (error) {
        if (
          ["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          context.skip("This filesystem or user cannot create directory symlinks.");
        throw error;
      }
      const cwd = join(link, "repo");
      const sessionId = `session-${crypto.randomUUID()}`;
      insertSession(sessionId);
      getDatabase().prepare("update agent_sessions set cwd = ? where id = ?").run(cwd, sessionId);
      const run = createAgentRun({ sessionId, prompt: "private prompt" });
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId: "ancestor-link",
        toolName: "terminal_run",
        args: { command: "npm test" },
      });
      await rename(link, savedLink);
      await symlink(unsafeDirectory, link, "dir");
      expect(recognizeCheckInvocation("terminal_run", "npm test", cwd)).toBeUndefined();
      await rm(link);
      await rename(savedLink, link);
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId: "ancestor-link",
        toolName: "terminal_run",
        isError: false,
        exitCode: 0,
      });
      const events = getRunToolEvidence(sessionId, run.id);
      expect(events.find((event) => event.type === "tool.ended")).toMatchObject({
        checkConfigStable: false,
      });
      expect(
        summarizeRunQA({
          sessionId,
          runId: run.id,
          changedPaths: [],
          requiredChecks: ["tests"],
          events,
        }).status,
      ).toBe("missing");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.for([
    "cwd",
    "workspace",
  ])("preserves QA when artifacts are created inside %s", async (scope) => {
    const cwd = await mkdtemp(join(userData, "artifact-qa-"));
    const workspaceRoot = join(cwd, "apps", "desktop");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(cwd, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify({
        name: "@modus/desktop",
        scripts: { typecheck: "tsc --noEmit" },
      }),
    );
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    getDatabase().prepare("update agent_sessions set cwd = ? where id = ?").run(cwd, sessionId);
    const run = createAgentRun({ sessionId, prompt: "private prompt" });
    try {
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId: "artifact-check",
        toolName: "terminal_run",
        args: { command: "npm --workspace @modus/desktop run typecheck" },
      });
      await mkdir(join(scope === "cwd" ? cwd : workspaceRoot, "dist"));
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId: "artifact-check",
        toolName: "terminal_run",
        isError: false,
        exitCode: 0,
      });
      const events = getRunToolEvidence(sessionId, run.id);
      expect(events.find((event) => event.type === "tool.ended")).toMatchObject({
        checkConfigStable: true,
      });
      expect(
        summarizeRunQA({
          sessionId,
          runId: run.id,
          changedPaths: [],
          requiredChecks: ["typecheck"],
          events,
        }).status,
      ).toBe("passed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.for([
    { manifestScope: "root", command: "npm test", checkName: "tests" },
    {
      manifestScope: "root",
      command: "npm --workspace @modus/desktop run typecheck",
      checkName: "typecheck",
    },
    {
      manifestScope: "workspace",
      command: "npm --workspace @modus/desktop run typecheck",
      checkName: "typecheck",
    },
  ])("rejects restored $manifestScope manifest symlinks for $command", async ({
    manifestScope,
    command,
    checkName,
  }, context) => {
    const cwd = await mkdtemp(join(userData, "symlink-qa-"));
    const workspaceRoot = join(cwd, "apps", "desktop");
    await mkdir(workspaceRoot, { recursive: true });
    const rootManifest = JSON.stringify({
      scripts: { test: "vitest run" },
      workspaces: ["apps/*"],
    });
    const workspaceManifest = JSON.stringify({
      name: "@modus/desktop",
      scripts: { typecheck: "tsc --noEmit" },
    });
    await writeFile(join(cwd, "package.json"), rootManifest);
    await writeFile(join(workspaceRoot, "package.json"), workspaceManifest);
    const manifestPath = join(manifestScope === "root" ? cwd : workspaceRoot, "package.json");
    const safeTarget = join(cwd, "safe-manifest.json");
    const unsafeTarget = join(cwd, "unsafe-manifest.json");
    const savedLink = join(cwd, "original-manifest-link");
    await writeFile(safeTarget, manifestScope === "root" ? rootManifest : workspaceManifest);
    await writeFile(unsafeTarget, JSON.stringify({ scripts: { test: "node unsafe.js" } }));
    await rm(manifestPath);
    try {
      try {
        await symlink(safeTarget, manifestPath, "file");
      } catch (error) {
        if (
          ["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        ) {
          context.skip("This filesystem or user cannot create file symlinks.");
        }
        throw error;
      }
      const sessionId = `session-${crypto.randomUUID()}`;
      insertSession(sessionId);
      getDatabase().prepare("update agent_sessions set cwd = ? where id = ?").run(cwd, sessionId);
      const run = createAgentRun({ sessionId, prompt: "private prompt" });
      const recordStart = (toolCallId: string) =>
        recordAgentEvent({
          type: "tool.started",
          sessionId,
          runId: run.id,
          toolCallId,
          toolName: "terminal_run",
          args: { command },
        } as never);
      const recordEnd = (toolCallId: string) =>
        recordAgentEvent({
          type: "tool.ended",
          sessionId,
          runId: run.id,
          toolCallId,
          toolName: "terminal_run",
          isError: false,
          exitCode: 0,
        } as never);

      // An unchanged symlink remains a valid package check.
      recordStart("stable-symlink-check");
      recordEnd("stable-symlink-check");
      expect(
        summarizeRunQA({
          sessionId,
          runId: run.id,
          changedPaths: [],
          requiredChecks: [checkName],
          events: getRunToolEvidence(sessionId, run.id),
        }).status,
      ).toBe("passed");

      recordStart("restored-symlink-check");
      await rename(manifestPath, savedLink);
      await symlink(unsafeTarget, manifestPath, "file");
      expect(recognizeCheckInvocation("terminal_run", command, cwd)).toBeUndefined();
      if (manifestScope === "root" && command === "npm test") {
        await writeFile(
          join(cwd, "unsafe.cjs"),
          `const fs = require("node:fs");
console.log("unsafe-script-ran");
fs.unlinkSync("package.json");
fs.renameSync("original-manifest-link", "package.json");
`,
        );
        await writeFile(unsafeTarget, JSON.stringify({ scripts: { test: "node unsafe.cjs" } }));
        const output = execFileSync("npm", ["test", "--ignore-scripts=false"], {
          cwd,
          timeout: 10_000,
          stdio: "pipe",
          encoding: "utf8",
          env: { ...process.env, npm_config_update_notifier: "false", npm_config_audit: "false" },
        });
        expect(output).toContain("unsafe-script-ran");
      } else {
        await rm(manifestPath);
        await rename(savedLink, manifestPath);
      }
      recordEnd("restored-symlink-check");

      const events = getRunToolEvidence(sessionId, run.id);
      const ended = events.find(
        (event) => event.type === "tool.ended" && event.toolCallId === "restored-symlink-check",
      );
      expect(ended?.type === "tool.ended" ? ended.checkConfigStable : undefined).toBe(false);
      const qa = summarizeRunQA({
        sessionId,
        runId: run.id,
        changedPaths: [],
        requiredChecks: [checkName],
        events,
      });
      expect(qa.status).toBe("missing");
      expect(qa.evidence.every((ref) => ref.status !== "passed")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for legacy package starts while retaining direct check recognition", async () => {
    await writeFile(
      join(userData, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" }, workspaces: ["apps/*"] }),
    );
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "private prompt" });
    const legacyStarts = [
      {
        type: "tool.started" as const,
        sessionId,
        runId: run.id,
        toolCallId: "legacy-package-check-call",
        toolName: "terminal_run",
        args: { command: "npm test" },
      },
      {
        type: "tool.started" as const,
        sessionId,
        runId: run.id,
        toolCallId: "legacy-direct-check-call",
        toolName: "terminal_run",
        args: { command: "vitest run" },
      },
    ];
    for (const [index, event] of legacyStarts.entries()) {
      getDatabase()
        .prepare(
          `insert into agent_events (id, session_id, type, payload_json, created_at)
           values (?, ?, ?, ?, ?)`,
        )
        .run(
          `legacy-check-start-${index}-${crypto.randomUUID()}`,
          sessionId,
          event.type,
          JSON.stringify(event),
          new Date().toISOString(),
        );
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: false,
        exitCode: 0,
      } as never);
    }

    const starts = getRunToolEvidence(sessionId, run.id).filter(
      (event) => event.type === "tool.started",
    );

    expect(starts[0]?.checkName).toBeUndefined();
    expect(starts[1]?.checkName).toBe("tests");
    expect(starts).toEqual([
      expect.objectContaining({ type: "tool.started", toolCallId: "legacy-package-check-call" }),
      expect.objectContaining({
        type: "tool.started",
        toolCallId: "legacy-direct-check-call",
        checkName: "tests",
      }),
    ]);
  });
  it("does not project npm test as QA evidence when posttest mutates source", async () => {
    await writeFile(
      join(userData, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run", posttest: "eslint --fix ." },
        workspaces: ["apps/*"],
      }),
    );
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "private prompt" });
    recordAgentEvent({
      type: "tool.started",
      sessionId,
      runId: run.id,
      toolCallId: "posttest-check-call",
      toolName: "terminal_run",
      args: { command: "npm test" },
    } as never);
    recordAgentEvent({
      type: "tool.ended",
      sessionId,
      runId: run.id,
      toolCallId: "posttest-check-call",
      toolName: "terminal_run",
      isError: false,
      exitCode: 0,
    } as never);

    const evidence = getRunToolEvidence(sessionId, run.id);

    expect(evidence).toHaveLength(2);
    expect(evidence.every((event) => event.checkName === undefined)).toBe(true);
    await writeFile(
      join(userData, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
        workspaces: ["apps/*"],
      }),
    );
  });
  it("rejects lifecycle hooks on recognized workspace check scripts", async () => {
    await writeFile(
      join(userData, "apps", "desktop", "package.json"),
      JSON.stringify({
        name: "@modus/desktop",
        scripts: { typecheck: "tsc --noEmit", pretypecheck: "eslint --fix ." },
      }),
    );

    expect(
      recognizeCheckInvocation(
        "terminal_run",
        "npm --workspace @modus/desktop run typecheck",
        userData,
      ),
    ).toBeUndefined();

    await writeFile(
      join(userData, "apps", "desktop", "package.json"),
      JSON.stringify({ name: "@modus/desktop", scripts: { typecheck: "tsc --noEmit" } }),
    );
    expect(
      recognizeCheckInvocation(
        "terminal_run",
        "npm --workspace @modus/desktop run typecheck",
        userData,
      ),
    ).toMatchObject({ checkName: "typecheck" });
  });
  it("fails closed for package scripts that only list tests or mutate during lint", async () => {
    await writeFile(
      join(userData, "package.json"),
      JSON.stringify({ scripts: { test: "vitest list", lint: "eslint --fix ." } }),
    );
    expect(recognizeCheckInvocation("terminal_run", "npm test", userData)).toBeUndefined();
    expect(recognizeCheckInvocation("terminal_run", "npm run lint", userData)).toBeUndefined();
    await writeFile(
      join(userData, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
        workspaces: ["apps/*"],
      }),
    );
  });
  it("loads only the latest continuation attempt for its root run and rehydrates after event replay", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const rootRun = createAgentRun({ sessionId, prompt: "private root prompt" });
    const otherRun = createAgentRun({ sessionId, prompt: "another private prompt" });
    recordAgentEvent({
      type: "harness.continuation",
      sessionId,
      runId: rootRun.id,
      attempt: 1,
      reasonCode: "actionable_todos",
    });

    expect(getLatestTodoContinuationAttempt(sessionId, rootRun.id)).toBe(1);
    expect(getLatestTodoContinuationAttempt(sessionId, otherRun.id)).toBe(0);
    expect(JSON.stringify(getLatestTodoContinuationAttempt(sessionId, rootRun.id))).not.toContain(
      "private root prompt",
    );

    getDatabase()
      .prepare("delete from agent_events where session_id = ? and type = 'harness.continuation'")
      .run(sessionId);
    expect(getLatestTodoContinuationAttempt(sessionId, rootRun.id)).toBe(0);
  });

  it("returns exact-run tool references without raw args, output, or run prompts", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const otherSessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    insertSession(otherSessionId);
    const run = createAgentRun({ sessionId, prompt: "PRIVATE_TRANSCRIPT_PROMPT" });
    const otherRun = createAgentRun({ sessionId, prompt: "OTHER_PRIVATE_PROMPT" });
    recordAgentEvent({
      type: "tool.started",
      sessionId,
      runId: run.id,
      toolCallId: "check-call",
      toolName: "terminal_run",
      args: { command: "npm test" },
    } as never);
    recordAgentEvent({
      type: "tool.ended",
      sessionId,
      runId: run.id,
      toolCallId: "check-call",
      toolName: "terminal_run",
      isError: false,
      exitCode: 0,
      output: "private-secret output",
    } as never);
    recordAgentEvent({
      type: "tool.started",
      sessionId,
      runId: otherRun.id,
      toolCallId: "unrelated-call",
      toolName: "terminal_run",
      args: { command: "npm test" },
    } as never);
    recordAgentEvent({
      type: "tool.started",
      sessionId: otherSessionId,
      runId: run.id,
      toolCallId: "other-session-call",
      toolName: "terminal_run",
      args: { command: "npm test" },
    } as never);

    const evidence = getRunToolEvidence(sessionId, run.id);

    expect(evidence).toHaveLength(2);
    expect(evidence.every((event) => event.sessionId === sessionId && event.runId === run.id)).toBe(
      true,
    );
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool.started", checkName: "tests" }),
        expect.objectContaining({ type: "tool.ended", checkName: "tests", exitCode: 0 }),
      ]),
    );
    expect(JSON.stringify(evidence)).not.toContain("private-secret");
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_TRANSCRIPT_PROMPT");
    expect(JSON.stringify(evidence)).not.toContain("npm test");
    expect(evidence.some((event) => "output" in event)).toBe(false);
  });

  it("does not recognize unrelated shell commands as checks", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "PRIVATE_PROMPT" });
    recordAgentEvent({
      type: "tool.started",
      sessionId,
      runId: run.id,
      toolCallId: "echo-call",
      toolName: "terminal_run",
      args: { command: "echo hello" },
    } as never);
    recordAgentEvent({
      type: "tool.ended",
      sessionId,
      runId: run.id,
      toolCallId: "echo-call",
      toolName: "terminal_run",
      isError: false,
    } as never);

    expect(getRunToolEvidence(sessionId, run.id)).toEqual(
      expect.arrayContaining([expect.not.objectContaining({ checkName: expect.anything() })]),
    );
  });

  it("bounds tool evidence to the latest run events", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "run tests" });
    for (let index = 0; index < 260; index += 1) {
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId: `noise-${index}`,
        toolName: "terminal_run",
        args: { command: "echo no-check" },
      } as never);
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId: `noise-${index}`,
        toolName: "terminal_run",
        isError: false,
      } as never);
    }
    recordAgentEvent({
      type: "tool.started",
      sessionId,
      runId: run.id,
      toolCallId: "latest-check",
      toolName: "terminal_run",
      args: { command: "npm test" },
    } as never);
    recordAgentEvent({
      type: "tool.ended",
      sessionId,
      runId: run.id,
      toolCallId: "latest-check",
      toolName: "terminal_run",
      isError: false,
    } as never);

    const evidence = getRunToolEvidence(sessionId, run.id);

    expect(evidence.length).toBeLessThanOrEqual(500);
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: "latest-check", checkName: "tests" }),
      ]),
    );
  });

  it("recognizes checks only from supported command starts and check-capable tools", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "check commands" });
    const commands = [
      ["bash", "npm test", undefined],
      ["terminal_run", "npm run typecheck", "typecheck"],
      ["terminal_run", "npx vitest run", undefined],
      ["terminal_run", "npm --workspace @modus/desktop run typecheck", "typecheck"],
      ["terminal_run", "echo npm test", undefined],
      ["terminal_run", "printf 'vitest'", undefined],
      ["terminal_run", '"npm test"', undefined],
      ["other_tool", "npm test", undefined],
      ["terminal_run", "npm --workspace @unknown/package run typecheck", undefined],
    ] as const;
    commands.forEach(([toolName, command], index) => {
      const toolCallId = `command-${index}`;
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId,
        toolName,
        args: { command },
      } as never);
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId,
        toolName,
        isError: false,
        exitCode: 0,
      } as never);
    });

    const evidence = getRunToolEvidence(sessionId, run.id);
    const starts = evidence.filter((event) => event.type === "tool.started");
    expect(
      starts.map((event) => (event.type === "tool.started" ? event.checkName : undefined)),
    ).toEqual([
      undefined,
      "typecheck",
      undefined,
      "typecheck",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("rejects help/version invocations and projects a bounded source-mutation marker", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "check command classification" });
    const commands = [
      ["npx vitest run --help", false],
      ["npm test -- --help", false],
      ["npm test -- -h", false],
      ["npm test -- --version", false],
      ["npm test -- -v", false],
      ["vitest list", false],
      ["npx vitest list", false],
      ["jest --listTests", false],
      ["npm test -- --listTests", false],
      ["npm test -- --list", false],
      ["npm test -- --list-tests", false],
      ["npm test -- --showConfig", false],
      ["biome check --write src/a.ts", true],
      ["eslint --fix src/a.ts", true],
      ["npm run lint -- --fix", true],
      ["npm run lint -- --apply", true],
      ["npm run lint -- --apply=unsafe", true],
    ] as const;
    commands.forEach(([command], index) => {
      const toolCallId = `classification-${index}`;
      recordAgentEvent({
        type: "tool.started",
        sessionId,
        runId: run.id,
        toolCallId,
        toolName: "terminal_run",
        args: { command },
      } as never);
      recordAgentEvent({
        type: "tool.ended",
        sessionId,
        runId: run.id,
        toolCallId,
        toolName: "terminal_run",
        isError: false,
        exitCode: 0,
      } as never);
    });

    const evidence = getRunToolEvidence(sessionId, run.id);
    const starts = evidence.filter((event) => event.type === "tool.started");
    const ends = evidence.filter((event) => event.type === "tool.ended");
    commands.forEach(([, expectedMutation], index) => {
      const start = starts[index];
      const end = ends[index];
      expect(start?.type === "tool.started" && start.mutatesSource === true).toBe(expectedMutation);
      expect(end?.type === "tool.ended" && end.mutatesSource === true).toBe(expectedMutation);
      if (!expectedMutation) expect(start?.type === "tool.started" && start.checkName).toBeFalsy();
    });
    expect(JSON.stringify(evidence)).not.toMatch(
      /--help|--version|--list|--showConfig|--fix|--write|--apply/,
    );
  });

  it("keeps a recognized bash check without explicit exit code unavailable", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "run test checks" });
    recordAgentEvent({
      type: "tool.started",
      sessionId,
      runId: run.id,
      toolCallId: "bash-check",
      toolName: "bash",
      args: { command: "vitest run" },
    } as never);
    recordAgentEvent({
      type: "tool.ended",
      sessionId,
      runId: run.id,
      toolCallId: "bash-check",
      toolName: "bash",
      isError: false,
    } as never);

    const evidence = getRunToolEvidence(sessionId, run.id);
    const ended = evidence.find((event) => event.type === "tool.ended");

    expect(ended).toMatchObject({ type: "tool.ended", checkName: "tests" });
    expect(ended).not.toHaveProperty("exitCode");
    expect(
      summarizeRunQA({
        sessionId,
        runId: run.id,
        changedPaths: [],
        requiredChecks: ["tests"],
        events: evidence,
      }),
    ).toMatchObject({ required: true, status: "unavailable" });
  });

  it("keeps a started call without an end as incomplete exact-run evidence", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "run checks" });
    recordAgentEvent({
      type: "tool.started",
      sessionId,
      runId: run.id,
      toolCallId: "incomplete-check",
      toolName: "terminal_run",
      args: { command: "npm test" },
    } as never);
    expect(getRunToolEvidence(sessionId, run.id)).toHaveLength(1);
  });

  it("backfills persisted user prompts for older sessions without user message events", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({
      sessionId,
      prompt: "介绍一下你自己",
      userMessageId: "local-user-1",
    });
    recordAgentEvent({
      type: "run.started",
      sessionId,
      runId: run.id,
      userMessageId: "local-user-1",
      delivery: "normal",
    });
    recordAgentEvent({
      type: "message.started",
      sessionId,
      messageId: "assistant-1",
      role: "assistant",
    });
    recordAgentEvent({
      type: "message.delta",
      sessionId,
      messageId: "assistant-1",
      delta: "你好",
    });
    recordAgentEvent({ type: "run.completed", sessionId, runId: run.id });

    const events = listAgentEvents(sessionId);

    expect(events.map(({ event }) => event.type)).toContain("message.delta");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: {
            type: "message.delta",
            sessionId,
            messageId: "local-user-1",
            delta: "介绍一下你自己",
          },
        }),
      ]),
    );
  });
});
