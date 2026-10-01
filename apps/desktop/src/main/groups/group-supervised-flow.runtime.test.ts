import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GroupRuntimeEvent } from "../../shared/contracts";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase } = await import("../db/database");
const { ensureChatsWorkspace } = await import("../workspace/workspace-store");
const { claimGroupTask, createAgentGroupWithMembers, listGroupMessages, listGroupTasks } =
  await import("./group-store");
const { GROUP_CHAIN_LIMITS, GroupRuntime } = await import("./group-runtime");
const { runGroupTool, setGroupTaskWakeSink } = await import("../agent/tools/group-tools");

type PromptTurnResult = import("../agent/runtime").PromptTurnResult;
type TurnSettledEvent = import("../agent/runtime").TurnSettledEvent;
type PromptAgentInput = import("../agent/runtime").PromptAgentInput;

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function insertWorkspace(): string {
  const id = uid("ws");
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `root-${id}`, "repo", 1, now, now);
  return id;
}

function insertSession(workspaceId: string, title: string): string {
  const id = uid("s");
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, workspaceId, title, `root-${workspaceId}`, "idle", now, now);
  return id;
}

type Call = {
  input: PromptAgentInput;
  resolve(result: PromptTurnResult): void;
  reject(error: unknown): void;
};

class FakeAgentRuntime {
  calls: Call[] = [];
  started: string[] = [];
  streaming = new Set<string>();
  async abort(sessionId: string): Promise<void> {
    const index = this.calls.findIndex((call) => call.input.sessionId === sessionId);
    if (index < 0) return;
    const [call] = this.calls.splice(index, 1);
    call?.resolve({ outcome: "aborted" });
  }
  prompt(_window: unknown, input: PromptAgentInput): Promise<PromptTurnResult> {
    this.started.push(input.sessionId);
    return new Promise((resolve, reject) => this.calls.push({ input, resolve, reject }));
  }
  isSessionStreaming(sessionId: string): boolean {
    return this.streaming.has(sessionId);
  }
  settledListeners = new Set<(event: TurnSettledEvent) => void>();
  questionListeners = new Set<(sessionId: string) => void>();
  onTurnSettled(listener: (event: TurnSettledEvent) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }
  onQuestionPending(listener: (sessionId: string) => void): () => void {
    this.questionListeners.add(listener);
    return () => this.questionListeners.delete(listener);
  }
  take(sessionId: string): Call {
    const index = this.calls.findIndex((call) => call.input.sessionId === sessionId);
    if (index < 0) throw new Error(`no pending prompt for ${sessionId}`);
    const [call] = this.calls.splice(index, 1);
    return call as Call;
  }
  pendingSessions(): string[] {
    return this.calls.map((call) => call.input.sessionId);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const created: InstanceType<typeof GroupRuntime>[] = [];

function setup() {
  const runtime = new FakeAgentRuntime();
  const events: GroupRuntimeEvent[] = [];
  const groups = new GroupRuntime({
    runtime,
    host: {
      getWindow: () => ({}) as never,
      isUpdatePending: () => false,
      emit: (event) => events.push(event),
    },
    retryDelayMs: 5,
    limits: GROUP_CHAIN_LIMITS,
  });
  created.push(groups);
  return { runtime, groups, events };
}

function crew() {
  const ws = insertWorkspace();
  const planner = insertSession(ws, "Planner");
  const builder = insertSession(ws, "Builder");
  const reviewer = insertSession(ws, "Reviewer");
  const group = createAgentGroupWithMembers({
    name: "Crew",
    mode: "coordinator",
    workspaceId: ws,
    members: [
      { sessionId: planner, role: "Lead" },
      { sessionId: builder, role: "Builder" },
      { sessionId: reviewer, role: "Reviewer" },
    ],
    leadSessionId: planner,
  });
  return { group, planner, builder, reviewer };
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-supervised-flow-runtime-"));
  ensureChatsWorkspace();
});

afterEach(() => {
  for (const runtime of created.splice(0)) runtime.dispose();
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("supervised code flow (runtime)", () => {
  it("injects the supervised plan into the Lead wake for code work", () => {
    const { group, planner, builder, reviewer } = crew();
    const { runtime, groups } = setup();
    groups.postUserMessage({
      groupId: group.id,
      body: "Implement workspace symlink escape fixes with tests",
    });
    expect(runtime.pendingSessions()).toEqual([planner]);
    const prompt = runtime.calls[0]?.input.message ?? "";
    expect(prompt).toContain("<supervised_flow>");
    expect(prompt).toContain("Ask kind: code");
    expect(prompt).toContain("implement: RUN");
    expect(prompt).toContain("review: RUN");
    expect(prompt).toContain(`memberId=${builder}`);
    expect(prompt).toContain(`memberId=${reviewer}`);
    expect(prompt).toContain("group_handoff");
    expect(prompt).toContain("group_request_review");
  });

  it("skips Reviewer in the Lead prompt for docs-only asks", () => {
    const { group, planner, builder, reviewer } = crew();
    const { runtime, groups } = setup();
    groups.postUserMessage({
      groupId: group.id,
      body: "Update the README documentation for Groups setup",
    });
    expect(runtime.pendingSessions()).toEqual([planner]);
    const prompt = runtime.calls[0]?.input.message ?? "";
    expect(prompt).toContain("<supervised_flow>");
    expect(prompt).toContain("Ask kind: docs");
    expect(prompt).toContain("review: SKIP");
    expect(prompt).toContain(`memberId=${builder}`);
    expect(prompt).not.toContain(`memberId=${reviewer}`);
  });

  it("does not inject supervised flow for social pings", () => {
    const { group, planner } = crew();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "hi team" });
    expect(runtime.pendingSessions()).toEqual([planner]);
    expect(runtime.calls[0]?.input.message).not.toContain("<supervised_flow>");
  });

  it("Lead group_handoff / group_request_review wake Builder then Reviewer", async () => {
    const { group, planner, builder, reviewer } = crew();
    const { runtime, groups } = setup();
    setGroupTaskWakeSink((wake) => groups.handleTaskWake(wake));
    try {
      const lead = { sessionId: planner, groupId: group.id };
      groups.postUserMessage({
        groupId: group.id,
        body: "Implement the login feature with tests",
      });
      expect(runtime.pendingSessions()).toEqual([planner]);
      expect(runtime.calls[0]?.input.message).toContain("group_handoff");

      runGroupTool("group_handoff", lead, {
        memberId: builder,
        objective: "Implement the agreed plan in a worktree with tests.",
        taskTitle: "Login feature",
      });
      expect(runtime.pendingSessions()).toEqual([planner, builder]);

      runtime.take(planner).resolve({
        outcome: "ok",
        finalText: "Plan ready — Builder owns implementation.",
      });
      await flush();
      expect(runtime.pendingSessions()).toEqual([builder]);

      const task = listGroupTasks(group.id).find((row) => row.title === "Login feature");
      expect(task).toBeDefined();
      claimGroupTask(group.id, task!.id, builder);
      runGroupTool(
        "group_request_review",
        { sessionId: builder, groupId: group.id },
        { id: task!.id, reviewer },
      );
      expect(runtime.pendingSessions()).toEqual([builder, reviewer]);
      runtime
        .take(builder)
        .resolve({ outcome: "ok", finalText: "Implementation ready for review." });
      await flush();
      expect(runtime.pendingSessions()).toContain(reviewer);
      expect(
        listGroupMessages(group.id, { limit: 50 }).some((m) => m.authorSessionId === builder),
      ).toBe(true);
    } finally {
      setGroupTaskWakeSink(undefined);
    }
  });
});
