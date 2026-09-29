import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GroupRuntimeEvent } from "../../shared/contracts";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase } = await import("../db/database");
const { ensureChatsWorkspace } = await import("../workspace/workspace-store");
const {
  createAgentGroupWithMembers,
  listGroupMessages,
  recordGroupDecision,
  removeAgentGroupMember,
} = await import("./group-store");
const {
  ESTIMATED_CONTEXT_TOKENS_PER_WAKE,
  ESTIMATED_INPUT_TOKENS_PER_CHAIN,
  GROUP_CHAIN_LIMITS,
  GROUP_MAX_CONCURRENT_TURNS,
  GROUP_PROMPT_DECISIONS_MAX_ITEMS,
  GROUP_PROMPT_DECISIONS_MAX_TOKENS,
  GROUP_STATUS_TEXT,
  GroupRuntime,
  composeGroupDecisionsSection,
  composeGroupWakePrompt,
  estimateGroupTokens,
  isUpdatePendingState,
  parseGroupMentions,
} = await import("./group-runtime");
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

describe("group runtime constants", () => {
  it("exports the agreed chain limits and concurrency", () => {
    expect(GROUP_CHAIN_LIMITS).toEqual({
      maxHops: 6,
      maxAgentMessages: 20,
      maxWakesPerMember: 3,
      maxEstimatedInputTokens: 150_000,
      maxEstimatedContextTokensPerWake: 8_000,
    });
    expect(ESTIMATED_INPUT_TOKENS_PER_CHAIN).toBe(150_000);
    expect(ESTIMATED_CONTEXT_TOKENS_PER_WAKE).toBe(8_000);
    expect(GROUP_MAX_CONCURRENT_TURNS).toBe(2);
    expect(GROUP_STATUS_TEXT.waitingForYou).toBe("Waiting for you");
    expect(GROUP_STATUS_TEXT.limit["input-token-budget"]).toContain("estimated 150k-token budget");
    expect(GROUP_STATUS_TEXT.limit["context-too-large"]).toContain("estimated 8k-token");
    // chars / 4
    expect(estimateGroupTokens("x".repeat(401))).toBe(101);
  });
});

/* ── turn outcomes through the fake runtime (the 4 contract cases) ───── */

describe("turn outcomes (fake runtime contract)", () => {
  it("ok with text posts the reply as the member, in the same chain", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "status?" });
    expect(runtime.pendingSessions()).toEqual([alpha]);
    expect(runtime.calls[0]?.input.delivery).toBe("normal");
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
    });
  });

  it("ok without text posts nothing", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "status?" });
    runtime.take(alpha).resolve({ outcome: "ok" });
    await flush();
    expect(room(group.id)).toHaveLength(1);
    expect(groups.isGroupWorking(group.id)).toBe(false);
  });

  it("failed (and a thrown prompt) posts a status and counts as a hop", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta go" });
    runtime.take(alpha).resolve({ outcome: "failed" });
    runtime.take(beta).reject(new Error("boom"));
    await flush();
    const statuses = room(group.id).filter((m) => m.kind === "status");
    expect(statuses.map((m) => [m.authorSessionId, m.body])).toEqual([
      [alpha, GROUP_STATUS_TEXT.failed],
      [beta, GROUP_STATUS_TEXT.failed],
    ]);
    expect(groups.chainSnapshot(user.id).hops).toBe(2);
  });

  it("aborted posts its own status", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "go" });
    runtime.take(alpha).resolve({ outcome: "aborted" });
    await flush();
    expect(room(group.id).at(-1)).toMatchObject({ kind: "status", body: "Turn stopped" });
  });

  it('blocked (HyperPlan choice pending) posts "Waiting for you" as the member and ends the chain', async () => {
    const { group, alpha } = squad();
    const { runtime, groups, events } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "delete prod" });
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();
    expect(room(group.id).at(-1)).toMatchObject({
      authorKind: "agent",
      authorSessionId: alpha,
      kind: "status",
      body: "Waiting for you",
      chainId: user.id,
    });
    expect(groups.chainSnapshot(user.id)).toMatchObject({ hops: 1, ended: "blocked" });
    expect(groups.isAwaitingUser(alpha)).toBe(true);
    expect(events).toContainEqual({
      type: "group.chain-ended",
      groupId: group.id,
      chainId: user.id,
      reason: "blocked",
    });
  });
});

/* ── wake rules ───────────────────────────────────────────────────────── */

describe("wake rules", () => {
  it("a user message without mentions wakes only the lead", () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "hello team" });
    expect(runtime.pendingSessions()).toEqual([alpha]);
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

  it("a self-mention does not wake the author", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "go" });
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "@Alpha will do it, @Beta review" });
    await flush();
    expect(runtime.pendingSessions()).toEqual([beta]);
  });

  it("a reply does not wake the replied-to author unless mentioned", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "go" });
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "Done." });
    await flush();
    const lead = room(group.id).at(-1);
    // The user replies to the lead's message without mentioning it: nobody wakes.
    groups.postUserMessage({
      groupId: group.id,
      body: "thanks",
      replyToMessageId: lead?.id ?? "",
    });
    expect(runtime.pendingSessions()).toEqual([]);
    // Mentioning the author does wake it.
    groups.postUserMessage({
      groupId: group.id,
      body: "@Alpha one more",
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
    const message = groups.postUserMessage({ groupId: group.id, body: "@Tester run it" });
    expect(message.mentions).toEqual([one, two]);
    expect(runtime.pendingSessions()).toEqual([one, two]);
  });
});

/* ── chain ids, persistence ──────────────────────────────────────────── */

describe("chains", () => {
  it("each user message opens a new chain; agent replies inherit it (mentions_json persisted)", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    const first = groups.postUserMessage({ groupId: group.id, body: "go" });
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "@Beta your turn" });
    await flush();
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Done." });
    await flush();
    const second = groups.postUserMessage({ groupId: group.id, body: "again" });
    const messages = room(group.id);
    expect(messages.map((m) => m.chainId)).toEqual([first.id, first.id, first.id, second.id]);
    expect(messages[1]?.mentions).toEqual([beta]);
    expect(second.chainId).toBe(second.id);
    expect(groups.chainSnapshot(second.id).hops).toBe(1);
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
    const ctx = setup({ limits });
    const user = ctx.groups.postUserMessage({ groupId: fixture.group.id, body: "start" });
    let current = fixture.alpha;
    for (let turn = 0; turn < turns; turn += 1) {
      if (!ctx.runtime.pendingSessions().includes(current)) break;
      const next = current === fixture.alpha ? "Beta" : "Alpha";
      ctx.runtime.take(current).resolve({ outcome: "ok", finalText: `over to @${next}` });
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
    const last = room(groupId).at(-1);
    expect(last).toMatchObject({ authorKind: "system", kind: "status", chainId });
    expect(last?.body).toBe((GROUP_STATUS_TEXT.limit as Record<string, string>)[reason]);
    expect(last?.body.startsWith("Waiting for you")).toBe(true);
    expect(runtime.pendingSessions()).toEqual([]);
  }

  it(`stops after ${GROUP_CHAIN_LIMITS.maxHops} hops`, async () => {
    const { group, user, runtime, groups } = await pingPong({ maxWakesPerMember: 99 }, 20);
    expect(groups.chainSnapshot(user.id)).toMatchObject({ hops: 6, ended: "max-hops" });
    expectStopped(group.id, user.id, "max-hops", runtime);
  });

  it(`stops at ${GROUP_CHAIN_LIMITS.maxWakesPerMember} wakes per member`, async () => {
    const { group, user, runtime, groups } = await pingPong({ maxHops: 99 }, 20);
    // Alpha: 3 wakes (1 by the user + 2 hand-offs), then Beta's 3rd hand-off is refused.
    expect(groups.chainSnapshot(user.id)).toMatchObject({ ended: "max-member-wakes" });
    expectStopped(group.id, user.id, "max-member-wakes", runtime);
  });

  it("stops at the agent-message limit", async () => {
    const { group, user, runtime, groups } = await pingPong(
      { maxAgentMessages: 2, maxWakesPerMember: 99, maxHops: 99 },
      20,
    );
    expect(groups.chainSnapshot(user.id)).toMatchObject({
      agentMessages: 2,
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

  it("a limit drops the chain's queued wakes; a running turn posts but wakes nobody", async () => {
    const { group, alpha, beta, gamma } = squad();
    const { runtime, groups } = setup({ limits: { maxHops: 4 } });
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta @Gamma go" });
    // Hops 1-3 admitted; Alpha and Beta run, Gamma is queued.
    expect(runtime.pendingSessions()).toEqual([alpha, beta]);
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "@Beta then @Gamma" });
    await flush();
    // Beta's 2nd wake is hop 4 (queued behind its running turn); Gamma's would be hop 5.
    const snapshot = groups.chainSnapshot(user.id);
    expect(snapshot).toMatchObject({ hops: 4, ended: "max-hops" });
    // Gamma's first wake and Beta's second were both queued: discarded.
    expect(runtime.pendingSessions()).toEqual([beta]);
    expect(groups.isGroupWorking(group.id)).toBe(true);
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Done, @Alpha @Gamma look" });
    await flush();
    expect(room(group.id).at(-1)).toMatchObject({ authorSessionId: beta, chainId: user.id });
    expect(runtime.pendingSessions()).toEqual([]);
    expect(runtime.started).toEqual([alpha, beta]);
    expect(runtime.started).not.toContain(gamma);
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
    expect(prompt).toContain("@Alpha (lead), @Beta (you)");
    expect(prompt).toContain("[user] start");
    expect(prompt).toContain('<group_message from="@Alpha">\n@Beta &lt;check&gt;');
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

  it("lists decisions newest first with their author, escaped", () => {
    const section = composeGroupDecisionsSection(
      [decision("3", "Use <WAL>", "a"), decision("2", "Ship weekly"), decision("1", "Old", "b")],
      titles,
    );
    expect(section).toBe(
      [
        "<group_decisions>",
        "Group decisions (newest first; the group agreed on these, keep to them):",
        "- Use &lt;WAL&gt; (@Alpha)",
        "- Ship weekly (user)",
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
      expect(prompt).toContain("- Ship weekly (user)\n- Use SQLite (@Alpha)\n</group_decisions>");
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

/* ── intent gate: the question opens inside prompt(); the slot is released ── */

describe("intent gate on a group turn", () => {
  it("frees the slot, posts Waiting for you and ends the chain (queued wakes drop)", async () => {
    const { group, alpha, beta, gamma } = squad();
    const { runtime, groups, events } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta go" });
    // A second chain queues Gamma behind the two running turns.
    const other = groups.postUserMessage({ groupId: group.id, body: "@Gamma also" });
    groups.postUserMessage({ groupId: group.id, body: "@Beta later" });
    expect(runtime.pendingSessions()).toEqual([alpha, beta]);

    runtime.openGate(alpha);
    expect(room(group.id).find((m) => m.kind === "status")).toMatchObject({
      authorKind: "agent",
      authorSessionId: alpha,
      body: "Waiting for you",
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
    // Only the other chain's "@Beta later" wake starts; nothing from the ended chain.
    expect(runtime.pendingSessions()).toEqual([alpha, gamma, beta]);
    expect(groups.isAwaitingUser(alpha)).toBe(false);
  });

  it("Proceed: the turn ends ok and posts its result, waking nobody", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "delete prod" });
    runtime.openGate(alpha);
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "Deleted. @Beta please verify" });
    await flush();
    expect(room(group.id).at(-1)).toMatchObject({
      authorSessionId: alpha,
      kind: "message",
      body: "Deleted. @Beta please verify",
      chainId: user.id,
    });
    expect(runtime.pendingSessions()).toEqual([]);
    expect(groups.isAwaitingUser(alpha)).toBe(false);
    expect(groups.liveChainIds()).toEqual([]);
    // The user opens a new chain from the room.
    groups.postUserMessage({ groupId: group.id, body: "@Beta verify" });
    expect(runtime.pendingSessions()).toHaveLength(1);
  });

  it('refusal (Cancel / skip → blocked) posts "Turn stopped", with nobody awaiting', async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "delete prod" });
    runtime.openGate(alpha);
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();
    expect(room(group.id).map((m) => [m.kind, m.body])).toEqual([
      ["message", "delete prod"],
      ["status", "Waiting for you"],
      ["status", "Turn stopped"],
    ]);
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
    expect(room(group.id).at(-1)).toMatchObject({
      authorSessionId: beta,
      body: "Done, @Gamma please verify",
      chainId: user.id,
    });
    expect(runtime.pendingSessions()).toEqual([]);
    expect(runtime.started).not.toContain(gamma);
    expect(groups.isGroupWorking(group.id)).toBe(false);
  });

  it("a successful plan-build opens a new chain with reset counters; the result follows the wake rules", async () => {
    const { group, alpha, beta } = squad();
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
    // Hop 1 is Alpha's released result; hop 2 the wake it caused.
    expect(groups.chainSnapshot(root?.id ?? "")).toMatchObject({
      hops: 2,
      agentMessages: 1,
      wakesByMember: { [beta]: 1 },
    });
    expect(groups.chainSnapshot(root?.id ?? "").ended).toBeUndefined();
    expect(groups.isAwaitingUser(alpha)).toBe(false);
    expect(runtime.pendingSessions()).toEqual([beta]);
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Verified." });
    await flush();
    expect(room(group.id).at(-1)).toMatchObject({ authorSessionId: beta, chainId: root?.id });
  });

  it("only an ok plan-build unblocks: failed, aborted and plain prompts do not", async () => {
    const { group, alpha } = squad();
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
    expect(room(group.id)).toHaveLength(1);
    runtime.take(alpha).resolve({ outcome: "ok" });
    await flush();
  });
});

/* ── dispose: runtime subscriptions are released ─────────────────────── */

describe("dispose", () => {
  it("unsubscribes: a later ok plan-build or gate question does nothing", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups, events } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta go" });
    // Alpha ends with a HyperPlan choice pending; Beta's group turn keeps running.
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
    expect(groups.liveChainIds()).toEqual([user.id]);
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
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "@Beta you" });
    await flush();
    // Still live: Beta's wake runs in it.
    expect(groups.liveChainIds()).toEqual([first.id]);
    runtime.take(beta).resolve({ outcome: "ok", finalText: "Done." });
    await flush();
    expect(groups.liveChainIds()).toEqual([]);
    // Counters stay readable for a while after retirement.
    expect(groups.chainSnapshot(first.id).hops).toBe(2);

    // An ended chain with a running turn stays until that turn settles.
    const second = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta go" });
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();
    expect(groups.liveChainIds()).toEqual([second.id]);
    runtime.take(beta).resolve({ outcome: "ok" });
    await flush();
    expect(groups.liveChainIds()).toEqual([]);

    // A message that wakes nobody (a reply to the lead, no mention) never keeps a chain.
    const leadStatus = room(group.id).findLast((m) => m.authorSessionId === alpha);
    groups.postUserMessage({
      groupId: group.id,
      body: "ok",
      replyToMessageId: leadStatus?.id ?? "",
    });
    expect(runtime.pendingSessions()).toEqual([]);
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
    removeAgentGroupMember(group.id, alpha);
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "late" });
    await flush();
    expect(room(group.id)).toHaveLength(1);
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
    const first = runtime.take(alpha);

    expect(groups.handleWorktreeReady(ready(group.id, alpha))).toBe(true);
    first.resolve({ outcome: "ok", finalText: "Starting my worktree." });
    await flush();

    const after = room(group.id).slice(1);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      authorKind: "agent",
      authorSessionId: alpha,
      kind: "status",
      body: `Worktree ready: \`group/${group.id}/alpha\``,
      chainId: user.id,
      mentions: [],
    });
    expect(after.some((message) => message.body === GROUP_STATUS_TEXT.aborted)).toBe(false);
    // Same member, same chain, same trigger: the prompt is rebuilt from the user message.
    expect(runtime.pendingSessions()).toEqual([alpha]);
    expect(runtime.calls[0]?.input.message).toBe(first.input.message);
    expect(groups.chainSnapshot(user.id)).toMatchObject({
      hops: 2,
      wakesByMember: { [alpha]: 2 },
    });
    // The re-woken turn is an ordinary group turn: its reply posts and routes.
    runtime.take(alpha).resolve({ outcome: "ok", finalText: "Done in my worktree." });
    await flush();
    expect(room(group.id).at(-1)).toMatchObject({
      authorSessionId: alpha,
      kind: "message",
      body: "Done in my worktree.",
      chainId: user.id,
    });
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
      `Worktree ready: \`group/${group.id}/alpha\``,
      GROUP_STATUS_TEXT.limit["max-hops"],
    ]);
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

  it("a user stop (aborted) keeps the normal Turn stopped status and no re-wake", async () => {
    const { group, alpha } = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "go" });
    groups.handleWorktreeReady(ready(group.id, alpha));
    runtime.take(alpha).resolve({ outcome: "aborted" });
    await flush();
    expect(room(group.id).at(-1)?.body).toBe(GROUP_STATUS_TEXT.aborted);
    expect(runtime.pendingSessions()).toEqual([]);
  });
});

/* ── Stop and member states (room UI) ──────────────────────────────────── */

describe("stopGroup (room Stop button)", () => {
  it('ends the chain, drops queued wakes and aborts running turns, which post "Turn stopped"', async () => {
    const { group, alpha, beta, gamma } = squad();
    const { runtime, groups, events } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta @Gamma go" });
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
      ["agent", alpha, "Turn stopped"],
      ["agent", beta, "Turn stopped"],
    ]);
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

  it("leaves other groups and turns waiting at the intent gate alone", async () => {
    const { group, alpha, beta } = squad();
    const other = squad();
    const { runtime, groups } = setup();
    groups.postUserMessage({ groupId: group.id, body: "@Alpha go" });
    runtime.openGate(alpha);
    groups.postUserMessage({ groupId: other.group.id, body: "@Beta go" });
    const before = room(group.id).length;
    groups.stopGroup(group.id);
    expect(runtime.aborted).toEqual([]);
    expect(runtime.pendingSessions()).toEqual([alpha, other.beta]);
    // Nothing ran or waited in the queue: no "Stopped by you".
    expect(room(group.id)).toHaveLength(before);
    expect(room(other.group.id).some((m) => m.body === "Stopped by you")).toBe(false);
    expect(groups.isAwaitingUser(beta)).toBe(false);
    expect(groups.memberStates().find((s) => s.groupId === group.id)?.waitingSessionIds).toEqual([
      alpha,
    ]);
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
