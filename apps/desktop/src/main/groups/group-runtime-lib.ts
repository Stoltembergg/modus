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
import { isCoordinatorModeActive } from "../../shared/group-coordinator";
import {
  composeSupervisedFlowSection,
  planSupervisedCodeFlow,
} from "../../shared/group-supervised-flow";
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
  /**
   * Agent finished with no @mention and no Agreed/Blocked/Proposed/Ready (P0b).
   * Posted as a member status — wakes nobody.
   */
  noNextOwner: GROUP_COLLAB_NO_NEXT_OWNER,
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
export function isUpdatePendingState(