import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GroupRuntimeEvent } from "../../shared/contracts";

let userData: string;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase } = await import("../db/database");
const { ensureChatsWorkspace } = await import("../workspace/workspace-store");
const { createAgentGroupWithMembers, listGroupMessages, removeAgentGroupMember } = await import(
  "./group-store"
);
const {
  GROUP_CHAIN_LIMITS,
  GROUP_MAX_CONCURRENT_TURNS,
  GROUP_STATUS_TEXT,
  GroupRuntime,
  composeGroupWakePrompt,
  estimateGroupTokens,
  parseGroupMentions,
} = await import("./group-runtime");
type PromptTurnResult = import("../agent/runtime").PromptTurnResult;
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
  prompt(_window: unknown, input: PromptAgentInput): Promise<PromptTurnResult> {
    this.started.push(input.sessionId);
    return new Promise((resolve, reject) => this.calls.push({ input, resolve, reject }));
  }
  isSessionStreaming(sessionId: string): boolean {
    return this.streaming.has(sessionId);
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
      maxInputTokens: 150_000,
      maxContextTokensPerWake: 8_000,
    });
    expect(GROUP_MAX_CONCURRENT_TURNS).toBe(2);
    expect(GROUP_STATUS_TEXT.waitingForYou).toBe("Waiting for you");
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

  it('blocked posts "Waiting for you" on behalf of the member and ends the chain', async () => {
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
    const ctx = setup({ limits: { maxInputTokens: 10 } });
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
        GROUP_CHAIN_LIMITS.maxContextTokensPerWake,
      );
    }
    const huge = ctx.groups.postUserMessage({ groupId: group.id, body: "y".repeat(40_000) });
    expect(ctx.runtime.pendingSessions().filter((id) => id === alpha)).toHaveLength(0);
    expect(ctx.groups.chainSnapshot(huge.id).ended).toBe("context-too-large");
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

/* ── blocked: ends the chain; the in-flight turn wakes nobody; unblocking opens a new chain ── */

describe("blocked member", () => {
  it("ends the chain: another member's in-flight reply posts but wakes nobody; queued wakes drop", async () => {
    const { group, alpha, beta, gamma } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "@Alpha @Beta @Gamma go" });
    // Two run (concurrency 2), Gamma waits in the queue.
    expect(runtime.pendingSessions()).toEqual([alpha, beta]);
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();
    expect(groups.chainSnapshot(user.id).ended).toBe("blocked");
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

  it("unblocking opens a new chain with reset counters; the result follows the wake rules", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    const user = groups.postUserMessage({ groupId: group.id, body: "delete prod" });
    runtime.take(alpha).resolve({ outcome: "blocked" });
    await flush();

    // The user answers the gate in Alpha's own chat: a turn the group did not start.
    groups.handleTurnSettled({
      sessionId: alpha,
      origin: "prompt",
      result: { outcome: "ok", finalText: "Confirmed and done. @Beta please verify" },
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

  it("ignores settled turns of members that are not waiting, and the group's own turns", async () => {
    const { group, alpha, beta } = squad();
    const { runtime, groups } = setup();
    groups.handleTurnSettled({
      sessionId: beta,
      origin: "prompt",
      result: { outcome: "ok", finalText: "x" },
    });
    groups.postUserMessage({ groupId: group.id, body: "go" });
    groups.handleTurnSettled({
      sessionId: alpha,
      origin: "prompt",
      result: { outcome: "ok", finalText: "x" },
    });
    expect(room(group.id)).toHaveLength(1);
    runtime.take(alpha).resolve({ outcome: "ok" });
    await flush();
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
