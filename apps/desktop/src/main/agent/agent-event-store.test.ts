import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";

let userData: string;

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
  },
}));

const { getDatabase } = await import("../db/database");
const { createAgentRun } = await import("./agent-run-store");
const { getLatestTodoContinuationAttempt, getRunToolEvidence, listAgentEvents, recordAgentEvent } =
  await import("./agent-event-store");
const { getSessionCodeGraphDiscoveries } = await import("./agent-event-store");
const { getWorkspaceHarnessInsightEvidence } = await import("./agent-event-store");
const { recognizeCheckInvocation } = await import("./harness/qa-evidence");

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
  userData = await mkdtemp(join(tmpdir(), "modus-event-store-test-"));
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
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
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
      ["bash", "npm test", "tests"],
      ["terminal_run", "npm run typecheck", "typecheck"],
      ["terminal_run", "npx vitest run", "tests"],
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
      "tests",
      "typecheck",
      "tests",
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

  it("accepts a completed recognized bash check without explicit exit code but keeps unknown tools unavailable", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId);
    const run = createAgentRun({ sessionId, prompt: "run test checks" });
    recordAgentEvent({
      type: "tool.started",
      sessionId,
      runId: run.id,
      toolCallId: "bash-check",
      toolName: "bash",
      args: { command: "npm test" },
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

    expect(ended).toMatchObject({ type: "tool.ended", checkName: "tests", exitCode: 0 });
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
