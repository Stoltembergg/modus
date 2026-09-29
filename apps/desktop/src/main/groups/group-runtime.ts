import type { BrowserWindow as BrowserWindowType } from "electron";
import type {
  AgentGroupInfo,
  GroupChainEndReason,
  GroupDecision,
  GroupMemberStates,
  GroupMessage,
  GroupRuntimeEvent,
  GroupTask,
  PostGroupMessageInput,
  UpdateState,
} from "../../shared/contracts";
import {
  GROUP_BLOCKED_TEXT,
  groupBlockedErrorCode,
  groupBlockedReason,
} from "../../shared/group-blocked";
import { isCoordinatorModeActive } from "../../shared/group-coordinator";
import { getAgentSession } from "../agent/agent-store";
import type {
  PromptAgentInput,
  PromptTurnOutcome,
  PromptTurnResult,
  TurnSettledEvent,
} from "../agent/runtime";
import { getAgent } from "../agents/agents-store";
import {
  appendGroupMessage,
  GroupStoreError,
  getAgentGroup,
  getAgentGroupForSession,
  getGroupMessage,
  listAgentGroupMembers,
  listGroupDecisions,
  listGroupMessages,
  listGroupTasks,
  memberWorktreeBranchPrefix,
} from "./group-store";

/**
 * Agent Groups runtime (PR 3): routes room messages to member sessions as
 * ordinary `normal` prompts and posts their replies back into the room.
 *
 * A *chain* is everything that follows one user action (a user message, or the
 * user unblocking a member). Every limit below is per chain; hitting one posts
 * a "Waiting for you: …" status and stops the chain until the user acts again.
 */
/**
 * Token limits are ESTIMATES (characters / 4, see estimateGroupTokens) of the
 * prompt text the group injects into member turns only: the member's own
 * system prompt, tools and session history are not counted.
 */
export const ESTIMATED_INPUT_TOKENS_PER_CHAIN = 150_000;
export const ESTIMATED_CONTEXT_TOKENS_PER_WAKE = 8_000;
/** The "Group decisions" prompt section (PR 6): newest first, at most 20 items and ~2k estimated tokens. */
export const GROUP_PROMPT_DECISIONS_MAX_ITEMS = 20;
export const GROUP_PROMPT_DECISIONS_MAX_TOKENS = 2_000;
/** The Lead's "Group snapshot" in coordinator mode (PR 7): ~1.5k estimated tokens. */
export const GROUP_PROMPT_SNAPSHOT_MAX_TOKENS = 1_500;

export const GROUP_CHAIN_LIMITS = {
  /** Member turns per chain (every woken turn, and an unblocked member's result, is one hop). */
  maxHops: 6,
  /** Agent messages posted per chain. */
  maxAgentMessages: 20,
  /** Times the same member is woken per chain. */
  maxWakesPerMember: 3,
  /** Estimated input tokens of all group-injected wake prompts in a chain. */
  maxEstimatedInputTokens: ESTIMATED_INPUT_TOKENS_PER_CHAIN,
  /** Estimated tokens of group context (room history + trigger) in one wake prompt. */
  maxEstimatedContextTokensPerWake: ESTIMATED_CONTEXT_TOKENS_PER_WAKE,
} as const;

export type GroupChainLimits = { [K in keyof typeof GROUP_CHAIN_LIMITS]: number };

/** At most this many members run a group turn at once. */
export const GROUP_MAX_CONCURRENT_TURNS = 2;

/** Status texts posted into the room (English, like the rest of the app's statuses). */
export const GROUP_STATUS_TEXT = {
  /** A member's turn waits on the user: the intent gate opened, or a HyperPlan choice is pending. */
  waitingForYou: "Waiting for you",
  failed: "Turn failed",
  aborted: "Turn stopped",
  /** The user pressed Stop and it cleared the queue and/or cancelled a running turn. */
  stoppedByYou: "Stopped by you",
  /** A member's turn ended to move into its worktree (then it is re-woken there). */
  worktreeReady: (branch: string) => `Worktree ready: \`${branch}\``,
  archived: (name: string) => `${name} is archived`,
  limit: {
    "max-hops": `Waiting for you: this chain reached its limit of ${GROUP_CHAIN_LIMITS.maxHops} turns.`,
    "max-agent-messages": `Waiting for you: this chain reached its limit of ${GROUP_CHAIN_LIMITS.maxAgentMessages} agent messages.`,
    "max-member-wakes": `Waiting for you: a member was already woken ${GROUP_CHAIN_LIMITS.maxWakesPerMember} times in this chain.`,
    "input-token-budget": `Waiting for you: this chain used its estimated ${ESTIMATED_INPUT_TOKENS_PER_CHAIN / 1000}k-token budget of group prompts.`,
    "context-too-large": `Waiting for you: the message does not fit the estimated ${ESTIMATED_CONTEXT_TOKENS_PER_WAKE / 1000}k-token group context of a turn.`,
  } satisfies Record<Exclude<GroupChainEndReason, "blocked" | "stopped">, string>,
} as const;

/** An update is about to restart the app: new group turns wait (`ready` alone does not hold them). */
export function isUpdatePendingState(state: UpdateState): boolean {
  return state.status === "waiting-for-agents" || state.status === "installing";
}

/** The slice of the agent runtime the group runtime needs (PiSdkRuntime satisfies it). */
export type GroupAgentRuntime = {
  prompt(window: BrowserWindowType, input: PromptAgentInput): Promise<PromptTurnResult>;
  /** Stops a session's running turn (it settles as `aborted`). */
  abort(sessionId: string): Promise<void>;
  isSessionStreaming(sessionId: string): boolean;
  /** Every settled turn (unblocks a HyperPlan-blocked member). */
  onTurnSettled(listener: (event: TurnSettledEvent) => void): () => void;
  /** The intent gate opened on a session (a group turn there frees its slot). */
  onQuestionPending(listener: (sessionId: string) => void): () => void;
};

export type GroupRuntimeHost = {
  /** A live window for prompts/tools; undefined → wakes wait in the queue. */
  getWindow(): BrowserWindowType | undefined;
  /** True while an update install is pending → wakes wait in the queue. */
  isUpdatePending(): boolean;
  emit(event: GroupRuntimeEvent): void;
};

/** A wake requested by a member task tool (see GroupRuntime.handleTaskWake). */
export type GroupTaskWake = {
  groupId: string;
  actorSessionId: string;
  /** Mentioned and woken; absent for a status aimed at nobody ("Decision: …"), which never wakes. */
  targetSessionId?: string;
  /** Task status text posted as the acting member, e.g. "Review requested: …". */
  body: string;
  /**
   * false: post the status (mentioning the target) but wake nobody and count
   * no hop, e.g. "Approved". Defaults to true.
   */
  wake?: boolean;
};

/** group_start_worktree moved a member's cwd (see GroupRuntime.handleWorktreeReady). */
export type GroupWorktreeReady = { groupId: string; sessionId: string; branch: string };

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
  /**
   * Rebuilds the prompt when the turn actually starts, so the roster (and the
   * persona) reflect the membership at that moment, not when it was queued.
   * Undefined result → the queued `prompt` is used.
   */
  compose?: () => string | undefined;
  /** The turn opened the intent gate: its chain ended and it no longer holds a slot. */
  gated?: boolean;
  /** group_start_worktree moved the member's cwd during this turn: re-wake it there. */
  worktreeBranch?: string;
};

/** Ended/finished chains kept for chainSnapshot diagnostics (bounded). */
const RETIRED_CHAIN_HISTORY = 20;

/** Rough token estimate used for the chain budget and the per-wake context cap. */
export function estimateGroupTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A member as the room sees it: session id (the key) → its agent's name and role. */
type MemberRef = {
  sessionId: string;
  /** The agent's CURRENT display name: `@Name` mentions follow a rename. */
  title: string;
  /** Role in this group, else the agent's role (title). */
  role?: string;
  /** Short description of the agent (agentDescription). */
  description?: string;
  archived?: boolean;
};

/** Max length of a roster description. */
export const GROUP_ROSTER_DESCRIPTION_MAX_CHARS = 120;

/**
 * The roster entry's description: the first line of the agent's instructions
 * (leading blank lines skipped), truncated to 120 characters. Shown after the
 * role: `- @Name [Role]: <first line>`. (The agents table has no description
 * column yet; A3/A4 may add one.)
 */
export function agentDescription(instructions: string | undefined): string | undefined {
  const line = (instructions ?? "")
    .split("\n")
    .map((text) => text.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.slice(0, GROUP_ROSTER_DESCRIPTION_MAX_CHARS).trimEnd();
}

/** The room's CURRENT membership, read fresh on every call (never cached). */
function membersOf(groupId: string): MemberRef[] {
  return listAgentGroupMembers(groupId).map((member) => {
    const role = member.role?.trim() || member.agentRole?.trim();
    const description = agentDescription(getAgent(member.agentId)?.instructions);
    return {
      sessionId: member.sessionId,
      title: member.name,
      ...(role ? { role } : {}),
      ...(description ? { description } : {}),
      ...(member.archived ? { archived: true } : {}),
    };
  });
}

/** The member's agent persona (its `instructions`), for the top of its wake prompt. */
function instructionsOf(groupId: string, sessionId: string): string | undefined {
  const agentId = listAgentGroupMembers(groupId).find(
    (member) => member.sessionId === sessionId,
  )?.agentId;
  const instructions = agentId ? getAgent(agentId)?.instructions.trim() : undefined;
  return instructions || undefined;
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
  // Members sharing a title (case-insensitive) are all woken by `@Title`.
  const byTitle = new Map<string, { title: string; sessionIds: string[] }>();
  for (const member of members) {
    const title = member.title.trim();
    if (!title) continue;
    const key = title.toLocaleLowerCase();
    const entry = byTitle.get(key) ?? { title, sessionIds: [] };
    entry.sessionIds.push(member.sessionId);
    byTitle.set(key, entry);
  }
  const handles = [
    ...[...byTitle.values()].map((entry) => ({
      handle: entry.title,
      sessionIds: entry.sessionIds,
    })),
    ...members.map((member) => ({ handle: member.sessionId, sessionIds: [member.sessionId] })),
  ].sort((a, b) => b.handle.length - a.handle.length);
  let rest = text;
  for (const { handle, sessionIds } of handles) {
    if (!handle.trim()) continue;
    const pattern = new RegExp(`@${escapeRegExp(handle)}(?![\\p{L}\\p{N}_-])`, "giu");
    if (pattern.test(rest)) {
      for (const id of sessionIds) found.add(id);
      // Consume it so a shorter handle that prefixes this one does not match too.
      rest = rest.replace(pattern, " ");
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
 * The group's shared context for a wake prompt: `decisions` (newest first)
 * until 20 items or ~2k estimated tokens, then "(N older decisions omitted)".
 * Empty when the group has no decisions.
 */
export function composeGroupDecisionsSection(
  decisions: readonly GroupDecision[],
  titles: ReadonlyMap<string, string>,
): string {
  if (decisions.length === 0) return "";
  const open = [
    "<group_decisions>",
    "Group decisions (newest first; the group agreed on these, keep to them):",
  ].join("\n");
  const close = "</group_decisions>";
  const omittedLine = (count: number) => `(${count} older decisions omitted)`;
  // Reserve room for the omitted line (its longest possible count) up front.
  const reserve = estimateGroupTokens(`${omittedLine(decisions.length)}\n`);
  let used = estimateGroupTokens(`${open}\n${close}`) + reserve;
  const lines: string[] = [];
  for (const decision of decisions) {
    if (lines.length >= GROUP_PROMPT_DECISIONS_MAX_ITEMS) break;
    // Only members record decisions: no author (session deleted, `on delete set null`)
    // or an author no longer in the group is a former member, never the user.
    const title = decision.authorSessionId ? titles.get(decision.authorSessionId) : undefined;
    const author = title !== undefined ? `@${title}` : "former member";
    const line = `- ${escapeText(decision.text)} (${escapeText(author)})`;
    const cost = estimateGroupTokens(`${line}\n`);
    if (used + cost > GROUP_PROMPT_DECISIONS_MAX_TOKENS) break;
    used += cost;
    lines.push(line);
  }
  const omitted = decisions.length - lines.length;
  if (omitted > 0) lines.push(omittedLine(omitted));
  return [open, ...lines, close].join("\n");
}

export type GroupSnapshotMember = {
  sessionId: string;
  title: string;
  state: "working" | "waiting" | "idle";
  branch?: string;
};

const SNAPSHOT_TASK_STATUSES: readonly GroupTask["status"][] = ["open", "in_progress", "in_review"];

/**
 * Coordinator mode (PR 7): what the Lead sees of its group. Every member (title
 * and session id, so repeated titles stay distinct; state; worktree branch),
 * then the open / in progress / in review tasks until ~1.5k estimated tokens,
 * then "(N more tasks omitted)".
 */
export function composeGroupSnapshotSection(input: {
  sessionId: string;
  leadSessionId: string;
  members: readonly GroupSnapshotMember[];
  tasks: readonly GroupTask[];
}): string {
  const who = (id: string | undefined) => {
    if (!id) return "none";
    const title = input.members.find((member) => member.sessionId === id)?.title ?? id;
    return `@${title} (id ${id})`;
  };
  const memberLines = input.members.map((member) => {
    const tags = [
      member.sessionId === input.leadSessionId ? "lead" : "",
      member.sessionId === input.sessionId ? "you" : "",
    ].filter(Boolean);
    const state = [member.state, member.branch ? `branch ${member.branch}` : ""]
      .filter(Boolean)
      .join(", ");
    return escapeText(
      `- ${who(member.sessionId)}${tags.length > 0 ? ` ${tags.join(", ")}` : ""}: ${state}`,
    );
  });
  const head = [
    "<group_snapshot>",
    "Group snapshot (coordinator mode: you are the Lead and coordinate the group; hand out tasks with group_assign_task):",
    "Members:",
    ...memberLines,
    "Tasks (open, in progress, in review):",
  ];
  const close = "</group_snapshot>";
  const tasks = input.tasks.filter((task) => SNAPSHOT_TASK_STATUSES.includes(task.status));
  const omittedLine = (count: number) => `(${count} more tasks omitted)`;
  let used =
    estimateGroupTokens(`${head.join("\n")}\n${close}`) +
    estimateGroupTokens(`${omittedLine(tasks.length)}\n`);
  const lines: string[] = [];
  for (const task of tasks) {
    const line = escapeText(
      `- task ${task.id} [${task.status}] "${task.title}" owner=${who(task.ownerSessionId)} reviewer=${who(task.reviewerSessionId)}`,
    );
    const cost = estimateGroupTokens(`${line}\n`);
    if (used + cost > GROUP_PROMPT_SNAPSHOT_MAX_TOKENS) break;
    used += cost;
    lines.push(line);
  }
  if (tasks.length === 0) lines.push("- none");
  else if (lines.length < tasks.length) lines.push(omittedLine(tasks.length - lines.length));
  return [...head, ...lines, close].join("\n");
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
  /** The group's decisions, newest first ("Group decisions" section, see composeGroupDecisionsSection). */
  decisions?: readonly GroupDecision[];
  /** Coordinator mode: the Lead's "Group snapshot" (composeGroupSnapshotSection), Lead only. */
  snapshot?: string;
  /** The woken member's agent persona; first in the prompt when set. */
  instructions?: string;
  maxContextTokens: number;
}): string | undefined {
  const titles = new Map(input.members.map((member) => [member.sessionId, member.title]));
  const self = titles.get(input.sessionId) ?? input.sessionId;
  // Roster, rebuilt from the current membership on every wake: name, role, who
  // leads, archived, a short description, and "(you)".
  const roster = input.members.map((member) => {
    const tags = [
      member.sessionId === input.group.leadSessionId ? " (lead)" : "",
      member.sessionId === input.sessionId ? " (you)" : "",
      member.archived ? " (archived)" : "",
    ].join("");
    const about = member.description ? `: ${member.description}` : "";
    return `- @${member.title}${member.role ? ` [${member.role}]` : ""}${tags}${about}`;
  });
  const persona = input.instructions?.trim()
    ? `<agent_instructions>\n${escapeText(input.instructions.trim())}\n</agent_instructions>`
    : "";
  const header = [
    `<group_room name="${escapeText(input.group.name)}">`,
    `You are @${escapeText(self)}, a member of this group. Members right now:`,
    ...roster.map((line) => escapeText(line)),
    "Reply with what the group should read. To hand work to a member, mention them as @Name; only mentioned members are woken.",
  ].join("\n");
  const triggerBlock = `<group_message from="${escapeText(authorLabel(input.trigger, titles))}">\n${escapeText(input.trigger.body)}\n</group_message>`;
  const footer = "</group_room>";
  const decisions = composeGroupDecisionsSection(input.decisions ?? [], titles);
  const snapshot = input.snapshot ?? "";
  let used = estimateGroupTokens(
    [persona, header, snapshot, decisions, triggerBlock, footer].filter(Boolean).join("\n"),
  );
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
  return [persona, header, snapshot, decisions, history, triggerBlock, footer]
    .filter(Boolean)
    .join("\n");
}

export class GroupRuntime {
  private readonly runtime: GroupAgentRuntime;
  private readonly host: GroupRuntimeHost;
  private readonly limits: GroupChainLimits;
  private readonly maxConcurrent: number;
  private readonly retryDelayMs: number;
  /** Live chains: removed once no wake of theirs is queued, running or gated. */
  private readonly chains = new Map<string, ChainState>();
  private readonly retiredChains = new Map<string, ChainState>();
  /** Per-session FIFO of pending wakes. */
  private readonly queues = new Map<string, Wake[]>();
  /** Group turns holding one of the concurrency slots. */
  private readonly running = new Map<string, Wake>();
  /** Group turns waiting at the intent gate: still pending, but no slot and no chain. */
  private readonly gated = new Map<string, Wake>();
  /** Members whose group turn ended with a HyperPlan choice pending. */
  private readonly awaitingUser = new Map<string, string>();
  private seq = 0;
  private lastStamp = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleWaiters = new Set<() => void>();
  private disposed = false;
  private readonly unsubscribers: Array<() => void>;

  constructor(options: GroupRuntimeOptions) {
    this.runtime = options.runtime;
    this.host = options.host;
    this.limits = { ...GROUP_CHAIN_LIMITS, ...options.limits };
    this.maxConcurrent = options.maxConcurrentTurns ?? GROUP_MAX_CONCURRENT_TURNS;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
    this.unsubscribers = [
      this.runtime.onTurnSettled((event) => this.handleTurnSettled(event)),
      this.runtime.onQuestionPending((sessionId) => this.handleQuestionPending(sessionId)),
    ];
  }

  /** A user message into the room: always opens a new chain (counters reset). */
  postUserMessage(input: PostGroupMessageInput): GroupMessage {
    const group = getAgentGroup(input.groupId);
    const blocked = group ? groupBlockedReason(group, listAgentGroupMembers(group.id)) : null;
    if (blocked) {
      // Read-only until a folder is chosen / a member is added: nothing is posted or woken.
      throw new GroupStoreError(groupBlockedErrorCode(blocked), GROUP_BLOCKED_TEXT[blocked]);
    }
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
    this.retireIdleChains();
    return message;
  }

  /**
   * The intent gate opened its question on a session (`onQuestionPending`).
   * For a turn the group started: post "Waiting for you" as the member, end
   * the chain (its queued wakes drop) and release the turn's concurrency slot.
   * The turn itself stays pending until the user answers in the member's chat.
   */
  handleQuestionPending(sessionId: string): void {
    const wake = this.running.get(sessionId);
    if (!wake) return;
    this.running.delete(sessionId);
    wake.gated = true;
    this.gated.set(sessionId, wake);
    try {
      this.emitMessage(
        appendGroupMessage({
          createdAt: this.stamp(),
          groupId: wake.groupId,
          authorKind: "agent",
          authorSessionId: sessionId,
          kind: "status",
          body: GROUP_STATUS_TEXT.waitingForYou,
          chainId: wake.chainId,
        }),
      );
    } catch (error) {
      console.warn("[modus] group gate status failed:", error);
    }
    const chain = this.chains.get(wake.chainId);
    if (chain) this.endChain(chain, "blocked");
    this.emitActivity(wake.groupId);
    this.pump();
    this.retireIdleChains();
    this.settleIdle();
  }

  /**
   * Any settled turn on any session (from `PiSdkRuntime.onTurnSettled`). Only
   * a successful HyperPlan build (`plan-build`, outcome `ok`) on a member whose
   * group turn ended with a plan choice pending unblocks it; a failed or
   * aborted turn does not.
   */
  handleTurnSettled(event: TurnSettledEvent): void {
    if (event.origin !== "plan-build" || event.result.outcome !== "ok") return;
    if (this.running.has(event.sessionId) || this.gated.has(event.sessionId)) return;
    if (!this.awaitingUser.has(event.sessionId)) return;
    this.handleMemberUnblocked(event.sessionId, event.result);
  }

  /**
   * The user released a blocked member: a user action, so it opens a NEW chain
   * (counters reset). The member's result is that chain's first hop and follows
   * the normal wake rules (its @mentions wake members). An empty result posts nothing.
   */
  handleMemberUnblocked(sessionId: string, result: PromptTurnResult): void {
    this.awaitingUser.delete(sessionId);
    const group = getAgentGroupForSession(sessionId);
    if (!group) return;
    this.emitActivity(group.id); // no longer waiting for the user
    const text = result.outcome === "ok" ? result.finalText?.trim() : undefined;
    if (!text) return;
    let root: GroupMessage;
    try {
      root = appendGroupMessage({
        createdAt: this.stamp(),
        groupId: group.id,
        authorKind: "agent",
        authorSessionId: sessionId,
        body: text,
        mentions: parseGroupMentions(text, membersOf(group.id)),
        startsChain: true,
      });
    } catch (error) {
      console.warn("[modus] group unblock post failed:", error);
      return;
    }
    this.emitMessage(root);
    const chain = this.openChain(group.id, root.id);
    chain.hops = 1;
    chain.agentMessages = 1;
    this.route(chain, root);
    this.retireIdleChains();
  }

  /**
   * A member task tool woke someone (review requested → reviewer; changes
   * requested → owner). Posts a task status as the acting member (mentioning
   * the target) and routes it like a mention, so the wake counts hops, wakes
   * and budget in the chain. Inside a group turn it joins that turn's chain
   * (an ended chain wakes nobody); outside one (the member working in its own
   * chat) it opens a new chain. With `wake: false` the status only posts
   * (no route, no hop, no new chain counters).
   */
  handleTaskWake(input: GroupTaskWake): GroupMessage | undefined {
    const turn = this.running.get(input.actorSessionId) ?? this.gated.get(input.actorSessionId);
    const joined =
      turn && turn.groupId === input.groupId ? this.chains.get(turn.chainId) : undefined;
    let message: GroupMessage;
    try {
      message = appendGroupMessage({
        createdAt: this.stamp(),
        groupId: input.groupId,
        authorKind: "agent",
        authorSessionId: input.actorSessionId,
        kind: "status",
        body: input.body,
        mentions: input.targetSessionId ? [input.targetSessionId] : [],
        ...(joined ? { chainId: joined.chainId } : { startsChain: true }),
      });
    } catch (error) {
      console.warn("[modus] group task status failed:", error);
      return undefined;
    }
    this.emitMessage(message);
    if (input.wake === false || !input.targetSessionId) return message;
    const chain = joined ?? this.openChain(input.groupId, message.id);
    this.route(chain, message, [input.targetSessionId]);
    this.retireIdleChains();
    return message;
  }

  /**
   * group_start_worktree moved `sessionId`'s cwd. Inside that member's running
   * group turn: mark it for a re-wake and return true (the tool then ends the
   * turn after its result). Outside one (its own chat, another group's turn,
   * a turn waiting at the intent gate, or a chain that already ended) return
   * false: nothing is re-woken and the cwd applies from the next message.
   */
  handleWorktreeReady(input: GroupWorktreeReady): boolean {
    const turn = this.running.get(input.sessionId);
    if (!turn || turn.groupId !== input.groupId) return false;
    // An already ended chain could not re-wake it: let the turn go on.
    if (this.chains.get(turn.chainId)?.ended) return false;
    turn.worktreeBranch = input.branch;
    return true;
  }

  /**
   * The user pressed Stop in the room: every live chain of the group ends
   * (queued wakes drop, nothing else is woken), "Stopped by you" is posted and
   * the group's running member turns are aborted; they settle as "Turn
   * stopped". With nothing running or queued it does nothing (no line). Turns
   * waiting at the intent gate stay with the user in the member's chat.
   */
  stopGroup(groupId: string): void {
    const queued = [...this.queues.values()].flat().filter((wake) => wake.groupId === groupId);
    const running = [...this.running.values()].filter((wake) => wake.groupId === groupId);
    if (queued.length === 0 && running.length === 0) return; // Nothing to stop: no line.
    for (const chain of [...this.chains.values()]) {
      if (chain.groupId === groupId) this.endChain(chain, "stopped");
    }
    try {
      this.emitMessage(
        appendGroupMessage({
          createdAt: this.stamp(),
          groupId,
          authorKind: "system",
          kind: "status",
          body: GROUP_STATUS_TEXT.stoppedByYou,
        }),
      );
    } catch (error) {
      console.warn("[modus] group stop status failed:", error);
    }
    for (const wake of running) {
      this.runtime
        .abort(wake.sessionId)
        .catch((error) => console.warn("[modus] group stop abort failed:", error));
    }
    this.emitActivity(groupId);
  }

  /** Member states of every group with a running, queued or waiting member (`group:member-states`). */
  memberStates(): GroupMemberStates[] {
    const ids = new Set(this.workingGroupIds());
    for (const wake of this.gated.values()) ids.add(wake.groupId);
    for (const sessionId of this.awaitingUser.keys()) {
      const groupId = getAgentGroupForSession(sessionId)?.id;
      if (groupId) ids.add(groupId);
    }
    return [...ids].map((groupId) => {
      const { runningSessionIds, queuedSessionIds, waitingSessionIds } = this.activityOf(groupId);
      return { groupId, runningSessionIds, queuedSessionIds, waitingSessionIds };
    });
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

  /** Test/diagnostic view of one chain's counters (live or recently retired). */
  chainSnapshot(chainId: string): Readonly<Omit<ChainState, "wakesByMember">> & {
    wakesByMember: Record<string, number>;
  } {
    const chain = this.chains.get(chainId) ?? this.retiredChains.get(chainId);
    if (!chain) throw new Error(`Unknown chain ${chainId}`);
    return { ...chain, wakesByMember: Object.fromEntries(chain.wakesByMember) };
  }

  /** Chains still tracked (some wake of theirs is queued, running or gated). */
  liveChainIds(): string[] {
    return [...this.chains.keys()];
  }

  isAwaitingUser(sessionId: string): boolean {
    return this.awaitingUser.has(sessionId);
  }

  /** True while the gated-queue retry timer is armed. */
  hasPendingRetry(): boolean {
    return this.retryTimer !== undefined;
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

  /** App quit: stop retrying and drop queued wakes (running turns are the agent runtime's). */
  dispose(): void {
    this.disposed = true;
    this.clearRetry();
    this.queues.clear();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
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
   * Drops chains with no queued, running or gated wake: nothing can post into
   * or route from them any more (ended ones, and ones that simply went quiet).
   */
  private retireIdleChains(): void {
    const busy = new Set<string>();
    for (const wake of this.running.values()) busy.add(wake.chainId);
    for (const wake of this.gated.values()) busy.add(wake.chainId);
    for (const queue of this.queues.values()) for (const wake of queue) busy.add(wake.chainId);
    for (const [chainId, chain] of this.chains) {
      if (busy.has(chainId)) continue;
      this.chains.delete(chainId);
      this.retiredChains.set(chainId, chain);
    }
    while (this.retiredChains.size > RETIRED_CHAIN_HISTORY) {
      const oldest = this.retiredChains.keys().next().value;
      if (oldest === undefined) break;
      this.retiredChains.delete(oldest);
    }
  }

  /**
   * Wake rules: a user message with no mention wakes only the lead; @mentions
   * wake the mentioned members; an author never wakes itself; a reply does not
   * wake the replied-to author unless it is mentioned; agents without mentions
   * wake nobody.
   */
  private wakeTargets(
    group: AgentGroupInfo,
    message: GroupMessage,
    explicitTargets?: readonly string[],
    allowSelf = false,
  ): string[] {
    if (explicitTargets) {
      const memberIds = new Set(listAgentGroupMembers(group.id).map((member) => member.sessionId));
      return [...new Set(explicitTargets)].filter(
        (id) => memberIds.has(id) && (allowSelf || id !== message.authorSessionId),
      );
    }
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

  /**
   * `allowSelf` (with explicit targets) is the one exception to "an author
   * never wakes itself": the worktree re-wake (see applyWorktreeRewake).
   */
  private route(
    chain: ChainState,
    message: GroupMessage,
    explicitTargets?: readonly string[],
    allowSelf = false,
  ): void {
    if (chain.ended) return;
    const group = getAgentGroup(chain.groupId);
    if (!group) return;
    const members = membersOf(group.id);
    // A blocked group (no folder, or fewer than 2 members) is read-only: nobody is woken.
    if (groupBlockedReason(group, members)) return;
    const wanted = this.wakeTargets(group, message, explicitTargets, allowSelf);
    // An archived agent stays a member but is never woken: say so instead.
    const archived = wanted.filter(
      (id) => members.find((member) => member.sessionId === id)?.archived,
    );
    for (const id of archived) this.postArchived(chain, members, id);
    const targets = wanted.filter((id) => !archived.includes(id));
    if (targets.length === 0) return;
    const history = listGroupMessages(group.id, {
      before: { createdAt: message.createdAt, id: message.id },
      limit: 100,
    });
    // Shared context (PR 6): part of every member's prompt, so of the chain budget too.
    const decisions = listGroupDecisions(group.id);
    const leadSessionId = group.leadSessionId;
    const coordinating = isCoordinatorModeActive(group) && leadSessionId !== undefined;
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
      const compose = (current: AgentGroupInfo, roster: readonly MemberRef[]) => {
        const instructions = instructionsOf(current.id, sessionId);
        return composeGroupWakePrompt({
          group: current,
          members: roster,
          sessionId,
          ...(instructions ? { instructions } : {}),
          trigger: message,
          history,
          decisions,
          ...(coordinating && sessionId === leadSessionId
            ? { snapshot: this.snapshotFor(current.id, leadSessionId, roster) }
            : {}),
          maxContextTokens: this.limits.maxEstimatedContextTokensPerWake,
        });
      };
      const prompt = compose(group, members);
      if (prompt === undefined) {
        this.endChain(chain, "context-too-large");
        break;
      }
      const tokens = estimateGroupTokens(prompt);
      if (chain.inputTokens + tokens > this.limits.maxEstimatedInputTokens) {
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
        compose: () => {
          const current = getAgentGroup(group.id);
          return current ? compose(current, membersOf(current.id)) : undefined;
        },
      });
    }
    this.emitActivity(group.id);
    this.pump();
  }

  /** "<name> is archived": a status line in place of the wake (wakes nobody). */
  private postArchived(chain: ChainState, members: readonly MemberRef[], sessionId: string): void {
    const name = members.find((member) => member.sessionId === sessionId)?.title ?? sessionId;
    try {
      this.emitMessage(
        appendGroupMessage({
          createdAt: this.stamp(),
          groupId: chain.groupId,
          authorKind: "system",
          kind: "status",
          body: GROUP_STATUS_TEXT.archived(name),
          chainId: chain.chainId,
        }),
      );
    } catch (error) {
      console.warn("[modus] group archived status failed:", error);
    }
  }

  /**
   * Ends a chain (blocked, gate or any limit): nothing new is woken in it and
   * its queued (not yet started) wakes are dropped; turns already running
   * finish and post but wake nobody.
   */
  private endChain(chain: ChainState, reason: GroupChainEndReason): void {
    if (chain.ended) return;
    chain.ended = reason;
    for (const [sessionId, queue] of this.queues) {
      const kept = queue.filter((wake) => wake.chainId !== chain.chainId);
      if (kept.length === 0) this.queues.delete(sessionId);
      else this.queues.set(sessionId, kept);
    }
    if (this.queuedCount() === 0) this.clearRetry();
    // blocked / stopped: the member (or the user) already said why.
    if (reason !== "blocked" && reason !== "stopped") {
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
    if (this.disposed) return;
    if (this.queuedCount() === 0) {
      this.clearRetry();
      return;
    }
    const window = this.host.getWindow();
    if (!window || this.host.isUpdatePending()) {
      this.scheduleRetry();
      return;
    }
    let gated = false;
    while (this.running.size < this.maxConcurrent) {
      const heads = [...this.queues.entries()]
        // One group turn per member: a gated turn is still pending in that session.
        .filter(([sessionId]) => !this.running.has(sessionId) && !this.gated.has(sessionId))
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
    if (gated && this.queuedCount() > 0) this.scheduleRetry();
    else if (this.queuedCount() === 0) this.clearRetry();
  }

  /** Armed only while wakes are queued behind a gate (window, update, streaming). */
  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.pump();
    }, this.retryDelayMs);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private start(window: BrowserWindowType, wake: Wake): void {
    this.running.set(wake.sessionId, wake);
    this.emitActivity(wake.groupId);
    let turn: Promise<PromptTurnResult>;
    try {
      turn = this.runtime.prompt(window, {
        sessionId: wake.sessionId,
        message: this.freshPrompt(wake),
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

  /** The wake prompt rebuilt at start (current roster); the queued one on failure. */
  private freshPrompt(wake: Wake): string {
    try {
      return wake.compose?.() ?? wake.prompt;
    } catch (error) {
      console.warn("[modus] group wake prompt rebuild failed:", error);
      return wake.prompt;
    }
  }

  private finishTurn(wake: Wake, result: PromptTurnResult): void {
    if (this.running.get(wake.sessionId) === wake) this.running.delete(wake.sessionId);
    if (this.gated.get(wake.sessionId) === wake) this.gated.delete(wake.sessionId);
    const chain = this.chains.get(wake.chainId);
    const stillMember = listAgentGroupMembers(wake.groupId).some(
      (member) => member.sessionId === wake.sessionId,
    );
    if (chain && stillMember) {
      try {
        if (wake.gated) this.applyGatedTurnResult(chain, wake, result);
        else if (wake.worktreeBranch && result.outcome === "ok") {
          this.applyWorktreeRewake(chain, wake, wake.worktreeBranch);
        } else this.applyTurnResult(chain, wake, result);
      } catch (error) {
        console.warn("[modus] group turn post failed:", error);
      }
    }
    this.emitActivity(wake.groupId);
    this.pump();
    this.retireIdleChains();
    this.settleIdle();
  }

  private postReply(chain: ChainState, wake: Wake, text: string): GroupMessage {
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
    return message;
  }

  private postMemberStatus(chain: ChainState, wake: Wake, body: string): void {
    this.emitMessage(
      appendGroupMessage({
        createdAt: this.stamp(),
        groupId: wake.groupId,
        authorKind: "agent",
        authorSessionId: wake.sessionId,
        kind: "status",
        body,
        chainId: chain.chainId,
      }),
    );
  }

  private applyTurnResult(chain: ChainState, wake: Wake, result: PromptTurnResult): void {
    const text = result.finalText?.trim();
    if (result.outcome === "ok") {
      if (!text) return; // An empty turn posts nothing.
      // An ended chain (blocked / limit) still shows the reply but wakes nobody.
      this.route(chain, this.postReply(chain, wake, text));
      return;
    }
    this.postMemberStatus(chain, wake, statusText(result.outcome));
    if (result.outcome === "blocked") {
      // Not gated, so a HyperPlan choice is pending: plan-build unblocks it.
      this.awaitingUser.set(wake.sessionId, chain.chainId);
      this.endChain(chain, "blocked");
    }
  }

  /**
   * The turn ended after group_start_worktree moved the member's cwd (PI
   * `terminate`, so outcome `ok`, never "Turn stopped"). Posts "Worktree
   * ready" as the member (a status: wakes nobody) and re-wakes the SAME member
   * in the SAME chain with the SAME trigger message, counting a hop and the
   * member's wakes like any wake. An ended chain or a hit limit wakes nobody;
   * the cwd stays saved either way. The ended turn's own text is not posted:
   * the re-woken turn gives the reply.
   */
  private applyWorktreeRewake(chain: ChainState, wake: Wake, branch: string): void {
    this.postMemberStatus(chain, wake, GROUP_STATUS_TEXT.worktreeReady(branch));
    const trigger = getGroupMessage(wake.triggerMessageId);
    if (trigger) this.route(chain, trigger, [wake.sessionId], true);
  }

  /**
   * A turn that waited at the intent gate settled. Its chain already ended, so
   * nothing it posts wakes anyone; the user writes in the room to go on.
   * Proceed → the result posts; refusal (Cancel / skip → `blocked`) → "Turn stopped".
   */
  private applyGatedTurnResult(chain: ChainState, wake: Wake, result: PromptTurnResult): void {
    const text = result.finalText?.trim();
    if (result.outcome === "ok") {
      if (text) this.postReply(chain, wake, text);
      return;
    }
    this.postMemberStatus(
      chain,
      wake,
      result.outcome === "blocked" ? GROUP_STATUS_TEXT.aborted : statusText(result.outcome),
    );
  }

  /** The coordinating Lead's "Group snapshot" (the Lead itself counts as working: it is being woken). */
  private snapshotFor(groupId: string, leadSessionId: string, members: readonly MemberRef[]) {
    const activity = this.activityOf(groupId);
    const working = new Set([...activity.runningSessionIds, ...activity.queuedSessionIds]);
    const waiting = new Set(activity.waitingSessionIds);
    const prefix = memberWorktreeBranchPrefix(groupId);
    return composeGroupSnapshotSection({
      sessionId: leadSessionId,
      leadSessionId,
      members: members.map((member) => {
        const branch = getAgentSession(member.sessionId)?.subagentWorktree?.branch;
        return {
          sessionId: member.sessionId,
          title: member.title,
          state:
            member.sessionId === leadSessionId || working.has(member.sessionId)
              ? "working"
              : waiting.has(member.sessionId)
                ? "waiting"
                : "idle",
          ...(branch?.startsWith(prefix) ? { branch } : {}),
        };
      }),
      tasks: listGroupTasks(groupId),
    });
  }

  private activityOf(groupId: string): {
    working: boolean;
    runningSessionIds: string[];
    queuedSessionIds: string[];
    waitingSessionIds: string[];
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
    // Waiting for the user: a turn at the intent gate, or a HyperPlan choice pending.
    const waiting = new Set(
      [...this.gated.values()]
        .filter((wake) => wake.groupId === groupId)
        .map((wake) => wake.sessionId),
    );
    for (const sessionId of this.awaitingUser.keys()) {
      if (getAgentGroupForSession(sessionId)?.id === groupId) waiting.add(sessionId);
    }
    return {
      working: runningSessionIds.length > 0 || queuedSessionIds.length > 0,
      runningSessionIds,
      queuedSessionIds,
      waitingSessionIds: [...waiting],
    };
  }

  private emitActivity(groupId: string): void {
    const { runningSessionIds, queuedSessionIds, waitingSessionIds } = this.activityOf(groupId);
    this.host.emit({
      type: "group.activity",
      groupId,
      runningSessionIds,
      queuedSessionIds,
      waitingSessionIds,
    });
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
