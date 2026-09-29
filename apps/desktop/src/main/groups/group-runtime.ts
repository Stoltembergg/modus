import type { BrowserWindow as BrowserWindowType } from "electron";
import type {
  AgentGroupInfo,
  GroupChainEndReason,
  GroupMessage,
  GroupRuntimeEvent,
  PostGroupMessageInput,
} from "../../shared/contracts";
import { getAgentSession } from "../agent/agent-store";
import type {
  PromptAgentInput,
  PromptTurnOutcome,
  PromptTurnResult,
  TurnSettledEvent,
} from "../agent/runtime";
import {
  appendGroupMessage,
  getAgentGroup,
  getAgentGroupForSession,
  getGroupMessage,
  listAgentGroupMembers,
  listGroupMessages,
} from "./group-store";

/**
 * Agent Groups runtime (PR 3): routes room messages to member sessions as
 * ordinary `normal` prompts and posts their replies back into the room.
 *
 * A *chain* is everything that follows one user action (a user message, or the
 * user unblocking a member). Every limit below is per chain; hitting one posts
 * a "Waiting for you: …" status and stops the chain until the user acts again.
 */
export const GROUP_CHAIN_LIMITS = {
  /** Member turns per chain (every woken turn, and an unblocked member's result, is one hop). */
  maxHops: 6,
  /** Agent messages posted per chain. */
  maxAgentMessages: 20,
  /** Times the same member is woken per chain. */
  maxWakesPerMember: 3,
  /** Estimated input tokens of all wake prompts in a chain. */
  maxInputTokens: 150_000,
  /** Estimated tokens of group context (room history + trigger) in one wake prompt. */
  maxContextTokensPerWake: 8_000,
} as const;

export type GroupChainLimits = { [K in keyof typeof GROUP_CHAIN_LIMITS]: number };

/** At most this many members run a group turn at once. */
export const GROUP_MAX_CONCURRENT_TURNS = 2;

/** Status texts posted into the room (English, like the rest of the app's statuses). */
export const GROUP_STATUS_TEXT = {
  /** A member's turn stopped at the intent gate / a HyperPlan choice. */
  waitingForYou: "Waiting for you",
  failed: "Turn failed",
  aborted: "Turn stopped",
  limit: {
    "max-hops": `Waiting for you: this chain reached its limit of ${GROUP_CHAIN_LIMITS.maxHops} turns.`,
    "max-agent-messages": `Waiting for you: this chain reached its limit of ${GROUP_CHAIN_LIMITS.maxAgentMessages} agent messages.`,
    "max-member-wakes": `Waiting for you: a member was already woken ${GROUP_CHAIN_LIMITS.maxWakesPerMember} times in this chain.`,
    "input-token-budget": `Waiting for you: this chain used its ${GROUP_CHAIN_LIMITS.maxInputTokens / 1000}k-token input budget.`,
    "context-too-large": `Waiting for you: the message does not fit the ${GROUP_CHAIN_LIMITS.maxContextTokensPerWake / 1000}k-token group context of a turn.`,
  } satisfies Record<Exclude<GroupChainEndReason, "blocked">, string>,
} as const;

/** The slice of the agent runtime the group runtime needs (PiSdkRuntime satisfies it). */
export type GroupAgentRuntime = {
  prompt(window: BrowserWindowType, input: PromptAgentInput): Promise<PromptTurnResult>;
  isSessionStreaming(sessionId: string): boolean;
};

export type GroupRuntimeHost = {
  /** A live window for prompts/tools; undefined → wakes wait in the queue. */
  getWindow(): BrowserWindowType | undefined;
  /** True while an update install is pending → wakes wait in the queue. */
  isUpdatePending(): boolean;
  emit(event: GroupRuntimeEvent): void;
};

export type GroupRuntimeOptions = {
  runtime: GroupAgentRuntime;
  host: GroupRuntimeHost;
  limits?: Partial<GroupChainLimits>;
  maxConcurrentTurns?: number;
  /** How long a gated queue (no window, update pending, member streaming) waits before retrying. */
  retryDelayMs?: number;
};

type ChainState = {
  groupId: string;
  chainId: string;
  hops: number;
  agentMessages: number;
  inputTokens: number;
  wakesByMember: Map<string, number>;
  ended?: GroupChainEndReason;
};

type Wake = {
  seq: number;
  groupId: string;
  sessionId: string;
  chainId: string;
  triggerMessageId: string;
  prompt: string;
};

/** Rough token estimate used for the chain budget and the per-wake context cap. */
export function estimateGroupTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type MemberRef = { sessionId: string; title: string };

function membersOf(groupId: string): MemberRef[] {
  return listAgentGroupMembers(groupId).map((member) => ({
    sessionId: member.sessionId,
    title: getAgentSession(member.sessionId)?.title ?? member.sessionId,
  }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Member session ids mentioned in `text` as `@<session title>` (case-insensitive,
 * longest title first) or `@<session id>`, in member order.
 */
export function parseGroupMentions(text: string, members: readonly MemberRef[]): string[] {
  const found = new Set<string>();
  const byLength = [...members].sort((a, b) => b.title.length - a.title.length);
  let rest = text;
  for (const member of byLength) {
    for (const handle of [member.title, member.sessionId]) {
      if (!handle.trim()) continue;
      const pattern = new RegExp(`@${escapeRegExp(handle)}(?![\\p{L}\\p{N}_-])`, "giu");
      if (pattern.test(rest)) {
        found.add(member.sessionId);
        // Consume it so a shorter title that prefixes this one does not match too.
        rest = rest.replace(pattern, " ");
      }
    }
  }
  return members.map((member) => member.sessionId).filter((id) => found.has(id));
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function authorLabel(message: GroupMessage, titles: Map<string, string>): string {
  if (message.authorKind === "user") return "user";
  if (message.authorKind === "system") return "system";
  return `@${titles.get(message.authorSessionId ?? "") ?? message.authorSessionId ?? "member"}`;
}

/**
 * The prompt a woken member receives: who it is, the recent room history (newest
 * first until the per-wake budget is spent, shown oldest first) and the message
 * that woke it. Returns undefined when even the trigger does not fit the budget.
 */
export function composeGroupWakePrompt(input: {
  group: AgentGroupInfo;
  members: readonly MemberRef[];
  sessionId: string;
  trigger: GroupMessage;
  history: readonly GroupMessage[];
  maxContextTokens: number;
}): string | undefined {
  const titles = new Map(input.members.map((member) => [member.sessionId, member.title]));
  const self = titles.get(input.sessionId) ?? input.sessionId;
  const roster = input.members
    .map(
      (member) =>
        `@${member.title}${member.sessionId === input.group.leadSessionId ? " (lead)" : ""}${
          member.sessionId === input.sessionId ? " (you)" : ""
        }`,
    )
    .join(", ");
  const header = [
    `<group_room name="${escapeText(input.group.name)}">`,
    `You are @${escapeText(self)}, a member of this group. Members: ${escapeText(roster)}.`,
    "Reply with what the group should read. To hand work to a member, mention them as @Name; only mentioned members are woken.",
  ].join("\n");
  const triggerBlock = `<group_message from="${escapeText(authorLabel(input.trigger, titles))}">\n${escapeText(input.trigger.body)}\n</group_message>`;
  const footer = "</group_room>";
  let used = estimateGroupTokens(`${header}\n${triggerBlock}\n${footer}`);
  if (used > input.maxContextTokens) return undefined;
  const lines: string[] = [];
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const message = input.history[index];
    if (!message || message.id === input.trigger.id) continue;
    const line = `[${authorLabel(message, titles)}${message.kind === "status" ? " status" : ""}] ${escapeText(message.body)}`;
    const cost = estimateGroupTokens(`${line}\n`);
    if (used + cost > input.maxContextTokens) break;
    used += cost;
    lines.unshift(line);
  }
  const history =
    lines.length > 0 ? `<recent_messages>\n${lines.join("\n")}\n</recent_messages>` : "";
  return [header, history, triggerBlock, footer].filter(Boolean).join("\n");
}

export class GroupRuntime {
  private readonly runtime: GroupAgentRuntime;
  private readonly host: GroupRuntimeHost;
  private readonly limits: GroupChainLimits;
  private readonly maxConcurrent: number;
  private readonly retryDelayMs: number;
  private readonly chains = new Map<string, ChainState>();
  /** Per-session FIFO of pending wakes. */
  private readonly queues = new Map<string, Wake[]>();
  private readonly running = new Map<string, Wake>();
  /** Members whose last group turn ended `blocked`, waiting for the user. */
  private readonly awaitingUser = new Map<string, string>();
  private seq = 0;
  private lastStamp = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleWaiters = new Set<() => void>();
  private disposed = false;

  constructor(options: GroupRuntimeOptions) {
    this.runtime = options.runtime;
    this.host = options.host;
    this.limits = { ...GROUP_CHAIN_LIMITS, ...options.limits };
    this.maxConcurrent = options.maxConcurrentTurns ?? GROUP_MAX_CONCURRENT_TURNS;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
  }

  /** A user message into the room: always opens a new chain (counters reset). */
  postUserMessage(input: PostGroupMessageInput): GroupMessage {
    const members = membersOf(input.groupId);
    const memberIds = new Set(members.map((member) => member.sessionId));
    const mentioned = new Set([
      ...(input.mentions ?? []).filter((id) => memberIds.has(id)),
      ...parseGroupMentions(input.body, members),
    ]);
    const mentions = members.map((member) => member.sessionId).filter((id) => mentioned.has(id));
    const message = appendGroupMessage({
      createdAt: this.stamp(),
      groupId: input.groupId,
      authorKind: "user",
      body: input.body,
      mentions,
      startsChain: true,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    });
    this.emitMessage(message);
    const chain = this.openChain(input.groupId, message.id);
    this.route(chain, message);
    return message;
  }

  /**
   * Any settled turn on any session (from `PiSdkRuntime.onTurnSettled`). A turn
   * the group runtime did not start, on a member waiting for the user, is the
   * user unblocking it (answered the intent gate / chose the HyperPlan build).
   */
  handleTurnSettled(event: TurnSettledEvent): void {
    if (this.running.has(event.sessionId)) return;
    if (!this.awaitingUser.has(event.sessionId)) return;
    this.handleMemberUnblocked(event.sessionId, event.result);
  }

  /**
   * The user released a blocked member: a user action, so it opens a NEW chain
   * (counters reset). The member's result is that chain's first hop and follows
   * the normal wake rules (its @mentions wake members).
   */
  handleMemberUnblocked(sessionId: string, result: PromptTurnResult): void {
    this.awaitingUser.delete(sessionId);
    const group = getAgentGroupForSession(sessionId);
    if (!group) return;
    const text =
      result.outcome === "ok" || result.outcome === "blocked" ? result.finalText : undefined;
    if (result.outcome === "ok" && !text) return;
    let root: GroupMessage;
    try {
      root =
        result.outcome === "ok" && text
          ? appendGroupMessage({
              createdAt: this.stamp(),
              groupId: group.id,
              authorKind: "agent",
              authorSessionId: sessionId,
              body: text,
              mentions: parseGroupMentions(text, membersOf(group.id)),
              startsChain: true,
            })
          : appendGroupMessage({
              createdAt: this.stamp(),
              groupId: group.id,
              authorKind: "agent",
              authorSessionId: sessionId,
              kind: "status",
              body: statusText(result.outcome),
              startsChain: true,
            });
    } catch (error) {
      console.warn("[modus] group unblock post failed:", error);
      return;
    }
    this.emitMessage(root);
    const chain = this.openChain(group.id, root.id);
    chain.hops = 1;
    if (root.kind === "message") {
      chain.agentMessages = 1;
      this.route(chain, root);
    } else if (result.outcome === "blocked") {
      this.awaitingUser.set(sessionId, chain.chainId);
      this.endChain(chain, "blocked");
    }
  }

  isGroupWorking(groupId: string): boolean {
    return this.activityOf(groupId).working;
  }

  /** Groups with a member turn running or queued (the sidebar activity dot). */
  workingGroupIds(): string[] {
    const ids = new Set<string>();
    for (const wake of this.running.values()) ids.add(wake.groupId);
    for (const queue of this.queues.values()) for (const wake of queue) ids.add(wake.groupId);
    return [...ids];
  }

  /** Test/diagnostic view of one chain's counters. */
  chainSnapshot(chainId: string): Readonly<Omit<ChainState, "wakesByMember">> & {
    wakesByMember: Record<string, number>;
  } {
    const chain = this.chains.get(chainId);
    if (!chain) throw new Error(`Unknown chain ${chainId}`);
    return { ...chain, wakesByMember: Object.fromEntries(chain.wakesByMember) };
  }

  isAwaitingUser(sessionId: string): boolean {
    return this.awaitingUser.has(sessionId);
  }

  /** Re-check gated wakes now (e.g. a window opened or an update was cancelled). */
  kick(): void {
    this.pump();
  }

  /** Resolves once nothing is running or queued (tests). */
  whenIdle(): Promise<void> {
    if (this.running.size === 0 && this.queuedCount() === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.queues.clear();
  }

  /* ── internals ────────────────────────────────────────────────────── */

  /**
   * Strictly increasing timestamps for the messages this runtime posts, so the
   * (created_at, id) order matches posting order even within one millisecond.
   */
  private stamp(): string {
    const now = Math.max(Date.now(), this.lastStamp + 1);
    this.lastStamp = now;
    return new Date(now).toISOString();
  }

  private openChain(groupId: string, chainId: string): ChainState {
    const chain: ChainState = {
      groupId,
      chainId,
      hops: 0,
      agentMessages: 0,
      inputTokens: 0,
      wakesByMember: new Map(),
    };
    this.chains.set(chainId, chain);
    return chain;
  }

  /**
   * Wake rules: a user message with no mention wakes only the lead; @mentions
   * wake the mentioned members; an author never wakes itself; a reply does not
   * wake the replied-to author unless it is mentioned; agents without mentions
   * wake nobody.
   */
  private wakeTargets(group: AgentGroupInfo, message: GroupMessage): string[] {
    if (message.kind !== "message") return [];
    const memberIds = new Set(listAgentGroupMembers(group.id).map((member) => member.sessionId));
    let targets: string[];
    if (message.authorKind === "user") {
      targets =
        message.mentions.length > 0
          ? message.mentions
          : group.leadSessionId
            ? [group.leadSessionId]
            : [];
    } else if (message.authorKind === "agent") {
      targets = message.mentions;
    } else {
      targets = [];
    }
    const repliedAuthor = message.replyToMessageId
      ? getGroupMessage(message.replyToMessageId)?.authorSessionId
      : undefined;
    return [...new Set(targets)].filter(
      (id) =>
        memberIds.has(id) &&
        id !== message.authorSessionId &&
        (id !== repliedAuthor || message.mentions.includes(id)),
    );
  }

  private route(chain: ChainState, message: GroupMessage): void {
    if (chain.ended) return;
    const group = getAgentGroup(chain.groupId);
    if (!group) return;
    const targets = this.wakeTargets(group, message);
    if (targets.length === 0) return;
    const members = membersOf(group.id);
    const history = listGroupMessages(group.id, {
      before: { createdAt: message.createdAt, id: message.id },
      limit: 100,
    });
    for (const sessionId of targets) {
      if (chain.agentMessages >= this.limits.maxAgentMessages) {
        this.endChain(chain, "max-agent-messages");
        break;
      }
      if (chain.hops + 1 > this.limits.maxHops) {
        this.endChain(chain, "max-hops");
        break;
      }
      if ((chain.wakesByMember.get(sessionId) ?? 0) + 1 > this.limits.maxWakesPerMember) {
        this.endChain(chain, "max-member-wakes");
        break;
      }
      const prompt = composeGroupWakePrompt({
        group,
        members,
        sessionId,
        trigger: message,
        history,
        maxContextTokens: this.limits.maxContextTokensPerWake,
      });
      if (prompt === undefined) {
        this.endChain(chain, "context-too-large");
        break;
      }
      const tokens = estimateGroupTokens(prompt);
      if (chain.inputTokens + tokens > this.limits.maxInputTokens) {
        this.endChain(chain, "input-token-budget");
        break;
      }
      chain.hops += 1;
      chain.inputTokens += tokens;
      chain.wakesByMember.set(sessionId, (chain.wakesByMember.get(sessionId) ?? 0) + 1);
      // Waking a blocked member from the room hands it a fresh turn.
      this.awaitingUser.delete(sessionId);
      this.enqueue({
        seq: ++this.seq,
        groupId: group.id,
        sessionId,
        chainId: chain.chainId,
        triggerMessageId: message.id,
        prompt,
      });
    }
    this.emitActivity(group.id);
    this.pump();
  }

  /**
   * Ends a chain: nothing new is woken in it; in-flight turns finish and post
   * but wake nobody. A limit keeps the wakes it already admitted; `blocked`
   * also drops the chain's queued (not yet started) wakes.
   */
  private endChain(chain: ChainState, reason: GroupChainEndReason): void {
    if (chain.ended) return;
    chain.ended = reason;
    if (reason === "blocked") {
      for (const [sessionId, queue] of this.queues) {
        const kept = queue.filter((wake) => wake.chainId !== chain.chainId);
        if (kept.length === 0) this.queues.delete(sessionId);
        else this.queues.set(sessionId, kept);
      }
    }
    if (reason !== "blocked") {
      try {
        this.emitMessage(
          appendGroupMessage({
            createdAt: this.stamp(),
            groupId: chain.groupId,
            authorKind: "system",
            kind: "status",
            body: GROUP_STATUS_TEXT.limit[reason],
            chainId: chain.chainId,
          }),
        );
      } catch (error) {
        console.warn("[modus] group limit status failed:", error);
      }
    }
    this.host.emit({
      type: "group.chain-ended",
      groupId: chain.groupId,
      chainId: chain.chainId,
      reason,
    });
    this.emitActivity(chain.groupId);
    this.settleIdle();
  }

  private enqueue(wake: Wake): void {
    const queue = this.queues.get(wake.sessionId) ?? [];
    queue.push(wake);
    this.queues.set(wake.sessionId, queue);
  }

  private queuedCount(): number {
    let count = 0;
    for (const queue of this.queues.values()) count += queue.length;
    return count;
  }

  private pump(): void {
    if (this.disposed || this.queuedCount() === 0) return;
    const window = this.host.getWindow();
    if (!window || this.host.isUpdatePending()) {
      this.scheduleRetry();
      return;
    }
    let gated = false;
    while (this.running.size < this.maxConcurrent) {
      const heads = [...this.queues.entries()]
        .filter(([sessionId]) => !this.running.has(sessionId))
        .map(([, queue]) => queue[0])
        .filter((wake): wake is Wake => Boolean(wake))
        .sort((a, b) => a.seq - b.seq);
      const next = heads.find((wake) => {
        if (this.runtime.isSessionStreaming(wake.sessionId)) {
          // The user (or another turn) is streaming this session: wait, never steer.
          gated = true;
          return false;
        }
        return true;
      });
      if (!next) break;
      this.queues.get(next.sessionId)?.shift();
      if (this.queues.get(next.sessionId)?.length === 0) this.queues.delete(next.sessionId);
      this.start(window, next);
    }
    if (gated) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.pump();
    }, this.retryDelayMs);
  }

  private start(window: BrowserWindowType, wake: Wake): void {
    this.running.set(wake.sessionId, wake);
    this.emitActivity(wake.groupId);
    let turn: Promise<PromptTurnResult>;
    try {
      turn = this.runtime.prompt(window, {
        sessionId: wake.sessionId,
        message: wake.prompt,
        context: [],
        delivery: "normal",
      });
    } catch (error) {
      turn = Promise.reject(error);
    }
    turn
      .catch((): PromptTurnResult => ({ outcome: "failed" }))
      .then((result) => this.finishTurn(wake, result))
      .catch((error) => console.warn("[modus] group turn settle failed:", error));
  }

  private finishTurn(wake: Wake, result: PromptTurnResult): void {
    this.running.delete(wake.sessionId);
    const chain = this.chains.get(wake.chainId);
    const stillMember = listAgentGroupMembers(wake.groupId).some(
      (member) => member.sessionId === wake.sessionId,
    );
    if (chain && stillMember) {
      try {
        this.applyTurnResult(chain, wake, result);
      } catch (error) {
        console.warn("[modus] group turn post failed:", error);
      }
    }
    this.emitActivity(wake.groupId);
    this.pump();
    this.settleIdle();
  }

  private applyTurnResult(chain: ChainState, wake: Wake, result: PromptTurnResult): void {
    const text = result.finalText?.trim();
    if (result.outcome === "ok") {
      if (!text) return; // An empty turn posts nothing.
      const message = appendGroupMessage({
        createdAt: this.stamp(),
        groupId: wake.groupId,
        authorKind: "agent",
        authorSessionId: wake.sessionId,
        replyToMessageId: wake.triggerMessageId,
        chainId: chain.chainId,
        body: text,
        mentions: parseGroupMentions(text, membersOf(wake.groupId)),
      });
      chain.agentMessages += 1;
      this.emitMessage(message);
      // An ended chain (blocked / limit) still shows the reply but wakes nobody.
      this.route(chain, message);
      return;
    }
    this.emitMessage(
      appendGroupMessage({
        createdAt: this.stamp(),
        groupId: wake.groupId,
        authorKind: "agent",
        authorSessionId: wake.sessionId,
        kind: "status",
        body: statusText(result.outcome),
        chainId: chain.chainId,
      }),
    );
    if (result.outcome === "blocked") {
      this.awaitingUser.set(wake.sessionId, chain.chainId);
      this.endChain(chain, "blocked");
    }
  }

  private activityOf(groupId: string): {
    working: boolean;
    runningSessionIds: string[];
    queuedSessionIds: string[];
  } {
    const runningSessionIds = [...this.running.values()]
      .filter((wake) => wake.groupId === groupId)
      .map((wake) => wake.sessionId);
    const queuedSessionIds = [
      ...new Set(
        [...this.queues.values()]
          .flat()
          .filter((wake) => wake.groupId === groupId)
          .map((wake) => wake.sessionId),
      ),
    ];
    return {
      working: runningSessionIds.length > 0 || queuedSessionIds.length > 0,
      runningSessionIds,
      queuedSessionIds,
    };
  }

  private emitActivity(groupId: string): void {
    const { runningSessionIds, queuedSessionIds } = this.activityOf(groupId);
    this.host.emit({ type: "group.activity", groupId, runningSessionIds, queuedSessionIds });
  }

  private emitMessage(message: GroupMessage): void {
    this.host.emit({ type: "group.message", groupId: message.groupId, message });
  }

  private settleIdle(): void {
    if (this.running.size > 0 || this.queuedCount() > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

function statusText(outcome: PromptTurnOutcome): string {
  switch (outcome) {
    case "blocked":
      return GROUP_STATUS_TEXT.waitingForYou;
    case "aborted":
      return GROUP_STATUS_TEXT.aborted;
    default:
      return GROUP_STATUS_TEXT.failed;
  }
}
