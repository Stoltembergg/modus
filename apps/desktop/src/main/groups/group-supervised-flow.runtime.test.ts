import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GroupRuntimeEvent } from "../../shared/contracts";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase } = await import("../db/database");
const { ensureChatsWorkspace } = await import("../workspace/workspace-store");
const { updateAgent } = await import("../agents/agents-store");
const { createAgentGroupWithMembers, listAgentGroupMembers, listGroupMessages, listGroupTasks } =
  await import("./group-store");
const { createGroupTask } = await import("./group-task-store");
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
  effectiveTools = new Map<string, string[]>();
  toolProfileQueries: Array<{ sessionId: string; profile: string }> = [];
  getActiveToolNames(sessionId: string, profile: string): string[] | undefined {
    this.toolProfileQueries.push({ sessionId, profile });
    return this.effectiveTools.get(sessionId);
  }
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

function setup(options: { maxConcurrentTurns?: number } = {}) {
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
    ...options,
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
  for (const member of listAgentGroupMembers(group.id)) {
    const capabilityIds =
      member.sessionId === planner
        ? ["plan"]
        : member.sessionId === builder
          ? ["implement", "verify", "docs"]
          : ["review", "verify"];
    updateAgent(member.agentId, {
      capabilityIds,
      supportedTaskKinds: ["code", "docs", "design", "review"],
    });
  }
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
  it("does not launch a supervised pipeline from free text keywords or length", () => {
    for (const body of [
      "Implement code fixes with tests",
      "Update README documentation",
      "implemente a correção".repeat(100),
    ]) {
      const { group, planner } = crew();
      const { runtime, groups } = setup();
      groups.postUserMessage({ groupId: group.id, body });
      expect(runtime.pendingSessions()).toEqual([planner]);
      expect(runtime.calls[0]?.input.message).not.toContain("<supervised_flow>");
    }
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
      expect(runtime.calls[0]?.input.message).not.toContain("<supervised_flow>");

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
      if (!task) throw new Error("The handoff did not create the Login feature task.");
      expect(task).toMatchObject({ status: "in_progress", ownerSessionId: builder });
      runGroupTool(
        "group_request_review",
        { sessionId: builder, groupId: group.id },
        { id: task.id, reviewer },
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

  it("shows typed assignment guidance to the Lead after task metadata is recorded", async () => {
    const { group, planner, builder, reviewer } = crew();
    const { runtime, groups } = setup({ maxConcurrentTurns: 1 });
    try {
      groups.postUserMessage({ groupId: group.id, body: "@Reviewer hold this turn" });
      expect(runtime.started).toEqual([reviewer]);
      const intake = groups.postUserMessage({ groupId: group.id, body: "@Planner coordinate" });
      if (!intake.chainId) throw new Error("The Lead intake did not start an execution.");

      const task = createGroupTask({
        groupId: group.id,
        title: "Login feature",
        description: "Implement the login feature with tests",
        createdBySessionId: planner,
        executionId: intake.chainId,
        kind: "code",
        stage: "implement",
        priority: "high",
        dependencyIds: [],
        criteria: [{ id: "tests", description: "Tests pass", requiredCheckKinds: ["tests"] }],
        verificationPolicy: { mode: "required", requireReview: true },
        reviewerSessionId: reviewer,
        ownerSessionId: builder,
      });
      createGroupTask({
        groupId: group.id,
        title: "Review login",
        description: "Review the typed implementation",
        createdBySessionId: planner,
        executionId: intake.chainId,
        kind: "code",
        stage: "review",
        priority: "normal",
        dependencyIds: [],
        criteria: [
          { id: "review", description: "Review the implementation", requiredCheckKinds: [] },
        ],
        verificationPolicy: { mode: "required", requireReview: true },
        reviewerSessionId: reviewer,
        ownerSessionId: builder,
      });

      runtime.take(reviewer).resolve({ outcome: "ok", finalText: "Done holding." });
      await flush();
      const leadPrompt = runtime.calls.find((call) => call.input.sessionId === planner)?.input
        .message;
      const leadSnapshot =
        leadPrompt?.match(/<group_snapshot>[\s\S]*?<\/group_snapshot>/)?.[0] ?? "";
      const leadFlow = leadPrompt?.match(/<supervised_flow>[\s\S]*?<\/supervised_flow>/)?.[0] ?? "";
      expect(leadFlow).toContain(`Typed task: ${task.id}; kind: code`);
      expect(leadFlow).toContain("implement: RUN");
      expect(leadFlow).toContain(`group_assign_task(taskId=${task.id}, memberId=${builder})`);
      expect(leadFlow).not.toContain(`group_assign_task(taskId=${task.id}, memberId=${planner})`);
      expect(leadFlow).not.toContain("group_request_review");
      expect(leadSnapshot).toContain("stage=review");
      expect(leadSnapshot).not.toContain("group_request_review");
    } finally {
      await runtime.abort(planner);
    }
  });

  it("keeps typed owner and reviewer prompts contextual without self delegation", async () => {
    const { group, planner, builder, reviewer } = crew();
    const { runtime, groups } = setup();
    setGroupTaskWakeSink((wake) => groups.handleTaskWake(wake));
    try {
      const lead = { sessionId: planner, groupId: group.id };
      const intake = groups.postUserMessage({
        groupId: group.id,
        body: "Implement the login feature with tests",
      });
      const executionId = intake.chainId;
      if (!executionId) throw new Error("The intake message did not start an execution.");
      expect(runtime.pendingSessions()).toEqual([planner]);
      expect(runtime.calls[0]?.input.message).not.toContain("<supervised_flow>");

      const task = createGroupTask({
        groupId: group.id,
        title: "Login feature",
        description: "Implement the login feature with tests",
        createdBySessionId: planner,
        executionId,
        kind: "code",
        stage: "implement",
        priority: "high",
        dependencyIds: [],
        criteria: [{ id: "tests", description: "Tests pass", requiredCheckKinds: ["tests"] }],
        verificationPolicy: { mode: "required", requireReview: true },
        reviewerSessionId: reviewer,
      });
      runGroupTool("group_assign_task", lead, {
        taskId: task.id,
        memberId: builder,
        operationId: "typed-task-assign",
      });
      expect(runtime.pendingSessions()).toEqual([planner, builder]);
      expect(
        runtime.calls.find((call) => call.input.sessionId === planner)?.input.message,
      ).not.toContain("<supervised_flow>");
      const assignedPrompt =
        runtime.calls.find((call) => call.input.sessionId === builder)?.input.message ?? "";
      const ownerFlow =
        assignedPrompt.match(/<supervised_flow>[\s\S]*?<\/supervised_flow>/)?.[0] ?? "";
      expect(ownerFlow).toContain(`Typed task: ${task.id}; kind: code`);
      expect(ownerFlow).toContain("criterion-unverified");
      expect(ownerFlow).toContain("implement: RUN");
      expect(ownerFlow).toContain("review: BLOCKED");
      expect(ownerFlow).not.toContain("group_assign_task");
      expect(ownerFlow).not.toContain("group_request_review");

      runtime.take(planner).resolve({ outcome: "ok", finalText: "Plan ready." });
      await flush();
      expect(runtime.pendingSessions()).toEqual([builder]);

      runGroupTool(
        "group_request_review",
        { sessionId: builder, groupId: group.id },
        { id: task.id, reviewer, operationId: "typed-task-review" },
      );
      expect(runtime.pendingSessions()).toEqual([builder, reviewer]);
      const reviewPrompt =
        runtime.calls.find((call) => call.input.sessionId === reviewer)?.input.message ?? "";
      const reviewerFlow =
        reviewPrompt.match(/<supervised_flow>[\s\S]*?<\/supervised_flow>/)?.[0] ?? "";
      expect(reviewerFlow).toContain(`Typed task: ${task.id}; kind: code`);
      expect(reviewerFlow).toContain("review: RUN");
      expect(reviewerFlow).toContain("criterion-unverified");
      expect(reviewerFlow).not.toContain("group_request_review");

      runtime.take(builder).resolve({ outcome: "ok", finalText: "Implementation ready." });
      await flush();
      expect(runtime.pendingSessions()).toEqual([reviewer]);
    } finally {
      setGroupTaskWakeSink(undefined);
    }
  });

  it("revalidates the effective active tool set immediately before a queued typed prompt", async () => {
    const { group, planner, builder, reviewer } = crew();
    const { runtime, groups } = setup({ maxConcurrentTurns: 1 });
    runtime.effectiveTools.set(builder, ["read", "edit", "write"]);
    setGroupTaskWakeSink((wake) => groups.handleTaskWake(wake));
    try {
      const intake = groups.postUserMessage({ groupId: group.id, body: "@Planner assign work" });
      if (!intake.chainId) throw new Error("The Lead intake did not start an execution.");
      const task = createGroupTask({
        groupId: group.id,
        title: "Login feature",
        description: "Implement the login feature with tests",
        createdBySessionId: planner,
        executionId: intake.chainId,
        kind: "code",
        stage: "implement",
        priority: "normal",
        dependencyIds: [],
        criteria: [{ id: "tests", description: "Tests pass", requiredCheckKinds: ["tests"] }],
        verificationPolicy: { mode: "required", requireReview: true },
        reviewerSessionId: reviewer,
      });
      runGroupTool(
        "group_assign_task",
        { sessionId: planner, groupId: group.id },
        {
          taskId: task.id,
          memberId: builder,
          operationId: "active-tools-revalidation",
        },
      );
      expect(runtime.started).toEqual([planner]);
      expect(runtime.toolProfileQueries).toContainEqual({ sessionId: builder, profile: "chat" });

      runtime.effectiveTools.set(builder, ["read"]);
      runtime.take(planner).resolve({ outcome: "ok", finalText: "Assignment queued." });
      await flush();

      expect(runtime.started).toEqual([planner]);
      expect(runtime.calls.map((call) => call.input.sessionId)).not.toContain(builder);
      expect(
        runtime.toolProfileQueries.filter((query) => query.sessionId === builder),
      ).toHaveLength(3);
    } finally {
      setGroupTaskWakeSink(undefined);
    }
  });
});
