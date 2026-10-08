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
  listGroupTasks,
  claimGroupTask,
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
const { runGroupTool, setGroupTaskWakeSink } = await import("../agent/tools/group-tools");
const { insertLegacyGroup } = await import("./legacy-group.fixture");
const { createGroupTask } = await import("./group-task-store");
const { setGroupTurnModelResolver } = await import("./group-runtime-lib");
const { resolveTurnModel } = await import("../agent/user-turn-model");
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
    mode: "free",
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
    maxConcurrentTurns?: number;
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
    ...(options.maxConcurrentTurns ? { maxConcurrentTurns: options.maxConcurrentTurns } : {}),
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

describe("group runtime constants", () => {
  it("exports the agreed chain limits and concurrency", () => {
    expect(GROUP_CHAIN_LIMITS).toEqual({
      maxAgentMessages: 20,
      maxWakesPerMember: 3,
      maxEstimatedInputTokens: 150_000,
      maxEstimatedContextTokensPerWake: 8_000,
    });
    expect(ESTIMATED_INPUT_TOKENS_PER_CHAIN).toBe(150_000);
    expect(ESTIMATED_CONTEXT_TOKENS_PER_WAKE).toBe(8_000);
    expect(GROUP_MAX_CONCURRENT_TURNS).toBe(2);
    expect(GROUP_STATUS_TEXT.waitingForYou).toBe("Waiting for you");
    expect(GROUP_STATUS_TEXT.noNextOwner).toContain("@mention");
    expect(GROUP_STATUS_TEXT.limit["input-token-budget"]).toContain("estimated 150k-token budget");
    expect(GROUP_STATUS_TEXT.limit["context-too-large"]).toContain("estimated 8k-token");
    // chars / 4
    expect(estimateGroupTokens("x".repeat(401))).toBe(101);
  });
});

/* ── turn outcomes through the fake runtime (the 4 contract cases) ───── */

describe("turn outcomes (fake runtime contract)", () => {
  it("passes an exact task seed to the owner's queued wake", () => {
    const { group, alpha } = squad();
    const { runtime, groups, state } = setup({ window: false });
    const user = groups.postUserMessage({ groupId: group.id, body: "do it" });
    const task = createGroupTask({
      groupId: group.id,
      title: "Work",
      ownerSessionId: alpha,
      executionId: user.id,
      status: "in_progress",
    });
    state.window = true;
    groups.kick();
    expect(runtime.calls[0]?.input.groupTask).toEqual({
      taskId: task.id,
      groupId: group.id,
      executionId: user.id,
      role: "owner",
    });
  });
  it("ok with text posts the reply as the member, in the same chain", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "status?" });
    expect(runtime.pendingSessions()).toEqual([alpha]);
    expect(runtime.calls[0]?.input.delivery).toBe("normal");
    const card = room(group.id)[1];
    expect(card).toMatchObject({ body: "", status: "running", authorSessionId: alpha });
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "All green." });
    await flush();
    const [, reply] = room(group.id);
    expect(reply).toMatchObject({
      authorKind: "agent",
      authorSessionId: alpha,
      kind: "message",
      body: "All green.",
      chainId: user.id,
      replyToMessageId: user.id,
      id: card?.id,
      turnId: card?.turnId,
      status: "completed",
    });
    expect(room(group.id)).toHaveLength(2);
  });

  it("ok without text completes the empty canonical card without extra messages", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "status?" });
    const card = room(group.id)[1];
    runtime.take(alpha).resolve({ outcome: "ok" });
    await flush();
    expect(room(group.id)).toHaveLength(2);
    expect(room(group.id)[1]).toMatchObject({ id: card?.id, body: "", status: "completed" });
    expect(groups.isGroupWorking(group.id)).toBe(false);
  });

  it("failed and thrown prompts mark their original cards failed and preserve hop counts", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta go" });
    const cards = room(group.id).slice(1);
    runtime.take(alpha).resolve({ outcome: "failed" });
    runtime.take(beta).reject(new Error("boom"));
    await flush();
    const failed = room(group.id).slice(1);
    expect(failed.map((m) => [m.id, m.authorSessionId, m.status, m.body])).toEqual([
      [cards[0]?.id, alpha, "failed", ""],
      [cards[1]?.id, beta, "failed", ""],
    ]);
    expect(failed[1]?.error).toBe("boom");
    expect(room(group.id)).toHaveLength(3);
    expect(groups.chainSnapshot(user.id).hops).toBe(2);
  });

  it("aborted cancels the original card without a duplicate status", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "go" });
    const card = room(group.id)[1];
    runtime.take(alpha).resolve({ outcome: "aborted" });
    await flush();
    expect(room(group.id).at(-1)).toMatchObject({
      id: card?.id,
      kind: "message",
      body: "",
      status: "cancelled",
    });
    expect(room(group.id)).toHaveLength(2);
  });

  it("blocked HyperPlan marks the member card awaiting_user and ends the chain", async () => {
    const { group, alpha } = squad();
    const { reserveHyperPlanSession } = await import("../agent/harness/hyperplan-draft-store");
    expect(reserveHyperPlanSession({ sessionId: alpha, ownerId: 1 })).toBe(true);
    const { runtime, groups, events } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "delete prod" });
    const card = room(group.id)[1];
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();
    expect(room(group.id).at(-1)).toMatchObject({
      authorKind: "agent",
      authorSessionId: alpha,
      id: card?.id,
      kind: "message",
      body: "",
      status: "awaiting_user",
      chainId: user.id,
    });
    expect(room(group.id)).toHaveLength(2);
    expect(groups.chainSnapshot(user.id)).toMatchObject({ hops: 1, ended: "blocked" });
    expect(groups.isAwaitingUser(alpha)).toBe(true);
    expect(events).toContainEqual({
      type: "group.chain-ended",
      groupId: group.id,
      chainId: user.id,
      reason: "blocked",
    });
  });

  it("non-HyperPlan blocked does not sticky-wait the user (peer handoffs stay open)", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Alpha go" });
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();
    expect(groups.isAwaitingUser(alpha)).toBe(false);
    expect(room(group.id).at(-1)).toMatchObject({
      kind: "message",
      body: "",
      status: "interrupted",
      authorSessionId: alpha,
    });
    // Room can continue with another member without clearing a sticky wait.
    groups.postUserMessage({ groupId: group.id, body: "@Beta continue" });
    expect(runtime.pendingSessions()).toEqual([beta]);
    expect(
      groups.memberStates().find((s) => s.groupId === group.id)?.waitingSessionIds ?? [],
    ).toEqual([]);
  });
});

/* ── wake rules ───────────────────────────────────────────────────────── */

describe("wake rules", () => {
  it("a user message without mentions falls back to the lead when no specialty matches", () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "hello team" });
    expect(runtime.pendingSessions()).toEqual([alpha]);
  });

  it("untargeted work without a Lead requests routing input instead of inferring a role", () => {
    const ws = insertWorkspace();
    const planner = insertSession(ws, "Planner");
    const builder = insertSession(ws, "Builder");
    const reviewer = insertSession(ws, "Reviewer");
    const group = createAgentGroupWithMembers({
      name: "Crew",
      workspaceId: ws,
      members: [
        { sessionId: planner, role: "Planner" },
        { sessionId: builder, role: "Builder" },
        { sessionId: reviewer, role: "Reviewer" },
      ],
      leadSessionId: null,
    });
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "please review the login PR" });
    expect(runtime.pendingSessions()).toEqual([]);
    expect(room(group.id).at(-1)).toMatchObject({
      authorKind: "system",
      kind: "status",
      body: expect.stringContaining("no-eligible-lead"),
    });
  });

  it("an agent message without mentions wakes nobody (not even the lead)", async () => {
    const { group, beta } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Beta check" });
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Checked, all fine." });
    await flush();
    expect(runtime.pendingSessions()).toEqual([]);
  });

  it("@mentions wake the mentioned members (body and explicit ids), never the lead implicitly", () => {
    const { group, beta, gamma } = squad();
    const { runtime, groups } = setup();
    const message = groups.postUserMessage({
      groupId: group.id,
      body: "@beta please",
      mentions: [gamma],
    });
    expect(message.mentions).toEqual([beta, gamma]);
    expect(runtime.pendingSessions()).toEqual([beta, gamma]);
  });

  it("public self and peer mentions wake neither the author nor the mentioned peer", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "go" });
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "@Alpha will do it, @Beta review" });
    await flush();
    expect(runtime.pendingSessions()).toEqual([]);
    expect(runtime.started).toEqual([alpha]);
    expect(room(group.id).at(-1)).toMatchObject({
      body: "@Alpha will do it, @Beta review",
      status: "completed",
    });
    expect(runtime.started).not.toContain(beta);
  });

  it("a thread reply wakes the replied-to author without requiring @mention", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "go" });
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "Done." });
    await flush();
    const lead = room(group.id).at(-1);
    // Natural thread: reply continues the conversation with that author.
    groups.postUserMessage({
      groupId: group.id,
      body: "thanks — one more detail",
      replyToMessageId: lead?.id ?? "",
    });
    expect(runtime.pendingSessions()).toEqual([alpha]);
  });

  it("parses @Title mentions longest-first and ignores partial words", () => {
    const members = [
      { sessionId: "a", title: "Dev" },
      { sessionId: "b", title: "Dev Lead" },
    ];
    expect(parseGroupMentions("ping @Dev Lead", members)).toEqual(["b"]);
    expect(parseGroupMentions("ping @dev and @Dev Lead", members)).toEqual(["a", "b"]);
    expect(parseGroupMentions("mail dev@Devx", members)).toEqual([]);
    expect(parseGroupMentions("@b by id", members)).toEqual(["b"]);
    // @everyone is transcript-only: never expands to a mass wake.
    expect(parseGroupMentions("@everyone please read", members)).toEqual([]);
    expect(parseGroupMentions("@everyone and @Dev", members)).toEqual(["a"]);
  });

  it("@Title wakes every member sharing that title (case-insensitive)", async () => {
    const members = [
      { sessionId: "a", title: "Reviewer" },
      { sessionId: "b", title: "reviewer" },
      { sessionId: "c", title: "Reviewer Bot" },
    ];
    expect(parseGroupMentions("@REVIEWER please", members)).toEqual(["a", "b"]);
    expect(parseGroupMentions("@Reviewer Bot and @reviewer", members)).toEqual(["a", "b", "c"]);

    const ws = insertWorkspace();
    const one = insertSession(ws, "Tester");
    const two = insertSession(ws, "tester");
    const group = createAgentGroupWithMembers({
      name: "Twins",
      workspaceId: ws,
      members: [{ sessionId: one }, { sessionId: two }],
      leadSessionId: one,
    });
    const { runtime, groups } = setup();
    // In a room, members are agents with unique names: "Tester" and "tester 2".
    const message = groups.postUserMessage({ groupId: group.id, body: "@Tester run it" });
    expect(message.mentions).toEqual([one]);
    expect(runtime.pendingSessions()).toEqual([one]);
    expect(
      groups.postUserMessage({ groupId: group.id, body: "@tester 2 you too" }).mentions,
    ).toEqual([two]);
  });
});

/* ── chain ids, persistence ──────────────────────────────────────────── */

describe("chains", () => {
  it("each user message opens a new chain; agent replies inherit it (mentions_json persisted)", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    const first = groups.postUserMessage({ groupId: group.id, body: "go" });
    const alphaCard = room(group.id)[1];
    const handoff = groups.handleTaskWake({
      groupId: group.id,
      actorSessionId: alpha,
      targetSessionId: beta,
      body: "Review the result",
    });
    const betaCard = room(group.id).at(-1);
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "@Beta your turn" });
    await flush();
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Done." });
    await flush();
    const second = groups.postUserMessage({ groupId: group.id, body: "again" });
    const messages = room(group.id);
    // Stable cards keep their original positions; the structured handoff is a separate status.
    expect(messages.map((m) => m.chainId)).toEqual([
      first.id,
      first.id,
      first.id,
      first.id,
      second.id,
      second.id,
    ]);
    expect(messages[1]).toMatchObject({
      id: alphaCard?.id,
      body: "@Beta your turn",
      status: "completed",
    });
    expect(messages[2]).toMatchObject({
      id: handoff?.id,
      kind: "status",
      body: "Review the result",
      mentions: [beta],
      authorSessionId: alpha,
    });
    expect(messages[3]).toMatchObject({ id: betaCard?.id, body: "Done.", status: "completed" });
    expect(messages[5]).toMatchObject({ authorSessionId: alpha, status: "running", body: "" });
    expect(runtime.started).toEqual([alpha, beta, alpha]);
    expect(second.chainId).toBe(second.id);
    expect(groups.chainSnapshot(second.id).hops).toBe(1);
  });

  it("Complementar reuses the active executionId; Nova tarefa opens a new one", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    const first = groups.postUserMessage({
      groupId: group.id,
      body: "@Alpha ship login",
      executionMode: "new",
    });
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "Login shipped." });
    await flush();
    const complement = groups.postUserMessage({
      groupId: group.id,
      body: "@Alpha also cover OAuth",
      executionMode: "complement",
      executionId: first.id,
    });
    expect(complement.chainId).toBe(first.id);
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "OAuth covered." });
    await flush();
    const fresh = groups.postUserMessage({
      groupId: group.id,
      body: "@Alpha separate docs",
      executionMode: "new",
    });
    expect(fresh.chainId).toBe(fresh.id);
    expect(fresh.chainId).not.toBe(first.id);
    const linked = room(group.id).filter((m) => m.chainId === first.id);
    expect(linked.some((m) => m.id === first.id)).toBe(true);
    expect(linked.some((m) => m.id === complement.id)).toBe(true);
    expect(linked.every((m) => m.chainId === first.id)).toBe(true);
  });
});

/* ── limits ──────────────────────────────────────────────────────────── */

describe("chain limits", () => {
  /** Alpha and Beta keep handing off to each other. */
  async function pingPong(
    limits: Partial<Record<keyof typeof GROUP_CHAIN_LIMITS, number>>,
    turns: number,
  ) {
    const fixture = squad();
    const ctx = setup({ limits, maxConcurrentTurns: 1 });
    const user = ctx.groups.postUserMessage({ groupId: fixture.group.id, body: "start" });
    let current = fixture.alpha;
    for (let turn = 0; turn < turns; turn += 1) {
      if (!ctx.runtime.pendingSessions().includes(current)) break;
      const next = current === fixture.alpha ? fixture.beta : fixture.alpha;
      ctx.groups.handleTaskWake({
        groupId: fixture.group.id,
        actorSessionId: current,
        targetSessionId: next,
        body: "Continue the task",
      });
      ctx.runtime.take(current).resolve({ outcome: "ok", finalText: "Progress recorded." });
      await flush();
      current = current === fixture.alpha ? fixture.beta : fixture.alpha;
    }
    return { ...fixture, ...ctx, user };
  }

  function expectStopped(
    groupId: string,
    chainId: string,
    reason: string,
    runtime: FakeAgentRuntime,
  ) {
    const limit = room(groupId).filter(
      (message) => message.authorKind === "system" && message.kind === "status",
    );
    expect(limit).toHaveLength(1);
    expect(limit[0]).toMatchObject({
      chainId,
      body: (GROUP_STATUS_TEXT.limit as Record<string, string>)[reason],
    });
    expect(limit[0]?.body.startsWith("Automatic handoffs paused")).toBe(true);
    expect(
      room(groupId)
        .filter((message) => message.authorKind === "agent" && message.kind === "message")
        .every((message) => message.status === "completed" || message.status === "cancelled"),
    ).toBe(true);
    expect(runtime.pendingSessions()).toEqual([]);
  }

  it("continues beyond six handoffs while the resource budgets allow it", async () => {
    const { group, user, runtime, groups } = await pingPong(
      { maxWakesPerMember: 99, maxAgentMessages: 99 },
      8,
    );

    expect(groups.chainSnapshot(user.id)).toMatchObject({ hops: 9 });
    expect(groups.chainSnapshot(user.id).ended).toBeUndefined();
    expect(runtime.pendingSessions()).toHaveLength(1);
    expect(
      room(group.id).filter(
        (message) => message.authorKind === "agent" && message.status === "cancelled",
      ),
    ).toEqual([]);
  });

  it(`stops at ${GROUP_CHAIN_LIMITS.maxWakesPerMember} wakes per member`, async () => {
    const { group, user, runtime, groups } = await pingPong({}, 20);
    // Alpha: 3 wakes (1 by the user + 2 hand-offs), then Beta's 3rd hand-off is refused.
    expect(groups.chainSnapshot(user.id)).toMatchObject({ ended: "max-member-wakes" });
    expectStopped(group.id, user.id, "max-member-wakes", runtime);
  });

  it("stops at the agent-message limit", async () => {
    const { group, user, runtime, groups } = await pingPong(
      { maxAgentMessages: 2, maxWakesPerMember: 99 },
      20,
    );
    expect(groups.chainSnapshot(user.id)).toMatchObject({
      agentMessages: 3,
      ended: "max-agent-messages",
    });
    expectStopped(group.id, user.id, "max-agent-messages", runtime);
  });

  it("stops when the input-token budget would be exceeded", async () => {
    const { group, alpha } = squad();
    const ctx = setup({ limits: { maxEstimatedInputTokens: 10 } });
    const user = ctx.groups.postUserMessage({ groupId: group.id, body: "hi" });
    expect(ctx.runtime.pendingSessions()).not.toContain(alpha);
    expect(ctx.groups.chainSnapshot(user.id).ended).toBe("input-token-budget");
    expectStopped(group.id, user.id, "input-token-budget", ctx.runtime);
  });

  it("caps group context per wake and stops when the trigger alone does not fit", () => {
    const { group, alpha } = squad();
    const ctx = setup();
    for (let i = 0; i < 40; i += 1) {
      ctx.groups.postUserMessage({ groupId: group.id, body: `@Beta ${"x".repeat(2_000)} ${i}` });
    }
    // History is trimmed to the budget; the wake prompt stays under it.
    const prompts = ctx.runtime.calls.map((call) => call.input.message);
    for (const prompt of prompts) {
      expect(estimateGroupTokens(prompt)).toBeLessThanOrEqual(
        GROUP_CHAIN_LIMITS.maxEstimatedContextTokensPerWake,
      );
    }
    const huge = ctx.groups.postUserMessage({ groupId: group.id, body: "y".repeat(40_000) });
    expect(ctx.runtime.pendingSessions().filter((id) => id === alpha)).toHaveLength(0);
    expect(ctx.groups.chainSnapshot(huge.id).ended).toBe("context-too-large");
  });

  it("lets already queued turns finish after a resource budget is reached", async () => {
    const { group, alpha, beta, gamma } = squad();
    const { runtime, groups } = setup({ limits: { maxAgentMessages: 1 } });
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta @Gamma go" });
    // All three wakes were admitted; Alpha and Beta run, Gamma is queued.
    expect(runtime.pendingSessions()).toEqual([alpha, beta]);
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "Alpha finished." });
    await flush();
    expect(groups.chainSnapshot(user.id)).toMatchObject({ ended: "max-agent-messages" });
    // The limit prevents more handoffs, but the previously admitted Gamma turn still starts.
    expect(runtime.pendingSessions()).toEqual([beta, gamma]);
    expect(runtime.started).toEqual([alpha, beta, gamma]);
    expect(
      room(group.id).some(
        (message) => message.body === "The task chain ended before this turn started.",
      ),
    ).toBe(false);
    expect(groups.isGroupWorking(group.id)).toBe(true);
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Beta finished." });
    runtime.take(gamma).resolve({ outcome: "ok", finalText: "Gamma finished." });
    await flush();
    expect(
      room(group.id).filter(
        (message) => message.kind === "message" && message.authorKind === "agent",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorSessionId: alpha,
          body: "Alpha finished.",
          status: "completed",
        }),
        expect.objectContaining({
          authorSessionId: beta,
          body: "Beta finished.",
          status: "completed",
        }),
        expect.objectContaining({
          authorSessionId: gamma,
          body: "Gamma finished.",
          status: "completed",
        }),
      ]),
    );
    expect(runtime.pendingSessions()).toEqual([]);
    expect(groups.isGroupWorking(group.id)).toBe(false);
  });

  it("composes the wake prompt with roster, history and the trigger", () => {
    const prompt = composeGroupWakePrompt({
      group: {
        id: "g",
        name: "Squad",
        mode: "free",
        leadSessionId: "a",
        createdAt: "",
        updatedAt: "",
      },
      members: [
        { sessionId: "a", title: "Alpha" },
        { sessionId: "b", title: "Beta" },
      ],
      sessionId: "b",
      trigger: {
        id: "m2",
        groupId: "g",
        authorKind: "agent",
        authorSessionId: "a",
        kind: "message",
        body: "@Beta <check>",
        mentions: ["b"],
        createdAt: "2",
      },
      history: [
        {
          id: "m1",
          groupId: "g",
          authorKind: "user",
          kind: "message",
          body: "start",
          mentions: [],
          createdAt: "1",
        },
      ],
      maxContextTokens: 8_000,
    });
    expect(prompt).toContain("You are @Beta");
    expect(prompt).toContain(
      "Members right now:\n- @Alpha (lead) (sessionId: a)\n- @Beta (you) (sessionId: b)\n",
    );
    expect(prompt).toContain("[user] start");
    expect(prompt).toContain('<group_message from="@Alpha">\n@Beta &lt;check&gt;');
    expect(prompt).toContain("Collaboration protocol");
    expect(prompt).toContain("group_handoff(memberId=<session ID>");
    expect(prompt).toContain("group_request_review(id=<task ID>");
    expect(prompt).toContain("Match the user's language");
    expect(prompt).toContain("adding detail when the user asks or the result requires it");
    expect(prompt).toContain("one concise public response per turn");
    expect(prompt).toContain("Do not narrate internal reasoning, tool calls");
    expect(prompt).toContain("briefly thank the teammate and add specific feedback when useful");
    expect(prompt).toContain("social feedback does not replace a review");
    expect(prompt).toContain("the Lead should consolidate their results into one public response");
    expect(prompt).not.toContain("Outcome: … / Validations: … / Changed files: … / Open items: …");
  });
});

describe("natural collaboration completion", () => {
  it("completes a natural reply without posting a no-next-owner nudge", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "go" });
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "I finished the toggle." });
    await flush();
    expect(room(group.id).at(-1)).toMatchObject({
      authorSessionId: alpha,
      kind: "message",
      body: "I finished the toggle.",
      status: "completed",
      mentions: [],
    });
    expect(room(group.id)).toHaveLength(2);
    expect(runtime.pendingSessions()).toEqual([]);
  });

  it("does not nudge when the reply closes the loop with Agreed", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "go" });
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "Looks good.\nAgreed" });
    await flush();
    expect(room(group.id).map((m) => m.body)).toEqual(["go", "Looks good.\nAgreed"]);
  });
});

/* ── shared context: the "Group decisions" prompt section (PR 6) ───────── */

describe("group decisions in the wake prompt", () => {
  const decision = (id: string, text: string, authorSessionId?: string) => ({
    id,
    groupId: "g",
    text,
    ...(authorSessionId ? { authorSessionId } : {}),
    createdAt: id,
  });
  const titles = new Map([
    ["a", "Alpha"],
    ["b", "Beta"],
  ]);

  it("lists decisions newest first with their author, escaped; a deleted or departed author is a former member, never the user", () => {
    const section = composeGroupDecisionsSection(
      [
        decision("4", "Use <WAL>", "a"),
        decision("3", "Ship weekly"),
        decision("2", "Pin deps", "gone"),
        decision("1", "Old", "b"),
      ],
      titles,
    );
    expect(section).toBe(
      [
        "<group_decisions>",
        "Group decisions (newest first; the group agreed on these, keep to them):",
        "- Use &lt;WAL&gt; (@Alpha)",
        "- Ship weekly (former member)",
        "- Pin deps (former member)",
        "- Old (@Beta)",
        "</group_decisions>",
      ].join("\n"),
    );
    expect(composeGroupDecisionsSection([], titles)).toBe("");
  });

  it(`keeps at most ${GROUP_PROMPT_DECISIONS_MAX_ITEMS} items and notes the omitted older ones`, () => {
    const all = Array.from({ length: 25 }, (_, index) =>
      decision(String(100 - index), `Decision ${100 - index}`, "a"),
    );
    const section = composeGroupDecisionsSection(all, titles);
    const items = section.split("\n").filter((line) => line.startsWith("- "));
    expect(items).toHaveLength(GROUP_PROMPT_DECISIONS_MAX_ITEMS);
    expect(items[0]).toBe("- Decision 100 (@Alpha)");
    expect(items.at(-1)).toBe("- Decision 81 (@Alpha)");
    expect(section).toContain("\n(5 older decisions omitted)\n</group_decisions>");
  });

  it(`stays within ~${GROUP_PROMPT_DECISIONS_MAX_TOKENS / 1000}k estimated tokens`, () => {
    const all = Array.from({ length: 20 }, (_, index) =>
      decision(String(index), `${index} ${"x".repeat(495)}`, "b"),
    );
    const section = composeGroupDecisionsSection(all, titles);
    expect(estimateGroupTokens(section)).toBeLessThanOrEqual(GROUP_PROMPT_DECISIONS_MAX_TOKENS);
    const kept = section.split("\n").filter((line) => line.startsWith("- ")).length;
    expect(kept).toBeGreaterThan(10);
    expect(kept).toBeLessThan(20);
    expect(section).toContain(`(${20 - kept} older decisions omitted)`);
  });

  it("puts the section after the roster and before the history", () => {
    const prompt = composeGroupWakePrompt({
      group: { id: "g", name: "Squad", mode: "free", createdAt: "", updatedAt: "" },
      members: [
        { sessionId: "a", title: "Alpha" },
        { sessionId: "b", title: "Beta" },
      ],
      sessionId: "b",
      trigger: {
        id: "m2",
        groupId: "g",
        authorKind: "user",
        kind: "message",
        body: "@Beta go",
        mentions: ["b"],
        createdAt: "2",
      },
      history: [
        {
          id: "m1",
          groupId: "g",
          authorKind: "user",
          kind: "message",
          body: "start",
          mentions: [],
          createdAt: "1",
        },
      ],
      decisions: [decision("1", "Use SQLite", "a")],
      maxContextTokens: 8_000,
    });
    const at = (text: string) => prompt?.indexOf(text) ?? -1;
    expect(at("- Use SQLite (@Alpha)")).toBeGreaterThan(at("You are @Beta"));
    expect(at("</group_decisions>")).toBeLessThan(at("<recent_messages>"));
    expect(at("<recent_messages>")).toBeLessThan(at("<group_message"));
  });

  it("every woken member gets the group's decisions, counted in the chain budget", () => {
    const { group, alpha, beta } = squad();
    recordGroupDecision({ groupId: group.id, text: "Use SQLite", authorSessionId: alpha });
    recordGroupDecision({ groupId: group.id, text: "Ship weekly" });
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta plan it" });
    expect(runtime.pendingSessions()).toEqual([alpha, beta]);
    const prompts = runtime.calls.map((call) => call.input.message);
    for (const prompt of prompts) {
      expect(prompt).toContain(
        "- Ship weekly (former member)\n- Use SQLite (@Alpha)\n</group_decisions>",
      );
    }
    expect(groups.chainSnapshot(user.id).inputTokens).toBe(
      prompts.reduce((sum, prompt) => sum + estimateGroupTokens(prompt), 0),
    );
  });

  it("the decisions can push a wake over the chain's input-token budget", () => {
    const plain = squad();
    const probe = setup();
    probe.groups.postUserMessage({ groupId: plain.group.id, body: "@Alpha hi" });
    const without = estimateGroupTokens(probe.runtime.calls[0]?.input.message ?? "");

    const { group, alpha } = squad();
    recordGroupDecision({ groupId: group.id, text: "x".repeat(400), authorSessionId: alpha });
    const { runtime, groups } = setup({ limits: { maxEstimatedInputTokens: without + 20 } });
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha hi" });
    expect(runtime.pendingSessions()).toEqual([]);
    expect(groups.chainSnapshot(user.id).ended).toBe("input-token-budget");
  });
});

/* ── coordinator mode: routing, Group snapshot (PR 7) ─────────────────── */

describe("coordinator mode", () => {
  const task = (id: string, status: string, extra: Record<string, string> = {}) => ({
    id,
    groupId: "g",
    title: `Task ${id}`,
    status: status as "open",
    createdAt: "",
    updatedAt: "",
    ...extra,
  });

  it("the snapshot lists members (id, lead/you, state, branch) and the active tasks", () => {
    const section = composeGroupSnapshotSection({
      sessionId: "a",
      leadSessionId: "a",
      members: [
        { sessionId: "a", title: "Alpha", state: "working" },
        { sessionId: "b", title: "Beta", state: "idle", branch: "modus/group/g/b" },
        { sessionId: "c", title: "Beta", state: "waiting" },
      ],
      tasks: [
        task("1", "open", { reviewerSessionId: "b" }),
        task("2", "in_progress", { ownerSessionId: "b" }),
        task("3", "in_review", { ownerSessionId: "b", reviewerSessionId: "c" }),
        task("4", "done", { ownerSessionId: "b" }),
        task("5", "cancelled"),
      ],
    });
    expect(section).toBe(
      [
        "<group_snapshot>",
        "Group snapshot (coordinator mode: you are the Lead and coordinate the group; hand out tasks with group_assign_task):",
        "Match the user's language. Sound natural, warm, and direct; default to 1–3 short sentences, adding detail when the user asks or the result requires it.",
        "Send one concise public response per turn. Do not narrate internal reasoning, tool calls, or routine work steps.",
        "After meaningful peer work, briefly thank the teammate and add specific feedback when useful. Avoid generic praise, numerical ratings, or social scoring.",
        "Requested or required task reviews still follow the typed Group review workflow; social feedback does not replace a review.",
        "As Lead, consolidate contributing members' results into one public response; specialists should not duplicate it.",
        "Members:",
        "- @Alpha (id a) lead, you: working",
        "- @Beta (id b): idle, branch modus/group/g/b",
        "- @Beta (id c): waiting",
        "Tasks (open, in progress, in review):",
        '- task 1 [open] "Task 1" owner=none reviewer=@Beta (id b)',
        '- task 2 [in_progress] "Task 2" owner=@Beta (id b) reviewer=none',
        '- task 3 [in_review] "Task 3" owner=@Beta (id b) reviewer=@Beta (id c)',
        "</group_snapshot>",
      ].join("\n"),
    );
    expect(section).not.toContain("Outcome / Validations / Changed files / Open items");
  });

  it("includes typed gates and ready delegation metadata in the Lead snapshot", () => {
    const taskId = "typed-task";
    const section = composeGroupSnapshotSection({
      sessionId: "a",
      leadSessionId: "a",
      members: [
        { sessionId: "a", title: "Alpha", state: "working" },
        { sessionId: "b", title: "Beta", state: "idle" },
      ],
      tasks: [
        {
          id: taskId,
          groupId: "g",
          title: "Typed task",
          status: "in_progress",
          kind: "code",
          priority: "high",
          stage: "implement",
          dependencyIds: [],
          verificationPolicy: { mode: "required", requireReview: true },
          createdAt: "",
          updatedAt: "",
          ownerSessionId: "b",
        },
      ],
      gates: { [taskId]: { satisfied: false, reasonCodes: ["criterion-unverified"] } },
      delegations: {
        [taskId]: [{ taskId, stage: "implement", tool: "group_assign_task", memberId: "b" }],
      },
    });

    expect(section).toContain(
      `task ${taskId} [in_progress] kind=code priority=high stage=implement`,
    );
    expect(section).toContain('gate={"satisfied":false,"reasonCodes":["criterion-unverified"]}');
    expect(section).toContain(
      `delegations=[{"taskId":"${taskId}","stage":"implement","tool":"group_assign_task","memberId":"b"}]`,
    );
  });

  it(`stays within ~${GROUP_PROMPT_SNAPSHOT_MAX_TOKENS / 1000}k estimated tokens, noting omitted tasks`, () => {
    const tasks = Array.from({ length: 80 }, (_, index) =>
      task(String(index), "open", { title: `${index} ${"x".repeat(150)}` }),
    );
    const section = composeGroupSnapshotSection({
      sessionId: "a",
      leadSessionId: "a",
      members: [{ sessionId: "a", title: "Alpha", state: "idle" }],
      tasks,
    });
    expect(estimateGroupTokens(section)).toBeLessThanOrEqual(GROUP_PROMPT_SNAPSHOT_MAX_TOKENS);
    const kept = section.split("\n").filter((line) => line.startsWith("- task ")).length;
    expect(kept).toBeGreaterThan(10);
    expect(section).toContain(`(${80 - kept} more tasks omitted)`);
    const empty = composeGroupSnapshotSection({
      sessionId: "a",
      leadSessionId: "a",
      members: [{ sessionId: "a", title: "Alpha", state: "idle" }],
      tasks: [],
    });
    expect(empty).toContain("Tasks (open, in progress, in review):\n- none\n</group_snapshot>");
  });

  it("with the mode on, a user message with no mention wakes only the Lead, who gets the snapshot", () => {
    const { group, alpha, beta } = squad();
    setAgentGroupMode(group.id, "coordinator");
    createMemberGroupTask({ groupId: group.id, actorSessionId: beta, title: "Parser" });
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "ship the parser" });
    expect(runtime.pendingSessions()).toEqual([alpha]);
    const prompt = runtime.calls[0]?.input.message ?? "";
    expect(prompt).toContain("<group_snapshot>");
    expect(prompt).toContain(`- @Alpha (id ${alpha}) lead, you: working`);
    expect(prompt).toContain(`- @Beta (id ${beta}): idle`);
    expect(prompt).toContain('[open] "Parser" owner=none');
    // Counted in the chain budget (it is part of the prompt).
    expect(groups.chainSnapshot(user.id).inputTokens).toBe(estimateGroupTokens(prompt));
  });

  it("user mentions wake members without a snapshot; structured handoffs wake the Lead and peers", async () => {
    const { group, alpha, beta, gamma } = squad();
    setAgentGroupMode(group.id, "coordinator");
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Beta check it" });
    expect(runtime.pendingSessions()).toEqual([beta]);
    expect(runtime.calls[0]?.input.message).not.toContain("<group_snapshot>");
    groups.handleTaskWake({
      groupId: group.id,
      actorSessionId: beta,
      targetSessionId: alpha,
      body: "Coordinate the review",
    });
    groups.handleTaskWake({
      groupId: group.id,
      actorSessionId: beta,
      targetSessionId: gamma,
      body: "Review the change",
    });
    runtime.take(beta).resolve({ outcome: "ok", finalText: "@Gamma and @Alpha, over to you" });
    await flush();
    expect(runtime.pendingSessions()).toEqual([alpha, gamma]);
    const byMember = new Map(
      runtime.calls.map((call) => [call.input.sessionId, call.input.message]),
    );
    expect(byMember.get(alpha)).toContain("<group_snapshot>");
    expect(byMember.get(gamma)).not.toContain("<group_snapshot>");
  });

  it("without a Lead untargeted intake needs a user; a new Lead coordinates", async () => {
    const { group, beta } = squad();
    setAgentGroupMode(group.id, "coordinator");
    setAgentGroupLead(group.id, null);
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "anyone?" });
    expect(runtime.pendingSessions()).toEqual([]);
    expect(room(group.id).at(-1)?.body).toContain("no-eligible-lead");
    groups.postUserMessage({ groupId: group.id, body: "@Beta you then" });
    expect(runtime.pendingSessions()).toEqual([beta]);
    expect(runtime.calls.at(-1)?.input.message).not.toContain("<group_snapshot>");
    runtime.take(beta).resolve({ outcome: "ok" });
    await flush();
    setAgentGroupLead(group.id, beta);
    groups.postUserMessage({ groupId: group.id, body: "plan it" });
    expect(runtime.calls.at(-1)?.input.sessionId).toBe(beta);
    expect(runtime.calls.at(-1)?.input.message).toContain(`- @Beta (id ${beta}) lead, you:`);
  });

  it("with the mode off the Lead gets no snapshot", () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "hi" });
    expect(runtime.pendingSessions()).toEqual([alpha]);
    expect(runtime.calls[0]?.input.message).not.toContain("<group_snapshot>");
  });

  it("group_assign_task from the Lead's turn wakes the assignee (a hop); assigning itself does not", async () => {
    const { group, alpha, beta } = squad();
    setAgentGroupMode(group.id, "coordinator");
    const { runtime, groups } = setup();
    setGroupTaskWakeSink((wake) => groups.handleTaskWake(wake));
    try {
      const lead = { sessionId: alpha, groupId: group.id };
      const first = createMemberGroupTask({ groupId: group.id, actorSessionId: alpha, title: "A" });
      const second = createMemberGroupTask({
        groupId: group.id,
        actorSessionId: alpha,
        title: "B",
      });
      const user = groups.postUserMessage({ groupId: group.id, body: "split the work" });
      runGroupTool("group_assign_task", lead, { taskId: first.id, memberId: "Beta" });
      expect(runtime.pendingSessions()).toEqual([alpha, beta]);
      expect(
        room(group.id).find(
          (message) => message.kind === "status" && message.mentions.includes(beta),
        ),
      ).toMatchObject({
        kind: "status",
        authorSessionId: alpha,
        mentions: [beta],
        chainId: user.id,
      });
      expect(room(group.id).at(-1)).toMatchObject({
        authorSessionId: beta,
        kind: "message",
        body: "",
        status: "running",
        chainId: user.id,
      });
      expect(groups.chainSnapshot(user.id)).toMatchObject({ hops: 2 });
      runGroupTool("group_assign_task", lead, { taskId: second.id, memberId: "Alpha" });
      expect(room(group.id).at(-1)?.body).toBe(`Assigned: "B" (task ${second.id}) → @Alpha`);
      expect(runtime.pendingSessions()).toEqual([alpha, beta]);
      expect(groups.chainSnapshot(user.id)).toMatchObject({ hops: 2 });
    } finally {
      setGroupTaskWakeSink(undefined);
    }
  });

  it("silence with an open unowned task leaves it open without nudging or waking the Lead", async () => {
    const { group, alpha, beta } = squad();
    setAgentGroupMode(group.id, "coordinator");
    createMemberGroupTask({ groupId: group.id, actorSessionId: alpha, title: "Parser" });
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Beta do the work" });
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Finished the draft." });
    await flush();
    const messages = room(group.id);
    expect(messages.at(-1)).toMatchObject({
      kind: "message",
      authorSessionId: beta,
      body: "Finished the draft.",
      status: "completed",
    });
    expect(messages).toHaveLength(2);
    expect(listGroupTasks(group.id)).toEqual([
      expect.objectContaining({ title: "Parser", status: "open" }),
    ]);
    expect(runtime.pendingSessions()).toEqual([]);
    expect(runtime.started).toEqual([beta]);
  });
});

/* ── intent gate: the question opens inside prompt(); the slot is released ── */

describe("intent gate on a group turn", () => {
  it("frees the slot, marks the same card awaiting_user and ends the chain", async () => {
    const { group, alpha, beta, gamma } = squad();
    const { runtime, groups, events } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta go" });
    // A second chain queues Gamma behind the two running turns.
    const other = groups.postUserMessage({ groupId: group.id, body: "@Gamma also" });
    const later = groups.postUserMessage({ groupId: group.id, body: "@Beta later" });
    expect(runtime.pendingSessions()).toEqual([alpha, beta]);
    const alphaCard = room(group.id).find((message) => message.authorSessionId === alpha);

    runtime.openGate(alpha);
    expect(room(group.id).find((m) => m.id === alphaCard?.id)).toMatchObject({
      authorKind: "agent",
      authorSessionId: alpha,
      body: "",
      status: "awaiting_user",
      chainId: user.id,
    });
    expect(groups.chainSnapshot(user.id).ended).toBe("blocked");
    expect(events).toContainEqual({
      type: "group.chain-ended",
      groupId: group.id,
      chainId: user.id,
      reason: "blocked",
    });
    // Alpha's prompt is still pending, but its slot went to Gamma (other chain).
    expect(runtime.pendingSessions()).toEqual([alpha, beta, gamma]);
    expect(groups.chainSnapshot(other.id).ended).toBeUndefined();
    expect(events.filter((e) => e.type === "group.activity").at(-1)).toMatchObject({
      runningSessionIds: [beta, gamma],
    });
    // Beta's in-flight turn in the ended chain posts but wakes nobody.
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Done, @Gamma verify" });
    await flush();
    expect(room(group.id).find((m) => m.body === "Done, @Gamma verify")?.chainId).toBe(user.id);
    // The explicit mention arrived while Beta was busy and now runs after its active turn.
    expect(runtime.pendingSessions()).toEqual([alpha, gamma, beta]);
    expect(
      room(group.id).find(
        (message) => message.chainId === later.id && message.authorSessionId === beta,
      ),
    ).toMatchObject({ authorKind: "agent", authorSessionId: beta, status: "running" });
    expect(runtime.calls.at(-1)?.input.message).toContain("@Beta later");
    expect(groups.isAwaitingUser(alpha)).toBe(false);
  });

  it("Proceed: the turn ends ok and posts its result, waking nobody", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "delete prod" });
    const card = room(group.id)[1];
    runtime.openGate(alpha);
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "Deleted. @Beta please verify" });
    await flush();
    expect(room(group.id).at(-1)).toMatchObject({
      authorSessionId: alpha,
      kind: "message",
      body: "Deleted. @Beta please verify",
      chainId: user.id,
      id: card?.id,
      status: "completed",
    });
    expect(room(group.id)).toHaveLength(2);
    expect(runtime.pendingSessions()).toEqual([]);
    expect(groups.isAwaitingUser(alpha)).toBe(false);
    expect(groups.liveChainIds()).toEqual([]);
    // The user opens a new chain from the room.
    groups.postUserMessage({ groupId: group.id, body: "@Beta verify" });
    expect(runtime.pendingSessions()).toHaveLength(1);
  });

  it("refusal cancels the same canonical card with nobody awaiting", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "delete prod" });
    const card = room(group.id)[1];
    runtime.openGate(alpha);
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();
    expect(room(group.id)).toHaveLength(2);
    expect(room(group.id)[1]).toMatchObject({
      id: card?.id,
      kind: "message",
      body: "",
      status: "cancelled",
    });
    expect(room(group.id).at(-1)?.chainId).toBe(user.id);
    expect(groups.isAwaitingUser(alpha)).toBe(false);
    expect(runtime.pendingSessions()).toEqual([]);
  });

  it("ignores gate questions on sessions without a group turn", () => {
    const { group, beta } = squad();
    const { runtime, groups } = setup();
    runtime.openGate(beta);
    expect(room(group.id)).toHaveLength(0);
    expect(groups.isAwaitingUser(beta)).toBe(false);
  });
});

/* ── HyperPlan: a turn ending with a plan choice pending is blocked; plan-build unblocks ── */

describe("HyperPlan-blocked member", () => {
  it("ends the chain: another member's in-flight reply posts but wakes nobody; queued wakes drop", async () => {
    const { group, alpha, beta, gamma } = squad();
    const { reserveHyperPlanSession } = await import("../agent/harness/hyperplan-draft-store");
    expect(reserveHyperPlanSession({ sessionId: alpha, ownerId: 1 })).toBe(true);
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta @Gamma go" });
    // Two run (concurrency 2), Gamma waits in the queue.
    expect(runtime.pendingSessions()).toEqual([alpha, beta]);
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();
    expect(groups.chainSnapshot(user.id).ended).toBe("blocked");
    expect(groups.isAwaitingUser(alpha)).toBe(true);
    // Gamma's queued wake was dropped: it never starts.
    expect(runtime.pendingSessions()).toEqual([beta]);
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Done, @Gamma please verify" });
    await flush();
    expect(room(group.id).find((message) => message.authorSessionId === beta)).toMatchObject({
      authorSessionId: beta,
      body: "Done, @Gamma please verify",
      chainId: user.id,
      status: "completed",
    });
    expect(room(group.id).find((message) => message.authorSessionId === gamma)).toMatchObject({
      body: "",
      status: "cancelled",
    });
    expect(runtime.pendingSessions()).toEqual([]);
    expect(runtime.started).not.toContain(gamma);
    expect(groups.isGroupWorking(group.id)).toBe(false);
  });

  it("a successful plan-build resets counters without dispatching public mentions; explicit handoff still wakes", async () => {
    const { group, alpha, beta } = squad();
    const { reserveHyperPlanSession } = await import("../agent/harness/hyperplan-draft-store");
    expect(reserveHyperPlanSession({ sessionId: alpha, ownerId: 1 })).toBe(true);
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "plan the migration" });
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();

    // The user picks the plan build in Alpha's chat: a turn the group did not start.
    runtime.settle({
      sessionId: alpha,
      origin: "plan-build",
      result: { outcome: "ok", finalText: "Built. @Beta please verify" },
    });
    const root = room(group.id).at(-1);
    expect(root).toMatchObject({ authorSessionId: alpha, kind: "message" });
    expect(root?.chainId).toBe(root?.id);
    expect(root?.chainId).not.toBe(user.id);
    // The released result is a completed publication; public mentions do not add a hop.
    expect(groups.chainSnapshot(root?.id ?? "")).toMatchObject({
      hops: 1,
      agentMessages: 1,
      wakesByMember: {},
    });
    expect(groups.chainSnapshot(root?.id ?? "").ended).toBeUndefined();
    expect(groups.isAwaitingUser(alpha)).toBe(false);
    expect(runtime.pendingSessions()).toEqual([]);
    expect(groups.liveChainIds()).toEqual([]);
    const handoff = groups.handleTaskWake({
      groupId: group.id,
      actorSessionId: alpha,
      targetSessionId: beta,
      body: "Verify the built migration",
    });
    expect(runtime.pendingSessions()).toEqual([beta]);
    expect(groups.chainSnapshot(handoff?.id ?? "")).toMatchObject({
      hops: 1,
      wakesByMember: { [beta]: 1 },
    });
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Verified." });
    await flush();
    expect(room(group.id).at(-1)).toMatchObject({
      authorSessionId: beta,
      chainId: handoff?.id,
      status: "completed",
    });
  });

  it("only an ok plan-build unblocks: failed, aborted and plain prompts do not", async () => {
    const { group, alpha } = squad();
    const { reserveHyperPlanSession } = await import("../agent/harness/hyperplan-draft-store");
    expect(reserveHyperPlanSession({ sessionId: alpha, ownerId: 1 })).toBe(true);
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "plan it" });
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();
    const before = room(group.id).length;
    for (const event of [
      { sessionId: alpha, origin: "plan-build", result: { outcome: "failed" } },
      { sessionId: alpha, origin: "plan-build", result: { outcome: "aborted" } },
      { sessionId: alpha, origin: "prompt", result: { outcome: "ok", finalText: "hi" } },
    ] satisfies TurnSettledEvent[]) {
      runtime.settle(event);
    }
    expect(room(group.id)).toHaveLength(before);
    expect(groups.isAwaitingUser(alpha)).toBe(true);
    expect(groups.liveChainIds()).toEqual([]);
  });

  it("ignores settled turns of members that are not waiting, and the group's own turns", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    runtime.settle({
      sessionId: beta,
      origin: "plan-build",
      result: { outcome: "ok", finalText: "x" },
    });
    groups.postUserMessage({ groupId: group.id, body: "go" });
    runtime.settle({
      sessionId: alpha,
      origin: "plan-build",
      result: { outcome: "ok", finalText: "x" },
    });
    expect(room(group.id)).toHaveLength(2);
    expect(room(group.id)[1]).toMatchObject({
      authorSessionId: alpha,
      body: "",
      status: "running",
    });
    runtime.take(alpha).resolve({ outcome: "ok" });
    await flush();
  });
});

/* ── N4 proactive resume / review + interrupt ─────────────────────────── */

describe("structured task follow-ups", () => {
  it("silence with an owned in_progress task leaves its owner idle until explicitly delegated", async () => {
    const { group, alpha, beta } = squad();
    const task = createMemberGroupTask({
      groupId: group.id,
      actorSessionId: alpha,
      title: "Parser",
    });
    claimGroupTask(group.id, task.id, alpha);
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Beta draft something" });
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Draft parked." });
    await flush();
    expect(room(group.id).at(-1)).toMatchObject({
      kind: "message",
      body: "Draft parked.",
      status: "completed",
    });
    expect(room(group.id)).toHaveLength(2);
    expect(listGroupTasks(group.id)).toEqual([
      expect.objectContaining({ id: task.id, status: "in_progress", ownerSessionId: alpha }),
    ]);
    expect(runtime.pendingSessions()).toEqual([]);
    expect(runtime.started).toEqual([beta]);
  });

  it("an explicit task review request wakes the assigned reviewer once", async () => {
    const { group, alpha, beta, gamma } = squad();
    const task = createMemberGroupTask({
      groupId: group.id,
      actorSessionId: alpha,
      title: "Toggle",
      reviewerSessionId: gamma,
    });
    claimGroupTask(group.id, task.id, alpha);
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Alpha finish it" });
    setGroupTaskWakeSink((wake) => groups.handleTaskWake(wake));
    try {
      runGroupTool(
        "group_request_review",
        { sessionId: alpha, groupId: group.id },
        { id: task.id, reviewer: gamma },
      );
    } finally {
      setGroupTaskWakeSink(undefined);
    }
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "Looks good.\nAgreed" });
    await flush();
    expect(room(group.id).find((message) => message.kind === "status")).toMatchObject({
      kind: "status",
      authorSessionId: alpha,
      body: `Review requested: "Toggle" (task ${task.id}) @Gamma`,
      mentions: [gamma],
    });
    expect(listGroupTasks(group.id)).toEqual([
      expect.objectContaining({ id: task.id, status: "in_review", reviewerSessionId: gamma }),
    ]);
    expect(room(group.id).at(-1)).toMatchObject({
      authorSessionId: gamma,
      status: "running",
      body: "",
    });
    expect(runtime.started).toEqual([alpha, gamma]);
    expect(runtime.pendingSessions()).toEqual([gamma]);
    expect(runtime.pendingSessions()).not.toContain(beta);
  });

  it("Ready for you does not proactive-wake peers (interrupt the user)", async () => {
    const { group, alpha, beta } = squad();
    const task = createMemberGroupTask({
      groupId: group.id,
      actorSessionId: alpha,
      title: "Secret",
    });
    claimGroupTask(group.id, task.id, alpha);
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Beta check the key" });
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Ready for you" });
    await flush();
    expect(runtime.pendingSessions()).toEqual([]);
    expect(room(group.id).some((m) => m.body.startsWith("Resume:"))).toBe(false);
    expect(room(group.id).at(-1)).toMatchObject({
      authorSessionId: beta,
      body: "Ready for you",
    });
  });
});

/* ── Edit agent model applies on the next wake ───────────────────────── */

describe("group turns preserve each member's selected model", () => {
  afterEach(() => setGroupTurnModelResolver(undefined));

  it("a Modus agent and an own-provider agent run their exact selected models", async () => {
    setGroupTurnModelResolver((agentModelId, _sessionId) =>
      resolveTurnModel(agentModelId, {
        defaultModelId: () => "openai/gpt-5",
        isUsable: () => true,
      }),
    );
    const group = createGroupWithNewAgents({
      name: uid("ModusGroup"),
      workspaceId: insertWorkspace(),
      members: [
        { name: "Planner", role: "Lead", modelId: "modus/anthropic/claude-fable-5-1" },
        { name: "Builder", role: "Builder", modelId: "anthropic/claude-opus-5-5" },
      ],
    });
    const planner = group.members.find((member) => member.name === "Planner");
    const builder = group.members.find((member) => member.name === "Builder");
    const { runtime, groups } = setup();

    groups.postUserMessage({ groupId: group.id, body: "@Planner plan it" });
    expect(runtime.calls[0]?.input).toMatchObject({
      sessionId: planner?.sessionId,
      model: "modus/anthropic/claude-fable-5-1",
    });
    runtime.take(planner?.sessionId ?? "").resolve({ outcome: "ok", finalText: "Plan ready." });
    await flush();

    groups.postUserMessage({ groupId: group.id, body: "@Builder build it" });
    expect(runtime.calls[0]?.input).toMatchObject({
      sessionId: builder?.sessionId,
      model: "anthropic/claude-opus-5-5",
    });
  });

  it("forwards the app-default directive to a group member with no model", () => {
    setGroupTurnModelResolver(() => null);
    const { group, beta } = squad();
    const { runtime, groups } = setup();

    groups.postUserMessage({ groupId: group.id, body: "@Beta take a look" });

    expect(runtime.calls[0]?.input).toMatchObject({ sessionId: beta, model: null });
  });

  it("does not wake a group member with an unavailable explicit model", async () => {
    const selectedModel = "byok/removed-model";
    const defaultModelId = vi.fn(() => "openai/available-default");
    setGroupTurnModelResolver((agentModelId) =>
      resolveTurnModel(agentModelId, {
        defaultModelId,
        isUsable: (modelId) => modelId !== selectedModel,
      }),
    );
    const group = createGroupWithNewAgents({
      name: uid("UnavailableModelGroup"),
      workspaceId: insertWorkspace(),
      members: [
        { name: "Planner", role: "Lead", modelId: selectedModel },
        { name: "Builder", role: "Builder", modelId: "openai/available-default" },
      ],
    });
    const { runtime, groups } = setup();

    groups.postUserMessage({ groupId: group.id, body: "@Planner plan it" });
    await flush();

    expect(runtime.calls).toHaveLength(0);
    expect(defaultModelId).not.toHaveBeenCalled();
    expect(
      room(group.id).some(
        (message) => message.error === `Selected model is unavailable: ${selectedModel}`,
      ),
    ).toBe(true);
  });
});

describe("Edit agent model applies on next wake", () => {
  it("passes the agent modelId on wake, and uses the new model after Save", async () => {
    const firstModel = "openai/gpt-5";
    const nextModel = "openai/gpt-6-luna";
    const group = createGroupWithNewAgents({
      name: uid("ModelGroup"),
      workspaceId: insertWorkspace(),
      members: [
        { name: "Planner", role: "Lead", modelId: firstModel },
        { name: "Builder", role: "Builder", modelId: firstModel },
      ],
    });
    const planner = group.members.find((member) => member.name === "Planner");
    expect(planner).toBeDefined();
    const { runtime, groups } = setup();

    groups.postUserMessage({ groupId: group.id, body: "@Planner plan it" });
    expect(runtime.calls[0]?.input).toMatchObject({
      sessionId: planner?.sessionId,
      model: firstModel,
      delivery: "normal",
    });
    runtime.take(planner?.sessionId ?? "").resolve({ outcome: "ok", finalText: "Plan ready." });
    await flush();

    updateAgent(planner?.agentId ?? "", { modelId: nextModel });
    groups.postUserMessage({ groupId: group.id, body: "@Planner continue" });
    expect(runtime.calls[0]?.input).toMatchObject({
      sessionId: planner?.sessionId,
      model: nextModel,
      delivery: "normal",
    });
  });
});
