import type { BrowserWindow as BrowserWindowType } from "electron";
import type {
  AgentEvent,
  AgentGroupInfo,
  GroupChainEndReason,
  GroupDecision,
  GroupMessage,
  GroupRuntimeEvent,
  GroupTask,
  UpdateState,
} from "../../shared/contracts";
import {
  GROUP_COLLAB_NO_NEXT_OWNER,
  GROUP_COLLAB_WAKE_PROTOCOL,
} from "../../shared/group-collab-status";
import type { SupervisedDelegation } from "../../shared/group-supervised-flow";
import {
  autonomousWakeEligible,
  parseGroupMentions as parseSharedGroupMentions,
} from "../../shared/group-wake-rules";
import type { GroupTaskGateResult } from "../../shared/group-work-state";
import type { ToolProfileName } from "../../shared/tools";
import type {
  PromptAgentInput,
  PromptTurnOutcome,
  PromptTurnResult,
  TurnSettledEvent,
} from "../agent/runtime";
import { getAgent } from "../agents/agents-store";
import { loadGroupProjectContextSection } from "./group-project-context-slice";
import { listAgentGroupMembers } from "./group-store";

/**
 * Agent Groups runtime (PR 3): routes room messages to member sessions as
 * ordinary `normal` prompts and posts their replies back into the room.
 *
 * A *chain* is everything that follows one user action (a user message, or the
 * user unblocking a member). Resource limits are per chain. Reaching one stops
 * new handoffs while already queued turns finish; explicit blocks and Stop
 * still cancel queued work.
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
  /**
   * Agent finished with no @mention and no Agreed/Blocked/Proposed/Ready (P0b).
   * Posted as a member status — wakes nobody.
   */
  noNextOwner: GROUP_COLLAB_NO_NEXT_OWNER,
  /** A member's turn ended to move into its worktree (then it is re-woken there). */
  worktreeReady: (branch: string) => `Worktree ready: \`${branch}\``,
  archived: (name: string) => `${name} is archived`,
  limit: {
    "max-agent-messages": `Automatic handoffs paused: this chain reached its limit of ${GROUP_CHAIN_LIMITS.maxAgentMessages} agent messages. Already queued turns will finish.`,
    "max-member-wakes": `Automatic handoffs paused: a member was already woken ${GROUP_CHAIN_LIMITS.maxWakesPerMember} times in this chain. Already queued turns will finish.`,
    "input-token-budget": `Automatic handoffs paused: this chain used its estimated ${ESTIMATED_INPUT_TOKENS_PER_CHAIN / 1000}k-token budget of group prompts. Already queued turns will finish.`,
    "context-too-large": `Automatic handoffs paused: the message does not fit the estimated ${ESTIMATED_CONTEXT_TOKENS_PER_WAKE / 1000}k-token group context of a turn. Already queued turns will finish.`,
  } satisfies Record<Exclude<GroupChainEndReason, "blocked" | "stopped">, string>,
} as const;

/** An update is about to restart the app: new group turns wait (`ready` alone does not hold them). */
export function isUpdatePendingState(state: UpdateState): boolean {
  return state.status === "waiting-for-agents" || state.status === "installing";
}

/** The slice of the agent runtime the group runtime needs (PiSdkRuntime satisfies it). */
export type GroupAgentRuntime = {
  prompt(window: BrowserWindowType, input: PromptAgentInput): Promise<PromptTurnResult>;
  /** Effective tools for the profile used by the next prompt, including runtime filters. */
  getActiveToolNames?(sessionId: string, profile: ToolProfileName): readonly string[] | undefined;
  /** Stops a session's running turn (it settles as `aborted`). */
  abort(sessionId: string): Promise<void>;
  isSessionStreaming(sessionId: string): boolean;
  /** Every settled turn (unblocks a HyperPlan-blocked member). */
  onTurnSettled(listener: (event: TurnSettledEvent) => void): () => void;
  /** The intent gate opened on a session (a group turn there frees its slot). */
  onQuestionPending(listener: (sessionId: string) => void): () => void;
  onEvent?(listener: (event: AgentEvent) => void): () => void;
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
  taskId?: string;
  /** Control notifications request help; they do not dispatch the task's current stage. */
  purpose?: "task" | "control";
  operationId?: string;
  sourceEventId?: string;
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

/** Validate a concrete delegation without granting tools or changing the task. */
export type GroupTaskDispatchInput = {
  groupId: string;
  actorSessionId: string;
  targetSessionId: string;
  task?: GroupTask;
};

/** A stored status does not by itself prove that a recipient turn was queued. */
export type GroupTaskWakeResult = GroupMessage & { deliveryNotice?: string };

/** group_start_worktree moved a member's cwd (see GroupRuntime.handleWorktreeReady). */
export type GroupWorktreeReady = { groupId: string; sessionId: string; branch: string };

export type GroupRuntimeOptions = {
  runtime: GroupAgentRuntime;
  host: GroupRuntimeHost;
  limits?: Partial<GroupChainLimits>;
  maxConcurrentTurns?: number;
  /** How long a gated queue (no window, update pending, member streaming) waits before retrying. */
  retryDelayMs?: number;
  turnTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Only the app singleton recovers jobs; disposable test/runtime instances opt in. */
  recoverPending?: boolean;
};

export type ChainState = {
  groupId: string;
  chainId: string;
  hops: number;
  agentMessages: number;
  inputTokens: number;
  wakesByMember: Map<string, number>;
  ended?: GroupChainEndReason;
  /** Persisted idle retirement fences late controller decisions after restart. */
  retired?: boolean;
};

export type Wake = {
  id?: string;
  messageId?: string;
  runId?: string;
  /** Unique user-message identity for this concrete prompt attempt. */
  promptUserMessageId?: string;
  publicMessageIds?: Map<string, string>;
  assistantMessageIds?: Set<string>;
  questionRequestIds?: Set<string>;
  pausedAt?: number | undefined;
  cancelled?: boolean;
  startedAt?: number;
  lastProgressAt?: number;
  lastEventCursor?: number;
  error?: string;
  watchdog?: ReturnType<typeof setTimeout> | undefined;
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
  /** Control wakes deliver a request about a task without running that task. */
  purpose?: "task" | "control";
  /** group_start_worktree moved the member's cwd during this turn: re-wake it there. */
  worktreeBranch?: string;
};

/** Ended/finished chains kept for chainSnapshot diagnostics (bounded). */
export const RETIRED_CHAIN_HISTORY = 20;

/** Rough token estimate used for the chain budget and the per-wake context cap. */
export function estimateGroupTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A member as the room sees it: session id (the key) → its agent's name and role. */
export type MemberRef = {
  sessionId: string;
  /** The agent's CURRENT display name: `@Name` mentions follow a rename. */
  title: string;
  /** Role in this group, else the agent's role (title). */
  role?: string;
  /** Short description of the agent (agentDescription). */
  description?: string;
  archived?: boolean;
  capabilityIds?: readonly string[];
  supportedTaskKinds?: readonly string[];
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
export function membersOf(groupId: string): MemberRef[] {
  return listAgentGroupMembers(groupId).map((member) => {
    const role = member.role?.trim() || member.agentRole?.trim();
    const description = agentDescription(getAgent(member.agentId)?.instructions);
    return {
      sessionId: member.sessionId,
      title: member.name,
      ...(role ? { role } : {}),
      ...(description ? { description } : {}),
      ...(member.archived ? { archived: true } : {}),
      capabilityIds: member.capabilityIds ?? [],
      supportedTaskKinds: member.supportedTaskKinds ?? [],
    };
  });
}

/** The member's agent persona (its `instructions`), for the top of its wake prompt. */
export function instructionsOf(groupId: string, sessionId: string): string | undefined {
  const agentId = listAgentGroupMembers(groupId).find(
    (member) => member.sessionId === sessionId,
  )?.agentId;
  const instructions = agentId ? getAgent(agentId)?.instructions.trim() : undefined;
  return instructions || undefined;
}

/**
 * The member's current agent `modelId`, read fresh on every wake so an Edit-agent
 * Model change applies on the next turn (the session row may still be stale until
 * Save rebinds it; the prompt path also applies this authoritatively).
 */
export function modelIdOf(groupId: string, sessionId: string): string | null | undefined {
  const agentId = listAgentGroupMembers(groupId).find(
    (member) => member.sessionId === sessionId,
  )?.agentId;
  const modelId = agentId ? getAgent(agentId)?.modelId : undefined;
  return groupTurnModelResolver(modelId || undefined, sessionId);
}

/**
 * The model a group-room turn runs on. `null` explicitly selects the current app default and
 * overrides a stale runtime model; `undefined` leaves a restored/legacy session untouched.
 * main/ipc installs the authoritative availability check; without it, the agent model passes
 * through unchanged.
 */
export type GroupTurnModelResolver = (
  agentModelId: string | undefined,
  sessionId: string,
) => string | null | undefined;

let groupTurnModelResolver: GroupTurnModelResolver = (agentModelId) => agentModelId;

export function setGroupTurnModelResolver(resolver: GroupTurnModelResolver | undefined): void {
  groupTurnModelResolver = resolver ?? ((agentModelId) => agentModelId);
}

/**
 * Member session ids mentioned in `text` (moved to `shared/group-wake-rules`
 * so the renderer's model chip parses mentions exactly like the runtime).
 */
export function parseGroupMentions(text: string, members: readonly MemberRef[]): string[] {
  return parseSharedGroupMentions(text, members);
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
  gates?: Record<string, GroupTaskGateResult>;
  delegations?: Record<string, readonly SupervisedDelegation[]>;
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
    "Match the user's language. Sound natural, warm, and direct; default to 1–3 short sentences, adding detail when the user asks or the result requires it.",
    "Send one concise public response per turn. Do not narrate internal reasoning, tool calls, or routine work steps.",
    "After meaningful peer work, briefly thank the teammate and add specific feedback when useful. Avoid generic praise, numerical ratings, or social scoring.",
    "Requested or required task reviews still follow the typed Group review workflow; social feedback does not replace a review.",
    "As Lead, consolidate contributing members' results into one public response; specialists should not duplicate it.",
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
    const line =
      task.kind && task.kind !== "legacy"
        ? escapeText(
            `- task ${task.id} [${task.status}] kind=${task.kind} priority=${task.priority ?? "normal"} stage=${task.stage ?? "unset"} dependencies=${JSON.stringify(task.dependencyIds ?? [])} verification=${JSON.stringify(task.verificationPolicy ?? { mode: "none", requireReview: false })} gate=${JSON.stringify(input.gates?.[task.id] ?? { satisfied: false, reasonCodes: ["gate-unavailable"] })} delegations=${JSON.stringify(input.delegations?.[task.id] ?? [])} "${task.title}" owner=${who(task.ownerSessionId)} reviewer=${who(task.reviewerSessionId)}`,
          )
        : escapeText(
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

/** Untyped messages go to the active Lead; an archived configured Lead falls back to active members. */
export function selectAutonomousWakeTargets(input: {
  body: string;
  members: readonly MemberRef[];
  leadSessionId?: string;
  excludeSessionIds?: readonly string[];
  openTasks?: readonly Pick<
    GroupTask,
    "status" | "title" | "ownerSessionId" | "reviewerSessionId"
  >[];
  maxTargets?: number;
}): string[] {
  const eligible = autonomousWakeEligible(input.members, input.excludeSessionIds ?? []);
  const lead = eligible.find((member) => member.sessionId === input.leadSessionId);
  const configuredLead = input.members.find((member) => member.sessionId === input.leadSessionId);
  const targets = lead
    ? [lead.sessionId]
    : configuredLead?.archived
      ? eligible.map((member) => member.sessionId)
      : [];
  return input.maxTargets === undefined ? targets : targets.slice(0, Math.max(0, input.maxTargets));
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
  /**
   * Typed task flow for its Lead, owner, or reviewer (composeSupervisedFlowSection).
   * Empty / omitted when no active typed task is linked to this execution.
   */
  supervisedFlow?: string;
  /** The woken member's agent persona; first in the prompt when set. */
  instructions?: string;
  /** Role-scoped shared Project Model slice (consult map before broad search). */
  projectContext?: string;
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
    return `- @${member.title}${member.role ? ` [${member.role}]` : ""}${tags}${about} (sessionId: ${member.sessionId})`;
  });
  const persona = input.instructions?.trim()
    ? `<agent_instructions>\n${escapeText(input.instructions.trim())}\n</agent_instructions>`
    : "";
  const header = [
    `<group_room name="${escapeText(input.group.name)}">`,
    `You are @${escapeText(self)}, a member of this group. Members right now:`,
    ...roster.map((line) => escapeText(line)),
    `<group_member_capabilities>${escapeText(JSON.stringify(input.members.map((member) => ({ sessionId: member.sessionId, capabilityIds: member.capabilityIds ?? [], supportedTaskKinds: member.supportedTaskKinds ?? [] }))))}</group_member_capabilities>`,
    "Reply with what the group should read — short and natural. Mentions identify people; they do not dispatch work. Delegate through group task tools using the target sessionId from the roster. The user can direct a task with @Name.",
    "Use group_get_work_state for authoritative task versions, stages, blockers, dependencies and QA summaries. Pass expectedVersion and a stable operationId for task writes. group_report_progress clears a blocker with blockedReason=null; group_agree and review approval require current evidence. Handoff with taskTitle creates and assigns atomically.",
    "Before delegating a typed task, check the recipient's declared capabilityIds and supportedTaskKinds against the current task stage. Names and role labels are not capabilities. Empty metadata needs the user to configure the agent; report this once and stop retrying the same delegation. A code task at plan needs plan; its active owner must explicitly advance it to implement before handing it to an implementer. After requested changes, read group_get_work_state: code/docs/research tasks return from review/verify/deliver to implement, while design/questions return to plan. A rejected dispatch did not start the recipient; do not claim otherwise or retry until the reason changes.",
    "If the trigger is a greeting or social ping and you have nothing useful to add, reply empty and stay silent. Do not explore files or start tools without a real objective.",
    GROUP_COLLAB_WAKE_PROTOCOL,
  ].join("\n");
  const triggerBlock = `<group_message from="${escapeText(authorLabel(input.trigger, titles))}">\n${escapeText(input.trigger.body)}\n</group_message>`;
  const footer = "</group_room>";
  const decisions = composeGroupDecisionsSection(input.decisions ?? [], titles);
  const snapshot = input.snapshot ?? "";
  const supervisedFlow = input.supervisedFlow?.trim() ?? "";
  const member = input.members.find((row) => row.sessionId === input.sessionId);
  const projectContext =
    input.projectContext?.trim() ||
    (input.group.workspaceId
      ? (loadGroupProjectContextSection({
          workspaceId: input.group.workspaceId,
          ...(member?.role ? { role: member.role } : {}),
          prompt: input.trigger.body,
        }) ?? "")
      : "");
  let used = estimateGroupTokens(
    [persona, header, projectContext, snapshot, supervisedFlow, decisions, triggerBlock, footer]
      .filter(Boolean)
      .join("\n"),
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
  return [
    persona,
    header,
    projectContext,
    snapshot,
    supervisedFlow,
    decisions,
    history,
    triggerBlock,
    footer,
  ]
    .filter(Boolean)
    .join("\n");
}

export function statusText(outcome: PromptTurnOutcome): string {
  switch (outcome) {
    case "blocked":
      return GROUP_STATUS_TEXT.waitingForYou;
    case "aborted":
      return GROUP_STATUS_TEXT.aborted;
    default:
      return GROUP_STATUS_TEXT.failed;
  }
}
