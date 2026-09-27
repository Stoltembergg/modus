import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";
import { reduceHarnessInsights } from "./harness-insights-service";

const { userDataPath } = vi.hoisted(() => ({ userDataPath: { current: "" } }));

vi.mock("electron", () => ({ app: { getPath: () => userDataPath.current } }));

let root: string;
let db: import("node:sqlite").DatabaseSync;
let getHarnessInsights: typeof import("./harness-insights-service").getHarnessInsights;
let recordAgentEvent: typeof import("../agent-event-store").recordAgentEvent;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "modus-harness-insights-"));
  userDataPath.current = join(root, "userData");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(userDataPath.current, { recursive: true });
  const { getDatabase } = await import("../../db/database");
  db = getDatabase();
  ({ getHarnessInsights } = await import("./harness-insights-service"));
  ({ recordAgentEvent } = await import("../agent-event-store"));
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const period = {
  since: "2026-01-01T00:00:00.000Z",
  until: "2026-01-31T00:00:00.000Z",
};

function run(runId: string, status: "completed" | "failed" = "completed") {
  return {
    runId,
    sessionId: `session-${runId}`,
    status,
    startedAt: `2026-01-${String(Number(runId.slice(-1)) + 1).padStart(2, "0")}T00:00:00.000Z`,
    completedAt: "2026-01-20T00:00:00.000Z",
  };
}

function route(runId: string, taskType = "implementation", selectedRole?: string) {
  return {
    eventId: `route-${runId}`,
    sessionId: `session-${runId}`,
    runId,
    type: "harness.route",
    createdAt: "2026-01-10T00:00:00.000Z",
    taskType,
    ...(selectedRole ? { selectedRole } : {}),
  };
}

const reduce = (runs: unknown[], events: unknown[]) =>
  reduceHarnessInsights({
    workspaceId: "workspace-a",
    ...period,
    runs,
    events,
  } as never);

describe("reduceHarnessInsights", () => {
  it("returns unknown with no recommendations below three comparable episodes", () => {
    const result = reduce([run("run-1"), run("run-2")], [route("run-1"), route("run-2")]);

    expect(result).toMatchObject({ evidenceState: "unknown", sampleCount: 2, insights: [] });
  });

  it("hypothesizes repeated failures and retry loops from run/check metadata", () => {
    const runs = [run("run-1", "failed"), run("run-2", "failed"), run("run-3")];
    const events = [
      ...runs.map((episode) => route(episode.runId)),
      {
        eventId: "failed-1",
        sessionId: "session-run-1",
        runId: "run-1",
        type: "run.failed",
        createdAt: period.until,
      },
      {
        eventId: "retry-1",
        sessionId: "session-run-1",
        runId: "run-1",
        type: "harness.continuation",
        createdAt: period.until,
        attempt: 1,
        reasonCode: "missing_qa",
      },
      {
        eventId: "failed-2",
        sessionId: "session-run-2",
        runId: "run-2",
        type: "run.failed",
        createdAt: period.until,
      },
    ];

    const result = reduce(runs, events);
    const insight = result.insights.find((item) => item.kind === "repeated_failures");

    expect(result.evidenceState).toBe("known");
    expect(insight).toMatchObject({
      sampleCount: 3,
      confidence: expect.any(String),
      limitations: expect.any(Array),
      sourceRefs: expect.arrayContaining([
        expect.objectContaining({ runId: "run-1", eventId: "failed-1" }),
      ]),
    });
  });

  it("hypothesizes repeated same-path rework and rollback from structured paths", () => {
    const runs = [run("run-1"), run("run-2"), run("run-3")];
    const events = [
      ...runs.map((episode) => route(episode.runId)),
      {
        eventId: "change-1",
        sessionId: "session-run-1",
        runId: "run-1",
        type: "run.completed",
        createdAt: period.until,
        changedPaths: ["src/reworked.ts"],
      },
      {
        eventId: "change-2",
        sessionId: "session-run-2",
        runId: "run-2",
        type: "run.completed",
        createdAt: period.until,
        changedPaths: ["src/reworked.ts"],
      },
      {
        eventId: "rollback-2",
        sessionId: "session-run-2",
        runId: "run-2",
        type: "checkpoint.restored",
        createdAt: period.until,
      },
    ];

    const insight = reduce(runs, events).insights.find((item) => item.kind === "same_path_rework");

    expect(insight).toMatchObject({ sampleCount: 3 });
    expect(insight?.claim).toMatch(/same path/i);
    expect(insight?.claim).not.toContain("src/reworked.ts");
    expect(insight?.sourceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventId: "change-1" }),
        expect.objectContaining({ eventId: "change-2" }),
      ]),
    );
  });

  it("does not disclose repeated changed paths in insight output", () => {
    const runs = [run("run-1"), run("run-2"), run("run-3")];
    const secretPath = "src/token=SECRET_VALUE.ts";
    const events = [
      ...runs.map((episode) => route(episode.runId)),
      ...runs.slice(0, 2).map((episode, index) => ({
        eventId: `secret-change-${index}`,
        sessionId: episode.sessionId,
        runId: episode.runId,
        type: "run.completed",
        createdAt: period.until,
        changedPaths: [secretPath],
      })),
    ];

    const result = reduce(runs, events);
    const serialized = JSON.stringify(result);

    expect(result.insights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "same_path_rework",
          claim: expect.stringMatching(/same path/i),
          sourceRefs: expect.arrayContaining([
            expect.objectContaining({ eventId: "secret-change-0" }),
            expect.objectContaining({ eventId: "secret-change-1" }),
          ]),
        }),
      ]),
    );
    expect(serialized).not.toContain(secretPath);
    expect(serialized).not.toContain("SECRET_VALUE");
  });

  it("excludes control-character paths from repeated-path matching", () => {
    const runs = [run("run-1"), run("run-2"), run("run-3")];
    const events = [
      ...runs.map((episode) => route(episode.runId)),
      ...runs.slice(0, 2).map((episode, index) => ({
        eventId: `control-change-${index}`,
        sessionId: episode.sessionId,
        runId: episode.runId,
        type: "run.completed",
        createdAt: period.until,
        changedPaths: ["src/private\u0001name.ts"],
      })),
    ];

    const result = reduce(runs, events);

    expect(result.insights).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "same_path_rework" })]),
    );
  });

  it("reports context pressure only as a structured usage proxy", () => {
    const runs = [run("run-1"), run("run-2"), run("run-3")];
    const events = [
      ...runs.map((episode) => route(episode.runId)),
      ...runs.map((episode, index) => ({
        eventId: `context-${index}`,
        sessionId: episode.sessionId,
        runId: episode.runId,
        type: "context.updated",
        createdAt: period.until,
        contextPercent: 92,
        contextTokens: 92_000,
        contextWindow: 100_000,
      })),
    ];

    const insight = reduce(runs, events).insights.find((item) => item.kind === "context_pressure");

    expect(insight).toMatchObject({ sampleCount: 3 });
    expect(insight?.claim).toMatch(/proxy/i);
  });

  it("hypothesizes delegation mismatch and missing verification from structured outcomes", () => {
    const runs = [run("run-1"), run("run-2"), run("run-3")];
    const events = runs.flatMap((episode) => [
      route(episode.runId, "librarian", "explore"),
      {
        eventId: `qa-${episode.runId}`,
        sessionId: episode.sessionId,
        runId: episode.runId,
        type: "harness.qa",
        createdAt: period.until,
        qaRequired: true,
        qaStatus: "missing",
      },
    ]);
    const result = reduce(runs, events);

    expect(result.insights.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["delegation_mismatch", "missing_verification"]),
    );
  });

  it("does not leak arbitrary event prose into hypotheses or source refs", () => {
    const runs = [run("run-1", "failed"), run("run-2", "failed"), run("run-3")];
    const secretText = "PRIVATE_PROMPT_AND_ERROR_BODY";
    const events = [
      ...runs.map((episode) => route(episode.runId)),
      {
        eventId: "failed-1",
        sessionId: "session-run-1",
        runId: "run-1",
        type: "run.failed",
        createdAt: period.until,
        message: secretText,
        command: secretText,
        output: secretText,
      },
      {
        eventId: "failed-2",
        sessionId: "session-run-2",
        runId: "run-2",
        type: "run.failed",
        createdAt: period.until,
        message: secretText,
      },
    ];

    const serialized = JSON.stringify(reduce(runs, events));
    expect(serialized).not.toContain(secretText);
    expect(serialized).toMatch(/failed-1/);
  });
});

describe("getHarnessInsights", () => {
  it("rejects Chats evidence even when the workspace and activity exist", () => {
    const now = new Date().toISOString();
    const sessionId = `session-${crypto.randomUUID()}`;
    db.prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, ?, 0, ?, ?)`,
    ).run(CHATS_WORKSPACE_ID, `/chats-${crypto.randomUUID()}`, "Chats", now, now);
    db.prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
       values (?, ?, ?, ?, 'idle', ?, ?)`,
    ).run(sessionId, CHATS_WORKSPACE_ID, "Chats session", "/chats", now, now);

    for (let index = 0; index < 3; index += 1) {
      const runId = `chats-run-${crypto.randomUUID()}`;
      db.prepare(
        `insert into agent_runs (id, session_id, prompt, status, started_at, completed_at)
         values (?, ?, ?, 'failed', ?, ?)`,
      ).run(runId, sessionId, "private chat prompt", now, now);
      recordAgentEvent({
        type: "harness.route",
        sessionId,
        runId,
        taskType: "implementation",
        reasonCodes: [],
      });
      recordAgentEvent({ type: "run.failed", sessionId, runId, message: "private chat failure" });
    }

    const result = getHarnessInsights({
      workspaceId: CHATS_WORKSPACE_ID,
      since: "2000-01-01T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      workspaceId: CHATS_WORKSPACE_ID,
      evidenceState: "unknown",
      sampleCount: 0,
      insights: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/chats-run|private chat|implementation/);
  });

  it("still returns insights for an ordinary workspace", () => {
    const now = new Date().toISOString();
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    const sessionId = `session-${crypto.randomUUID()}`;
    db.prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, ?, 0, ?, ?)`,
    ).run(workspaceId, `/workspace-${crypto.randomUUID()}`, "Workspace", now, now);
    db.prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
       values (?, ?, ?, ?, 'idle', ?, ?)`,
    ).run(sessionId, workspaceId, "Workspace session", "/workspace", now, now);

    for (let index = 0; index < 3; index += 1) {
      const runId = `workspace-run-${crypto.randomUUID()}`;
      db.prepare(
        `insert into agent_runs (id, session_id, prompt, status, started_at, completed_at)
         values (?, ?, ?, 'failed', ?, ?)`,
      ).run(runId, sessionId, "private prompt", now, now);
      recordAgentEvent({
        type: "harness.route",
        sessionId,
        runId,
        taskType: "implementation",
        reasonCodes: [],
      });
      recordAgentEvent({ type: "run.failed", sessionId, runId, message: "private failure" });
    }

    const result = getHarnessInsights({ workspaceId, since: "2000-01-01T00:00:00.000Z" });

    expect(result.evidenceState).toBe("known");
    expect(result.insights).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "repeated_failures" })]),
    );
  });
});
