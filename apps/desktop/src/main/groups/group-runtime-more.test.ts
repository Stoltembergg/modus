import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GroupRuntimeEvent } from "../../shared/contracts";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase } = await import("../db/database");
const { ensureChatsWorkspace } = await import("../workspace/workspace-store");
const { createAgent, createAgentInGroup, createGroupWithNewAgents, setAgentArchived, updateAgent } =
  await import("../agents/agents-store");
const {
  createAgentGroupWithAgents,
  createAgentGroupWithMembers,
  removeAgentFromGroup,
  listGroupMessages,
  createMemberGroupTask,
  recordGroupDecision,
  removeAgentGroupMember,
  setAgentGroupLead,
  setAgentGroupMode,
} = await import("./group-store");
const {
  ESTIMATED_CONTEXT_TOKENS_PER_WAKE,
  ESTIMATED_INPUT_TOKENS_PER_CHAIN,
  GROUP_CHAIN_LIMITS,
  GROUP_MAX_CONCURRENT_TURNS,
  GROUP_ROSTER_DESCRIPTION_MAX_CHARS,
  agentDescription,
  GROUP_PROMPT_DECISIONS_MAX_ITEMS,
  GROUP_PROMPT_DECISIONS_MAX_TOKENS,
  GROUP_PROMPT_SNAPSHOT_MAX_TOKENS,
  GROUP_STATUS_TEXT,
  GroupRuntime,
  composeGroupDecisionsSection,
  composeGroupSnapshotSection,
  composeGroupWakePrompt,
  estimateGroupTokens,
  isUpdatePendingState,
  parseGroupMentions,
} = await import("./group-runtime");
const { insertLegacyGroup } = await import("./legacy-group.fixture");
type PromptTurnResult = import("../agent/runtime").PromptTurnResult;
type TurnSettledEvent = import("../agent/runtime").TurnSettledEvent;
type PromptAgentInput = import("../agent/runtime").PromptAgentInput;

/* ── fixtures ─────────────────────────────────────────────────────────── */

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

/** Group "Squad": Alpha (lead), Beta, Gamma. */
function squad() {
  const ws = insertWorkspace();
  const alpha = insertSession(ws, "Alpha");
  const beta = insertSession(ws, "Beta");
  const gamma = insertSession(ws, "Gamma");
  const group = createAgentGroupWithMembers({
    name: "Squad",
    workspaceId: ws,
    members: [{ sessionId: alpha }, { sessionId: beta }, { sessionId: gamma }],
    leadSessionId: alpha,
  });
  return { group, alpha, beta, gamma };
}

type Call = {
  input: PromptAgentInput;
  resolve(result: PromptTurnResult): void;
  reject(error: unknown): void;
};

/** Fake agent runtime following the PiSdkRuntime prompt contract. */
class FakeAgentRuntime {
  calls: Call[] = [];
  /** Every session ever prompted, in order. */
  started: string[] = [];
  streaming = new Set<string>();
  aborted: string[] = [];
  /** Like PiSdkRuntime.abort: the running turn settles as `aborted`. */
  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
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
  /** A turn settled that the group did not start (e.g. a HyperPlan build). */
  settle(event: TurnSettledEvent): void {
    for (const listener of this.settledListeners) listener(event);
  }
  /** The intent gate opens its question on a session (its prompt stays pending). */
  openGate(sessionId: string): void {
    for (const listener of this.questionListeners) listener(sessionId);
  }
  /** The oldest unsettled call for a session. */
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

function setup(
  options: {
    window?: boolean;
    updatePending?: boolean;
    limits?: Partial<Record<keyof typeof GROUP_CHAIN_LIMITS, number>>;
  } = {},
) {
  const runtime = new FakeAgentRuntime();
  const events: GroupRuntimeEvent[] = [];
  const state = { window: options.window ?? true, updatePending: options.updatePending ?? false };
  const groups = new GroupRuntime({
    runtime,
    host: {
      getWindow: () => (state.window ? ({} as never) : undefined),
      isUpdatePending: () => state.updatePending,
      emit: (event) => events.push(event),
    },
    retryDelayMs: 5,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  created.push(groups);
  return { runtime, groups, events, state };
}

const created: InstanceType<typeof GroupRuntime>[] = [];

function room(groupId: string) {
  return listGroupMessages(groupId, { limit: 200 });
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-group-runtime-test-"));
  ensureChatsWorkspace();
});

afterEach(() => {
  for (const runtime of created.splice(0)) runtime.dispose();
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

/* ── constants ────────────────────────────────────────────────────────── */

describe("dispose", () => {
  it("unsubscribes: a later ok plan-build or gate question does nothing", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups, events } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta go" });
    // Alpha ends with a HyperPlan choice pending; Beta's group turn keeps running.
    const { reserveHyperPlanSession } = await import("../agent/harness/hyperplan-draft-store");
    expect(reserveHyperPlanSession({ sessionId: alpha, ownerId: 1 })).toBe(true);
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();
    expect(groups.isAwaitingUser(alpha)).toBe(true);
    expect(runtime.settledListeners.size).toBe(1);
    expect(runtime.questionListeners.size).toBe(1);

    groups.dispose();
    expect(runtime.settledListeners.size).toBe(0);
    expect(runtime.questionListeners.size).toBe(0);

    const roomBefore = room(group.id);
    const eventCount = events.length;
    const snapshotBefore = groups.chainSnapshot(user.id);
    runtime.settle({
      sessionId: alpha,
      origin: "plan-build",
      result: { outcome: "ok", finalText: "Built. @Beta please verify" },
    });
    runtime.openGate(beta);
    await flush();

    expect(room(group.id)).toEqual(roomBefore);
    expect(events).toHaveLength(eventCount);
    expect(groups.isAwaitingUser(alpha)).toBe(true);
    expect(groups.chainSnapshot(user.id)).toEqual(snapshotBefore);
    expect(groups.liveChainIds()).toEqual([]);
    expect(runtime.pendingSessions()).toEqual([beta]);
    expect(runtime.started).toEqual([alpha, beta]);
  });
});

/* ── member task tools: review / changes wakes go through route ─────── */

describe("task tool wakes", () => {
  const review = (groupId: string, actor: string, target: string) => ({
    groupId,
    actorSessionId: actor,
    targetSessionId: target,
    body: `Review requested: "Parser" (task t1) @${target}`,
  });

  it("inside a group turn: joins its chain, posts a task status and counts the hop", () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "build the parser" });
    expect(runtime.pendingSessions()).toEqual([alpha]);
    const status = groups.handleTaskWake(review(group.id, alpha, beta));
    expect(status).toMatchObject({
      authorKind: "agent",
      authorSessionId: alpha,
      kind: "status",
      mentions: [beta],
      chainId: user.id,
    });
    expect(runtime.pendingSessions()).toEqual([alpha, beta]);
    expect(runtime.calls[1]?.input.message).toContain("Review requested");
    expect(groups.chainSnapshot(user.id)).toMatchObject({
      hops: 2,
      agentMessages: 0,
      wakesByMember: { [alpha]: 1, [beta]: 1 },
    });
  });

  it("respects the hop limit", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup({ limits: { maxHops: 1 } });
    const user = groups.postUserMessage({ groupId: group.id, body: "go" });
    groups.handleTaskWake(review(group.id, alpha, beta));
    expect(runtime.pendingSessions()).toEqual([alpha]);
    expect(groups.chainSnapshot(user.id)).toMatchObject({ hops: 1, ended: "max-hops" });
    expect(room(group.id).at(-1)?.body).toBe(GROUP_STATUS_TEXT.limit["max-hops"]);
  });

  it("a changes wake of the owner respects the per-member wake limit", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup({ limits: { maxWakesPerMember: 1 } });
    const user = groups.postUserMessage({ groupId: group.id, body: "go" });
    // Alpha (woken once) asks Beta to review, then finishes.
    groups.handleTaskWake(review(group.id, alpha, beta));
    runtime.take(alpha).resolve({ outcome: "ok" });
    await flush();
    // Beta requests changes: waking Alpha a 2nd time exceeds the limit.
    groups.handleTaskWake({
      groupId: group.id,
      actorSessionId: beta,
      targetSessionId: alpha,
      body: `Changes requested on "Parser" (task t1) @Alpha`,
    });
    expect(runtime.pendingSessions()).toEqual([beta]);
    expect(groups.chainSnapshot(user.id)).toMatchObject({
      hops: 2,
      ended: "max-member-wakes",
      wakesByMember: { [alpha]: 1, [beta]: 1 },
    });
  });

  it("outside a chain (the member working in its own chat) opens a new chain", () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    const status = groups.handleTaskWake(review(group.id, alpha, beta));
    expect(status?.chainId).toBe(status?.id);
    expect(runtime.pendingSessions()).toEqual([beta]);
    expect(groups.chainSnapshot(status?.id ?? "")).toMatchObject({
      hops: 1,
      wakesByMember: { [beta]: 1 },
    });
  });

  it("approve (wake: false) posts a status for the owner in the chain, with no wake and no hop", () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Beta review it" });
    expect(runtime.pendingSessions()).toEqual([beta]);
    const before = groups.chainSnapshot(user.id);
    const status = groups.handleTaskWake({
      groupId: group.id,
      actorSessionId: beta,
      targetSessionId: alpha,
      body: "Approved: ship it",
      wake: false,
    });
    expect(status).toMatchObject({
      authorKind: "agent",
      authorSessionId: beta,
      kind: "status",
      body: "Approved: ship it",
      mentions: [alpha],
      chainId: user.id,
    });
    expect(room(group.id).at(-1)?.id).toBe(status?.id);
    expect(runtime.pendingSessions()).toEqual([beta]);
    expect(runtime.started).toEqual([beta]);
    expect(groups.chainSnapshot(user.id)).toEqual(before);
  });

  it('a status without a target ("Decision: …") posts in the chain and wakes nobody', () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha decide" });
    const before = groups.chainSnapshot(user.id);
    const status = groups.handleTaskWake({
      groupId: group.id,
      actorSessionId: alpha,
      body: "Decision: Use SQLite",
      wake: false,
    });
    expect(status).toMatchObject({
      authorSessionId: alpha,
      kind: "status",
      body: "Decision: Use SQLite",
      mentions: [],
      chainId: user.id,
    });
    expect(runtime.started).toEqual([alpha]);
    expect(groups.chainSnapshot(user.id)).toEqual(before);
    // Even without wake: false, a status aimed at nobody routes nowhere.
    groups.handleTaskWake({ groupId: group.id, actorSessionId: alpha, body: "Decision: x" });
    expect(runtime.started).toEqual([alpha]);
    expect(groups.chainSnapshot(user.id)).toEqual(before);
  });

  it('approve outside a group turn posts "Approved" and opens no chain', () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    const status = groups.handleTaskWake({
      groupId: group.id,
      actorSessionId: beta,
      targetSessionId: alpha,
      body: "Approved",
      wake: false,
    });
    expect(status).toMatchObject({ body: "Approved", mentions: [alpha], kind: "status" });
    expect(status?.chainId).toBe(status?.id);
    expect(runtime.pendingSessions()).toEqual([]);
    expect(groups.liveChainIds()).toEqual([]);
    expect(() => groups.chainSnapshot(status?.id ?? "")).toThrow(/Unknown chain/);
  });

  it("a review request from a turn stopped at the intent gate persists the task but wakes nobody", async () => {
    const { runGroupTool, setGroupTaskWakeSink } = await import("../agent/tools/group-tools");
    const { createMemberGroupTask, claimGroupTask, listGroupTasks } = await import("./group-store");
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    setGroupTaskWakeSink((wake) => groups.handleTaskWake(wake));
    try {
      const task = createMemberGroupTask({ groupId: group.id, actorSessionId: alpha, title: "T" });
      claimGroupTask(group.id, task.id, alpha);
      const user = groups.postUserMessage({ groupId: group.id, body: "finish it" });
      runtime.openGate(alpha);
      expect(groups.chainSnapshot(user.id).ended).toBe("blocked");
      // The user answers Proceed; the gated turn goes on and requests a review.
      const text = runGroupTool(
        "group_request_review",
        { sessionId: alpha, groupId: group.id },
        { id: task.id, reviewer: "Beta" },
      );
      expect(text).toContain("Review requested from @Beta");
      expect(listGroupTasks(group.id)[0]).toMatchObject({
        status: "in_review",
        reviewerSessionId: beta,
      });
      expect(room(group.id).at(-1)).toMatchObject({
        kind: "status",
        authorSessionId: alpha,
        mentions: [beta],
        chainId: user.id,
      });
      expect(runtime.started).toEqual([alpha]);
      expect(groups.chainSnapshot(user.id).hops).toBe(1);
    } finally {
      setGroupTaskWakeSink(undefined);
    }
  });

  it("in an ended chain the status posts but wakes nobody", async () => {
    const { group, alpha, beta, gamma } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta go" });
    const { reserveHyperPlanSession } = await import("../agent/harness/hyperplan-draft-store");
    expect(reserveHyperPlanSession({ sessionId: beta, ownerId: 1 })).toBe(true);
    runtime.take(beta).resolve({ outcome: "blocked" });
    await flush();
    const status = groups.handleTaskWake(review(group.id, alpha, gamma));
    expect(status?.chainId).toBe(user.id);
    expect(runtime.pendingSessions()).toEqual([alpha]);
    expect(runtime.started).not.toContain(gamma);
  });
});

/* ── chain bookkeeping ───────────────────────────────────────────────── */

describe("chain cleanup", () => {
  it("drops a chain once it has no queued or running wake (ended or finished)", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    const first = groups.postUserMessage({ groupId: group.id, body: "go" });
    expect(groups.liveChainIds()).toEqual([first.id]);
    groups.handleTaskWake({ groupId: group.id, actorSessionId: alpha, targetSessionId: beta, body: "Review the result" });
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "@Beta you" });
    await flush();
    // Still live: Beta's wake runs in it.
    expect(groups.liveChainIds()).toEqual([first.id]);
    groups.handleTaskWake({ groupId: group.id, actorSessionId: beta, targetSessionId: alpha, body: "Address the review" });
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Done." });
    await flush();
    // The explicit return handoff keeps the chain live; the public reply adds no wake.
    expect(groups.liveChainIds()).toEqual([first.id]);
    expect(runtime.pendingSessions()).toEqual([alpha]);
    // No further task delegation; the final card completes and the chain retires.
    runtime.take(alpha).resolve({ outcome: "ok" });
    await flush();
    expect(groups.liveChainIds()).toEqual([]);
    // Counters stay readable for a while after retirement.
    expect(groups.chainSnapshot(first.id).hops).toBe(3);

    // An ended chain with a running turn stays until that turn settles.
    const second = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta go" });
    const { reserveHyperPlanSession } = await import("../agent/harness/hyperplan-draft-store");
    expect(reserveHyperPlanSession({ sessionId: alpha, ownerId: 1 })).toBe(true);
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();
    expect(groups.liveChainIds()).toEqual([second.id]);
    runtime.take(beta).resolve({ outcome: "ok" });
    await flush();
    expect(groups.liveChainIds()).toEqual([]);

    // A thread reply without @ wakes the replied-to author (N3) and keeps a chain.
    const leadStatus = room(group.id).findLast((m) => m.authorSessionId === alpha);
    groups.postUserMessage({
      groupId: group.id,
      body: "ok",
      replyToMessageId: leadStatus?.id ?? "",
    });
    expect(runtime.pendingSessions()).toEqual([alpha]);
    expect(groups.liveChainIds()).toHaveLength(1);
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "Noted." });
    await flush();
    expect(groups.liveChainIds()).toEqual([]);
  });
});

/* ── queue ───────────────────────────────────────────────────────────── */

describe("queue", () => {
  it(`runs at most ${GROUP_MAX_CONCURRENT_TURNS} members at once and one turn per member`, async () => {
    const { group, alpha, beta, gamma } = squad();
    const { runtime, groups, events } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta @Gamma go" });
    expect(runtime.pendingSessions()).toEqual([alpha, beta]);
    expect(events.filter((e) => e.type === "group.activity").at(-1)).toEqual({
      type: "group.activity",
      groupId: group.id,
      runningSessionIds: [alpha, beta],
      queuedSessionIds: [gamma],
      waitingSessionIds: [],
    });
    // A second wake for Alpha waits behind its running turn.
    groups.postUserMessage({ groupId: group.id, body: "@Alpha also this" });
    runtime.take(beta).resolve({ outcome: "ok" });
    await flush();
    expect(runtime.pendingSessions()).toEqual([alpha, gamma]);
    runtime.take(alpha).resolve({ outcome: "ok" });
    await flush();
    expect(runtime.pendingSessions()).toEqual([gamma, alpha]);
  });

  it("waits while the member is streaming (never steers into it)", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    runtime.streaming.add(alpha);
    groups.postUserMessage({ groupId: group.id, body: "go" });
    expect(runtime.pendingSessions()).toEqual([]);
    expect(groups.isGroupWorking(group.id)).toBe(true);
    runtime.streaming.delete(alpha);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.pendingSessions()).toEqual([alpha]);
  });

  it("waits with no window or while an update is pending, then drains", async () => {
    const { group, alpha } = squad();
    const { runtime, groups, state } = setup({ window: false, updatePending: true });
    groups.postUserMessage({ groupId: group.id, body: "go" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.pendingSessions()).toEqual([]);
    state.window = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.pendingSessions()).toEqual([]);
    state.updatePending = false;
    groups.kick();
    expect(runtime.pendingSessions()).toEqual([alpha]);
  });

  it("only waiting-for-agents and installing hold the queue; ready does not", () => {
    expect(isUpdatePendingState({ status: "waiting-for-agents", version: "2.0.0" })).toBe(true);
    expect(isUpdatePendingState({ status: "installing", version: "2.0.0" })).toBe(true);
    expect(isUpdatePendingState({ status: "ready", version: "2.0.0" })).toBe(false);
    expect(isUpdatePendingState({ status: "idle" })).toBe(false);
  });

  it("arms the retry timer only while wakes are queued, and clears it on dispose", async () => {
    const { group, alpha } = squad();
    const { runtime, groups, state } = setup({ window: false });
    expect(groups.hasPendingRetry()).toBe(false);
    groups.postUserMessage({ groupId: group.id, body: "go" });
    expect(groups.hasPendingRetry()).toBe(true);
    state.window = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Drained by the retry: the queue is empty, so no new timer.
    expect(runtime.pendingSessions()).toEqual([alpha]);
    expect(groups.hasPendingRetry()).toBe(false);

    state.window = false;
    groups.postUserMessage({ groupId: group.id, body: "@Beta also" });
    expect(groups.hasPendingRetry()).toBe(true);
    groups.dispose();
    expect(groups.hasPendingRetry()).toBe(false);
  });

  it("clears the retry timer when an ended chain empties the queue", () => {
    const { group, alpha, gamma } = squad();
    const { runtime, groups } = setup();
    runtime.streaming.add(gamma);
    groups.postUserMessage({ groupId: group.id, body: "@Alpha @Gamma go" });
    // Gamma waits for its own stream to end; the retry timer is armed.
    expect(runtime.pendingSessions()).toEqual([alpha]);
    expect(groups.hasPendingRetry()).toBe(true);
    runtime.openGate(alpha);
    expect(groups.hasPendingRetry()).toBe(false);
    expect(groups.isGroupWorking(group.id)).toBe(false);
  });

  it("drops the reply of a member removed while its turn ran", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "go" });
    const card = room(group.id)[1];
    removeAgentGroupMember(group.id, alpha);
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "late" });
    await flush();
    expect(room(group.id)).toHaveLength(2);
    expect(room(group.id)[1]).toMatchObject({ id: card?.id, body: "", status: "interrupted" });
    expect(runtime.pendingSessions()).toEqual([]);
    expect(groups.isGroupWorking(group.id)).toBe(false);
  });
});

describe("worktree re-wake (group_start_worktree)", () => {
  const ready = (groupId: string, sessionId: string) => ({
    groupId,
    sessionId,
    branch: `group/${groupId}/alpha`,
  });

  it("the turn ends ok, posts Worktree ready (no wake) and re-wakes the member with the same trigger", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "build the parser" });
    const originalCard = room(group.id)[1];
    const first = runtime.take(alpha);

    expect(groups.handleWorktreeReady(ready(group.id, alpha))).toBe(true);
    first.resolve({ outcome: "ok", finalText: "Starting my worktree." });
    await flush();

    const after = room(group.id).slice(1);
    expect(after).toHaveLength(3);
    expect(after[0]).toMatchObject({ id: originalCard?.id, body: "", status: "completed" });
    expect(after[1]).toMatchObject({
      authorKind: "agent",
      authorSessionId: alpha,
      kind: "status",
      body: `Worktree ready: \`group/${group.id}/alpha\``,
      chainId: user.id,
      mentions: [],
    });
    expect(after[2]).toMatchObject({ authorSessionId: alpha, kind: "message", body: "", status: "running", chainId: user.id });
    expect(after[2]?.turnId).not.toBe(originalCard?.turnId);
    expect(after.some((message) => message.body === GROUP_STATUS_TEXT.aborted)).toBe(false);
    // Same member, same chain, same trigger: the prompt is rebuilt from the user message.
    expect(runtime.pendingSessions()).toEqual([alpha]);
    expect(runtime.calls[0]?.input.message).toContain('<group_message from="user">\nbuild the parser');
    expect(runtime.calls[0]?.input.message).toContain("Worktree ready:");
    expect(groups.chainSnapshot(user.id)).toMatchObject({
      hops: 2,
      wakesByMember: { [alpha]: 2 },
    });
    // The re-woken turn completes its new card without implicit follow-ups.
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "Done in my worktree." });
    await flush();
    const afterReply = room(group.id);
    expect(afterReply.at(-1)).toMatchObject({
      id: after[2]?.id,
      authorSessionId: alpha,
      kind: "message",
      body: "Done in my worktree.",
      chainId: user.id,
      status: "completed",
    });
    expect(afterReply).toHaveLength(4);
    expect(afterReply.some((message) => message.body === "Starting my worktree.")).toBe(false);
    expect(runtime.pendingSessions()).toEqual([]);
  });

  it("at the hop limit nobody is woken (the chain ends with its limit status)", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup({ limits: { maxHops: 1 } });
    const user = groups.postUserMessage({ groupId: group.id, body: "go" });
    expect(groups.handleWorktreeReady(ready(group.id, alpha))).toBe(true);
    runtime.take(alpha).resolve({ outcome: "ok" });
    await flush();
    expect(runtime.pendingSessions()).toEqual([]);
    expect(groups.chainSnapshot(user.id)).toMatchObject({ hops: 1, ended: "max-hops" });
    expect(room(group.id).map((message) => message.body)).toEqual([
      "go",
      "",
      `Worktree ready: \`group/${group.id}/alpha\``,
      GROUP_STATUS_TEXT.limit["max-hops"],
    ]);
    expect(room(group.id)[1]).toMatchObject({ body: "", status: "completed" });
  });

  it("at the member's wake limit nobody is woken", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup({ limits: { maxWakesPerMember: 1 } });
    const user = groups.postUserMessage({ groupId: group.id, body: "go" });
    groups.handleWorktreeReady(ready(group.id, alpha));
    runtime.take(alpha).resolve({ outcome: "ok" });
    await flush();
    expect(runtime.pendingSessions()).toEqual([]);
    expect(groups.chainSnapshot(user.id)).toMatchObject({ ended: "max-member-wakes" });
  });

  it("a chain ended during the turn wakes nobody; an already ended chain does not end the turn", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta go" });
    expect(groups.handleWorktreeReady(ready(group.id, alpha))).toBe(true);
    runtime.openGate(beta); // Beta's gate ends the chain.
    runtime.take(alpha).resolve({ outcome: "ok" });
    await flush();
    expect(runtime.pendingSessions()).toEqual([beta]);
    expect(groups.chainSnapshot(user.id).ended).toBe("blocked");
    expect(room(group.id).at(-1)?.body).toBe(`Worktree ready: \`group/${group.id}/alpha\``);

    const next = squad();
    const second = setup();
    second.groups.postUserMessage({ groupId: next.group.id, body: "@Alpha @Beta go" });
    second.runtime.openGate(next.beta);
    expect(second.groups.handleWorktreeReady(ready(next.group.id, next.alpha))).toBe(false);
  });

  it("outside a group turn (own chat, gated turn, another group) nothing is re-woken", () => {
    const { group, alpha, beta } = squad();
    const other = squad();
    const { runtime, groups } = setup();
    expect(groups.handleWorktreeReady(ready(group.id, alpha))).toBe(false);
    groups.postUserMessage({ groupId: group.id, body: "@Beta go" });
    runtime.openGate(beta);
    expect(groups.handleWorktreeReady(ready(group.id, beta))).toBe(false);
    groups.postUserMessage({ groupId: other.group.id, body: "go" });
    expect(groups.handleWorktreeReady(ready(group.id, other.alpha))).toBe(false);
    expect(runtime.pendingSessions()).toEqual([beta, other.alpha]);
  });

  it("an aborted worktree turn cancels its canonical card and does not re-wake", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "go" });
    groups.handleWorktreeReady(ready(group.id, alpha));
    runtime.take(alpha).resolve({ outcome: "aborted" });
    await flush();
    expect(room(group.id)).toHaveLength(2);
    expect(room(group.id).at(-1)).toMatchObject({ body: "", status: "cancelled" });
    expect(runtime.pendingSessions()).toEqual([]);
  });
});

/* ── Stop and member states (room UI) ──────────────────────────────────── */

describe("stopGroup (room Stop button)", () => {
  it("ends the chain and cancels the queued and running cards without duplicate statuses", async () => {
    const { group, alpha, beta, gamma } = squad();
    const { runtime, groups, events } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta @Gamma go" });
    const cards = room(group.id).slice(1);
    expect(runtime.pendingSessions()).toEqual([alpha, beta]);
    groups.stopGroup(group.id);
    expect(groups.chainSnapshot(user.id).ended).toBe("stopped");
    expect(events).toContainEqual({
      type: "group.chain-ended",
      groupId: group.id,
      chainId: user.id,
      reason: "stopped",
    });
    expect(runtime.aborted).toEqual([alpha, beta]);
    await flush();
    const statuses = room(group.id).filter((m) => m.kind === "status");
    expect(statuses.map((m) => [m.authorKind, m.authorSessionId, m.body])).toEqual([
      ["system", undefined, "Stopped by you"],
    ]);
    expect(room(group.id).filter((message) => message.kind === "message" && message.authorKind === "agent").map((message) => [message.id, message.authorSessionId, message.status, message.body])).toEqual([
      [cards[0]?.id, alpha, "cancelled", ""],
      [cards[1]?.id, beta, "cancelled", ""],
      [cards[2]?.id, gamma, "cancelled", ""],
    ]);
    expect(room(group.id)).toHaveLength(5);
    // No limit line for a stop, Gamma never starts and the group goes idle.
    expect(runtime.started).not.toContain(gamma);
    expect(runtime.pendingSessions()).toEqual([]);
    expect(groups.isGroupWorking(group.id)).toBe(false);
    expect(groups.liveChainIds()).toEqual([]);
    expect(events.filter((e) => e.type === "group.activity").at(-1)).toMatchObject({
      runningSessionIds: [],
      queuedSessionIds: [],
    });
    // The room goes on with a new chain.
    groups.postUserMessage({ groupId: group.id, body: "@Beta again" });
    expect(runtime.pendingSessions()).toEqual([beta]);
  });

  it("cancels the group's gated turn while leaving another group running", async () => {
    const { group, alpha, beta } = squad();
    const other = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Alpha go" });
    runtime.openGate(alpha);
    groups.postUserMessage({ groupId: other.group.id, body: "@Beta go" });
    const before = room(group.id).length;
    groups.stopGroup(group.id);
    expect(runtime.aborted).toEqual([alpha]);
    await flush();
    expect(runtime.pendingSessions()).toEqual([other.beta]);
    expect(room(group.id)).toHaveLength(before + 1);
    expect(room(group.id).at(-1)).toMatchObject({ authorKind: "system", body: "Stopped by you" });
    expect(room(group.id).find((message) => message.authorSessionId === alpha)).toMatchObject({ status: "cancelled", body: "" });
    expect(room(other.group.id).find((message) => message.authorSessionId === other.beta)).toMatchObject({ status: "running", body: "" });
    expect(room(other.group.id).some((m) => m.body === "Stopped by you")).toBe(false);
    expect(groups.isAwaitingUser(beta)).toBe(false);
    expect(groups.memberStates().find((s) => s.groupId === group.id)?.waitingSessionIds ?? []).toEqual([]);
    expect(groups.isGroupWorking(other.group.id)).toBe(true);
  });
});

describe("member states", () => {
  it("reports running, queued and waiting-for-you members per group, in snapshot and push", async () => {
    const { group, alpha, beta, gamma } = squad();
    const { runtime, groups, events } = setup();
    expect(groups.memberStates()).toEqual([]);
    groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta @Gamma go" });
    expect(groups.memberStates()).toEqual([
      {
        groupId: group.id,
        runningSessionIds: [alpha, beta],
        queuedSessionIds: [gamma],
        waitingSessionIds: [],
      },
    ]);
    // Alpha hits the intent gate: waiting for you (and its slot goes free).
    runtime.openGate(alpha);
    expect(events.filter((e) => e.type === "group.activity").at(-1)).toMatchObject({
      runningSessionIds: [beta],
      waitingSessionIds: [alpha],
    });
    // Beta ends with a HyperPlan choice pending: waiting for you too.
    const { reserveHyperPlanSession } = await import("../agent/harness/hyperplan-draft-store");
    expect(reserveHyperPlanSession({ sessionId: beta, ownerId: 1 })).toBe(true);
    runtime.take(beta).resolve({ outcome: "blocked" });
    await flush();
    expect(groups.memberStates()).toEqual([
      {
        groupId: group.id,
        runningSessionIds: [],
        queuedSessionIds: [],
        waitingSessionIds: [alpha, beta],
      },
    ]);
    // Answered at the gate / plan built: no longer waiting.
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "done" });
    runtime.settle({ sessionId: beta, origin: "plan-build", result: { outcome: "ok" } });
    await flush();
    expect(groups.memberStates()).toEqual([]);
    expect(events.filter((e) => e.type === "group.activity").at(-1)).toMatchObject({
      waitingSessionIds: [],
    });
  });
});

describe("stopGroup posts Stopped by you only when it has an effect", () => {
  it("clearing only the queue counts; a second Stop does nothing", async () => {
    const { group, alpha, beta, gamma } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta @Gamma go" });
    // Alpha and Beta finish; their results would queue nobody, Gamma still waits in the queue.
    runtime.streaming.add(gamma);
    runtime.take(alpha).resolve({ outcome: "ok" });
    runtime.take(beta).resolve({ outcome: "ok" });
    await flush();
    expect(runtime.pendingSessions()).toEqual([]);
    expect(groups.isGroupWorking(group.id)).toBe(true); // Gamma queued
    groups.stopGroup(group.id);
    expect(runtime.aborted).toEqual([]);
    expect(room(group.id).filter((m) => m.body === "Stopped by you")).toHaveLength(1);
    expect(groups.isGroupWorking(group.id)).toBe(false);
    runtime.streaming.delete(gamma);
    groups.stopGroup(group.id);
    expect(room(group.id).filter((m) => m.body === "Stopped by you")).toHaveLength(1);
    expect(runtime.started).not.toContain(gamma);
  });
});

/* ── agents model (A2): roster, persona, archived members, folder required ── */

describe("agents in the room", () => {
  function agentsRoom() {
    const ws = insertWorkspace();
    const lead = createAgent({
      name: uid("Plan"),
      role: "Lead",
      instructions: "Split the work into tasks.",
    });
    const builder = createAgent({ name: uid("Build"), role: "Builder" });
    const group = createAgentGroupWithAgents({
      name: "Agents room",
      workspaceId: ws,
      members: [{ agentId: lead.id }, { agentId: builder.id }],
      leadAgentId: lead.id,
    });
    const [leadMember, builderMember] = group.members;
    if (!leadMember || !builderMember) throw new Error("members missing");
    return {
      ws,
      group,
      lead,
      builder,
      leadSession: leadMember.sessionId,
      builderSession: builderMember.sessionId,
    };
  }

  it("the wake prompt starts with the agent's instructions and lists names with roles", async () => {
    const { group, lead, builder, leadSession } = agentsRoom();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "Plan the release" });
    const prompt = runtime.take(leadSession).input.message;
    expect(
      prompt.startsWith("<agent_instructions>\nSplit the work into tasks.\n</agent_instructions>"),
    ).toBe(true);
    expect(prompt).toContain(
      [
        `You are @${lead.name}, a member of this group. Members right now:`,
        `- @${lead.name} [Lead] (lead) (you): Split the work into tasks.`,
        `- @${builder.name} [Builder]`,
      ].join("\n"),
    );
  });

  it("the roster entry is the role plus the first line of the instructions, cut at 120 chars", async () => {
    expect(GROUP_ROSTER_DESCRIPTION_MAX_CHARS).toBe(120);
    expect(agentDescription("\n  Reviews every diff.  \nBe strict.")).toBe("Reviews every diff.");
    expect(agentDescription("   \n")).toBeUndefined();
    expect(agentDescription(undefined)).toBeUndefined();
    const long = `${"x".repeat(119)}yz and more`;
    expect(agentDescription(long)).toBe(`${"x".repeat(119)}y`);
    expect(agentDescription(long)).toHaveLength(120);
    const { group, lead, leadSession } = agentsRoom();
    updateAgent(lead.id, { instructions: `${long}\nsecond line` });
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: `@${lead.name} go` });
    expect(runtime.take(leadSession).input.message).toContain(
      `- @${lead.name} [Lead] (lead) (you): ${"x".repeat(119)}y\n`,
    );
  });

  it("mentions match the agent name; an agent without instructions has no persona block", async () => {
    const { group, builder, builderSession } = agentsRoom();
    const { runtime, groups } = setup();
    const message = groups.postUserMessage({ groupId: group.id, body: `@${builder.name} go` });
    expect(message.mentions).toEqual([builderSession]);
    expect(runtime.take(builderSession).input.message).not.toContain("<agent_instructions>");
  });

  it("an archived agent stays a member but is never woken: the room says it is archived", async () => {
    const { group, builder, builderSession, leadSession } = agentsRoom();
    setAgentArchived(builder.id, true);
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: `@${builder.name} go` });
    expect(runtime.pendingSessions()).toEqual([]);
    expect(room(group.id).at(-1)).toMatchObject({
      authorKind: "system",
      kind: "status",
      body: `${builder.name} is archived`,
    });
    // An explicit target (a task tool wake) is refused the same way.
    groups.handleTaskWake({
      groupId: group.id,
      actorSessionId: leadSession,
      targetSessionId: builderSession,
      body: "Review requested",
    });
    expect(runtime.pendingSessions()).toEqual([]);
    expect(room(group.id).at(-1)?.body).toBe(`${builder.name} is archived`);
    // Restored: woken again.
    setAgentArchived(builder.id, false);
    groups.postUserMessage({ groupId: group.id, body: `@${builder.name} go` });
    expect(runtime.pendingSessions()).toEqual([builderSession]);
  });

  it.each([
    ["no workspace", null],
    ["the Chats inbox", "modus-inbox-chats"],
  ])("a group with %s is read-only: posting throws group-project-required and wakes nobody", async (_label, workspaceId) => {
    const { group, leadSession, builderSession } = agentsRoom();
    getDatabase()
      .prepare("update agent_groups set workspace_id = ? where id = ?")
      .run(workspaceId, group.id);
    const { runtime, groups } = setup();
    const before = room(group.id).length;
    expect(() => groups.postUserMessage({ groupId: group.id, body: "hello" })).toThrow(
      expect.objectContaining({ code: "group-project-required" }),
    );
    groups.handleTaskWake({
      groupId: group.id,
      actorSessionId: leadSession,
      targetSessionId: builderSession,
      body: "Changes requested",
    });
    expect(runtime.pendingSessions()).toEqual([]);
    // The history stays readable (the task status line itself is still recorded).
    expect(room(group.id).length).toBe(before + 1);
  });

  /* Dynamic discovery: the roster and mentions follow the CURRENT membership. */

  function liveRoom(count = 2) {
    const group = createGroupWithNewAgents({
      name: "Live room",
      workspaceId: insertWorkspace(),
      members: Array.from({ length: count }, (_, index) => ({
        name: index === 0 ? "Ana" : `Bo ${index}`,
        role: index === 0 ? "Planner" : "Builder",
        modelId: "openai/gpt-5",
      })),
      leadName: "Ana",
    });
    const ana = group.members[0]?.sessionId ?? "";
    return { group, ana };
  }

  function rosterOf(prompt: string): string[] {
    const lines = prompt.split("\n");
    const start = lines.findIndex((line) => line.endsWith("Members right now:"));
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("- @")) break;
      out.push(line);
    }
    return out;
  }

  it("an added agent is in the next wake's roster; the join line is context, not a wake", async () => {
    const { group, ana } = liveRoom();
    const { runtime, groups } = setup();
    createAgentInGroup({
      groupId: group.id,
      name: "Cy",
      role: "Reviewer",
      instructions: "Reviews every diff.\nBe strict.",
      modelId: "openai/gpt-5",
    });
    // The join line itself wakes nobody.
    expect(runtime.pendingSessions()).toEqual([]);
    expect(room(group.id).at(-1)).toMatchObject({ kind: "status", body: "Cy joined as Reviewer" });
    groups.postUserMessage({ groupId: group.id, body: "@Ana plan it" });
    const prompt = runtime.take(ana).input.message;
    expect(rosterOf(prompt)).toEqual([
      "- @Ana [Planner] (lead) (you)",
      "- @Bo 1 [Builder]",
      "- @Cy [Reviewer]: Reviews every diff.",
    ]);
    expect(prompt).toContain("[system status] Cy joined as Reviewer");
  });

  it("a removed agent leaves the roster; others read 'X left the group' next wake", async () => {
    const { group, ana } = liveRoom(3);
    const { runtime, groups } = setup();
    removeAgentFromGroup(group.id, group.members[2]?.sessionId ?? "");
    expect(runtime.pendingSessions()).toEqual([]);
    // An archived member stays in the roster, flagged.
    setAgentArchived(group.members[1]?.agentId ?? "", true);
    groups.postUserMessage({ groupId: group.id, body: "@Ana go" });
    const prompt = runtime.take(ana).input.message;
    expect(rosterOf(prompt)).toEqual([
      "- @Ana [Planner] (lead) (you)",
      "- @Bo 1 [Builder] (archived)",
    ]);
    expect(prompt).toContain("[system status] Bo 2 left the group");
  });

  it("the roster is rebuilt when a queued wake starts, not when it was queued", async () => {
    const { group, ana } = liveRoom(2);
    const bo = group.members[1]?.sessionId ?? "";
    const { runtime, groups } = setup();
    runtime.streaming.add(ana);
    groups.postUserMessage({ groupId: group.id, body: "@Ana later" });
    expect(runtime.pendingSessions()).toEqual([]);
    createAgentInGroup({ groupId: group.id, name: "Dee", modelId: "openai/gpt-5" });
    runtime.streaming.delete(ana);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    expect(rosterOf(runtime.take(ana).input.message)).toContain("- @Dee");
    expect(bo).toBeTruthy();
  });

  it("mentions use the agent's current name: after a rename @New wakes it, @Old does not", async () => {
    const { group } = liveRoom(2);
    const bo = group.members[1];
    const { runtime, groups } = setup();
    updateAgent(bo?.agentId ?? "", { name: "Bruno" });
    expect(groups.postUserMessage({ groupId: group.id, body: "@Bo 1 hello" }).mentions).toEqual([]);
    const message = groups.postUserMessage({ groupId: group.id, body: "@bruno hello" });
    expect(message.mentions).toEqual([bo?.sessionId]);
    // (The first message had no mention, so it went to the lead.)
    expect(runtime.pendingSessions()).toContain(bo?.sessionId);
  });

  it("a legacy group with 1 member is blocked (min-members) until an agent joins", async () => {
    const ws = insertWorkspace();
    const only = insertSession(ws, "Solo");
    const group = insertLegacyGroup({ name: "Legacy", workspaceId: ws, sessionIds: [only] });
    const { runtime, groups } = setup();
    expect(() => groups.postUserMessage({ groupId: group.id, body: "@Solo hi" })).toThrow(
      expect.objectContaining({ code: "group-min-members" }),
    );
    expect(runtime.pendingSessions()).toEqual([]);
    createAgentInGroup({ groupId: group.id, name: "Helper", modelId: "openai/gpt-5" });
    groups.postUserMessage({ groupId: group.id, body: "@Solo hi" });
    expect(runtime.pendingSessions()).toEqual([only]);
  });

  it("a legacy group with 11 members works normally", async () => {
    const ws = insertWorkspace();
    const sessions = Array.from({ length: 11 }, (_, index) => insertSession(ws, `M${index + 1}`));
    const group = insertLegacyGroup({ name: "Big legacy", workspaceId: ws, sessionIds: sessions });
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@M11 hi" });
    expect(runtime.pendingSessions()).toEqual([sessions[10]]);
  });
});
