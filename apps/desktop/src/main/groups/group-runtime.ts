import type { BrowserWindow as BrowserWindowType } from "electron";
import type {
  AgentEvent,
  AgentGroupInfo,
  GroupChainEndReason,
  GroupMemberStates,
  GroupMessage,
  GroupRuntimeEvent,
  PostGroupMessageInput,
} from "../../shared/contracts";
import {
  GROUP_BLOCKED_TEXT,
  groupBlockedErrorCode,
  groupBlockedReason,
} from "../../shared/group-blocked";
import { isCoordinatorModeActive } from "../../shared/group-coordinator";
import { getAgentSession } from "../agent/agent-store";
import { isHyperPlanSessionReserved } from "../agent/harness/hyperplan-draft-store";
import type { PromptTurnResult, TurnSettledEvent } from "../agent/runtime";
import { getDatabase } from "../db/database";
import {
  listRecoverableGroupJobs,
  persistGroupChain,
  persistGroupJob,
  readGroupChain,
  updateGroupJob,
} from "./group-job-store";
import {
  type ChainState,
  composeGroupSnapshotSection,
  composeGroupWakePrompt,
  estimateGroupTokens,
  GROUP_CHAIN_LIMITS,
  GROUP_MAX_CONCURRENT_TURNS,
  GROUP_STATUS_TEXT,
  type GroupAgentRuntime,
  type GroupChainLimits,
  type GroupRuntimeHost,
  type GroupRuntimeOptions,
  type GroupTaskWake,
  type GroupWorktreeReady,
  instructionsOf,
  type MemberRef,
  membersOf,
  modelIdOf,
  parseGroupMentions,
  RETIRED_CHAIN_HISTORY,
  selectAutonomousWakeTargets,
  type Wake,
} from "./group-runtime-lib";
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
import { GroupTurnTranscript } from "./group-turn-transcript";

export {
  agentDescription,
  composeGroupDecisionsSection,
  composeGroupSnapshotSection,
  composeGroupWakePrompt,
  ESTIMATED_CONTEXT_TOKENS_PER_WAKE,
  ESTIMATED_INPUT_TOKENS_PER_CHAIN,
  estimateGroupTokens,
  GROUP_CHAIN_LIMITS,
  GROUP_MAX_CONCURRENT_TURNS,
  GROUP_PROMPT_DECISIONS_MAX_ITEMS,
  GROUP_PROMPT_DECISIONS_MAX_TOKENS,
  GROUP_PROMPT_SNAPSHOT_MAX_TOKENS,
  GROUP_ROSTER_DESCRIPTION_MAX_CHARS,
  GROUP_STATUS_TEXT,
  type GroupAgentRuntime,
  type GroupChainLimits,
  type GroupRuntimeHost,
  type GroupRuntimeOptions,
  type GroupSnapshotMember,
  type GroupTaskWake,
  type GroupWorktreeReady,
  isSimpleSocialMessage,
  isUpdatePendingState,
  parseGroupMentions,
  selectAutonomousWakeTargets,
} from "./group-runtime-lib";

export class GroupRuntime {
  private readonly runtime: GroupAgentRuntime;
  private readonly host: GroupRuntimeHost;
  private readonly limits: GroupChainLimits;
  private readonly maxConcurrent: number;
  private readonly retryDelayMs: number;
  private readonly turnTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly transcript: GroupTurnTranscript;
  /** Cancelled sessions remain fenced until their owning prompt settles. */
  private readonly cancelling = new Map<string, Wake>();
  private lastServedGroupId: string | undefined;
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
  private dispatching = false;
  private bufferedEvents: GroupRuntimeEvent[] = [];
  private readonly unsubscribers: Array<() => void>;

  constructor(options: GroupRuntimeOptions) {
    this.runtime = options.runtime;
    this.host = options.host;
    this.limits = { ...GROUP_CHAIN_LIMITS, ...options.limits };
    this.maxConcurrent = options.maxConcurrentTurns ?? GROUP_MAX_CONCURRENT_TURNS;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 15 * 60_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 3 * 60_000;
    this.transcript = new GroupTurnTranscript((message) => this.emitMessage(message));
    this.unsubscribers = [
      this.runtime.onTurnSettled((event) => this.handleTurnSettled(event)),
      this.runtime.onQuestionPending((sessionId) => this.handleQuestionPending(sessionId)),
    ];
    if (this.runtime.onEvent)
      this.unsubscribers.push(this.runtime.onEvent((event) => this.handleAgentEvent(event)));
    if (options.recoverPending) this.recoverJobs();
  }

  /** A user message into the room: always opens a new chain (counters reset). */
  postUserMessage(input: PostGroupMessageInput): GroupMessage {
    const message = this.durableDispatch(() => this.saveUserMessage(input));
    this.supersedeWaiting(input.groupId);
    this.pump();
    return message;
  }

  private saveUserMessage(input: PostGroupMessageInput): GroupMessage {
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
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
      ...(input.contextItems && input.contextItems.length > 0
        ? { contextItems: input.contextItems }
        : {}),
    });
    this.emitMessage(message);
    const chain = this.openChain(input.groupId, message.id);
    this.route(chain, message);
    this.retireIdleChains();
    return message;
  }

  /**
   * The intent gate opened its question on a session (`onQuestionPending`).
   * For a turn the group started: update its canonical card, end the chain
   * (its queued wakes drop) and release the turn's concurrency slot. The
   * matching question remains visible in the room until the user answers.
   */
  handleQuestionPending(sessionId: string): void {
    const wake = this.running.get(sessionId);
    if (!wake) return;
    this.running.delete(sessionId);
    wake.gated = true;
    wake.pausedAt = Date.now();
    this.clearWatchdog(wake);
    updateGroupJob(wake, "awaiting_user");
    this.transcript.setState(wake, "awaiting_user");
    this.gated.set(sessionId, wake);
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
    // A public mention in the result is not a task assignment.
    persistGroupChain(chain);
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
    if (this.disposed || this.cancelling.has(input.actorSessionId)) return undefined;
    const message = this.durableDispatch(() => this.saveTaskWake(input));
    this.pump();
    return message;
  }

  private saveTaskWake(input: GroupTaskWake): GroupMessage | undefined {
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
   * running or question-gated turns are aborted. Their canonical cards keep
   * partial public text and finish as cancelled. With no active work it does
   * nothing.
   */
  stopGroup(groupId: string): void {
    const queued = [...this.queues.values()].flat().filter((wake) => wake.groupId === groupId);
    const running = [...this.running.values()].filter((wake) => wake.groupId === groupId);
    const waiting = [...this.gated.values()].filter((wake) => wake.groupId === groupId);
    const awaiting = [...this.awaitingUser.keys()].filter(
      (id) => getAgentGroupForSession(id)?.id === groupId,
    );
    if (
      queued.length === 0 &&
      running.length === 0 &&
      waiting.length === 0 &&
      awaiting.length === 0
    )
      return;
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
    for (const wake of [...running, ...waiting]) this.cancelWake(wake, "cancelled");
    for (const id of awaiting) this.awaitingUser.delete(id);
    for (const { wake } of listRecoverableGroupJobs().filter(
      (job) => job.wake.groupId === groupId,
    )) {
      updateGroupJob(wake, "cancelled");
      this.transcript.setState(wake, "cancelled");
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
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const wake of [...this.running.values(), ...this.gated.values()]) {
      this.clearWatchdog(wake);
      wake.cancelled = true;
      updateGroupJob(wake, "interrupted");
      this.transcript.setState(
        wake,
        "interrupted",
        "The application closed during this turn. Resume explicitly to continue.",
      );
      void Promise.resolve()
        .then(() => this.runtime.abort(wake.sessionId))
        .catch((error) => console.warn("[modus] group shutdown abort failed:", error));
    }
    this.transcript.dispose();
    this.queues.clear();
    this.running.clear();
    this.gated.clear();
    this.settleIdle();
  }

  /* ── internals ────────────────────────────────────────────────────── */

  /** A request, its cards and every queued wake survive or roll back together. */
  private durableDispatch<T>(action: () => T): T {
    if (this.dispatching) return action();
    const db = getDatabase();
    const queues = new Map([...this.queues].map(([id, wakes]) => [id, [...wakes]]));
    const copyChains = (source: Map<string, ChainState>) =>
      new Map(
        [...source].map(([id, chain]) => [
          id,
          { ...chain, wakesByMember: new Map(chain.wakesByMember) },
        ]),
      );
    const chains = copyChains(this.chains);
    const retired = copyChains(this.retiredChains);
    const awaiting = new Map(this.awaitingUser);
    const seq = this.seq;
    this.dispatching = true;
    db.exec("savepoint group_dispatch");
    let result: T;
    try {
      result = action();
      db.exec("release group_dispatch");
    } catch (error) {
      db.exec("rollback to group_dispatch; release group_dispatch");
      this.queues.clear();
      for (const [id, wakes] of queues) this.queues.set(id, wakes);
      this.chains.clear();
      for (const [id, chain] of chains) this.chains.set(id, chain);
      this.retiredChains.clear();
      for (const [id, chain] of retired) this.retiredChains.set(id, chain);
      this.awaitingUser.clear();
      for (const [id, chainId] of awaiting) this.awaitingUser.set(id, chainId);
      this.seq = seq;
      this.bufferedEvents = [];
      throw error;
    } finally {
      this.dispatching = false;
    }
    const events = this.bufferedEvents;
    this.bufferedEvents = [];
    for (const event of events) this.host.emit(event);
    return result;
  }

  private recoverJobs(): void {
    for (const { wake, status } of listRecoverableGroupJobs()) {
      this.seq = Math.max(this.seq, wake.seq);
      const chain = readGroupChain(wake.chainId);
      if (status !== "pending") {
        const error = "Execution was interrupted by an app restart. Resume this task to continue.";
        updateGroupJob(wake, "interrupted", error);
        this.transcript.setState(wake, "interrupted", error);
        continue;
      }
      if (
        !chain ||
        chain.ended ||
        !membersOf(wake.groupId).some((m) => m.sessionId === wake.sessionId && !m.archived)
      ) {
        updateGroupJob(wake, "cancelled");
        this.transcript.setState(wake, "cancelled");
        continue;
      }
      this.chains.set(chain.chainId, chain);
      const queue = this.queues.get(wake.sessionId) ?? [];
      queue.push(wake);
      this.queues.set(wake.sessionId, queue);
      this.transcript.setState(wake, "queued");
    }
  }

  private supersedeWaiting(groupId: string): void {
    for (const wake of [...this.gated.values()]) {
      if (wake.groupId === groupId) this.cancelWake(wake, "cancelled");
    }
    for (const { wake, status } of listRecoverableGroupJobs()) {
      if (wake.groupId !== groupId || status !== "awaiting_user") continue;
      this.awaitingUser.delete(wake.sessionId);
      updateGroupJob(wake, "cancelled");
      this.transcript.setState(wake, "cancelled");
    }
    this.emitActivity(groupId);
  }

  private handleAgentEvent(event: AgentEvent): void {
    const wake = this.running.get(event.sessionId) ?? this.gated.get(event.sessionId);
    if (!wake || wake.cancelled || this.disposed) return;
    if (wake.runId && "runId" in event && event.runId && event.runId !== wake.runId) return;
    if (event.eventCursor !== undefined) {
      if (wake.lastEventCursor !== undefined && event.eventCursor <= wake.lastEventCursor) return;
      wake.lastEventCursor = event.eventCursor;
    }
    if (event.type === "run.failed") wake.error = event.message;
    if (event.type === "question.requested") {
      if (!wake.questionRequestIds) wake.questionRequestIds = new Set();
      wake.questionRequestIds.add(event.request.id);
    }
    if (
      event.type === "question.resolved" &&
      wake.gated &&
      wake.questionRequestIds?.delete(event.requestId)
    ) {
      this.gated.delete(wake.sessionId);
      wake.gated = false;
      if (wake.pausedAt !== undefined)
        wake.startedAt = (wake.startedAt ?? wake.pausedAt) + Date.now() - wake.pausedAt;
      wake.pausedAt = undefined;
      wake.lastProgressAt = Date.now();
      this.running.set(wake.sessionId, wake);
      updateGroupJob(wake, "running");
      this.transcript.setState(wake, "running");
      this.emitActivity(wake.groupId);
      this.armWatchdog(wake);
    }
    if (event.type !== "session.status") {
      wake.lastProgressAt = Date.now();
      this.armWatchdog(wake);
    }
    this.transcript.observe(wake, event);
  }

  private clearWatchdog(wake: Wake): void {
    if (wake.watchdog) clearTimeout(wake.watchdog);
    wake.watchdog = undefined;
  }

  private armWatchdog(wake: Wake): void {
    this.clearWatchdog(wake);
    if (this.disposed || wake.cancelled || wake.gated) return;
    const totalRemaining = this.turnTimeoutMs - (Date.now() - (wake.startedAt ?? Date.now()));
    const idleRemaining = this.idleTimeoutMs - (Date.now() - (wake.lastProgressAt ?? Date.now()));
    wake.watchdog = setTimeout(
      () => {
        this.cancelWake(
          wake,
          "failed",
          totalRemaining <= idleRemaining
            ? "This turn exceeded its execution time limit. Retry the task to continue."
            : "This agent stopped responding. Retry the task to continue.",
        );
      },
      Math.max(1, Math.min(totalRemaining, idleRemaining)),
    );
    wake.watchdog.unref?.();
  }

  private cancelWake(wake: Wake, status: "cancelled" | "failed", error?: string): void {
    if (wake.cancelled) return;
    wake.cancelled = true;
    this.clearWatchdog(wake);
    if (this.running.get(wake.sessionId) === wake) this.running.delete(wake.sessionId);
    if (this.gated.get(wake.sessionId) === wake) this.gated.delete(wake.sessionId);
    this.awaitingUser.delete(wake.sessionId);
    this.cancelling.set(wake.sessionId, wake);
    updateGroupJob(wake, status, error);
    this.transcript.setState(wake, status, error);
    void this.runtime
      .abort(wake.sessionId)
      .catch((abortError) => console.warn("[modus] group abort failed:", abortError));
    this.emitActivity(wake.groupId);
    this.pump();
    this.retireIdleChains();
    this.settleIdle();
  }

  /** Message sequence defines conversation order; these timestamps are metadata. */
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
    persistGroupChain(chain);
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
   * Wake rules (natural groups): @mentions wake those members; a reply wakes
   * the replied-to author (thread continuation). Untargeted user messages are
   * routed by specialty (Lead optional bias). Coordinator mode still wakes
   * only the Lead for untargeted user turns (snapshot). Agent→agent directed
   * messages (`toSessionId`) wake the recipient. An author never wakes itself.
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
    const members = membersOf(group.id);
    const memberIds = new Set(members.map((member) => member.sessionId));
    const repliedAuthor = message.replyToMessageId
      ? getGroupMessage(message.replyToMessageId)?.authorSessionId
      : undefined;
    let targets: string[];
    if (message.authorKind === "user") {
      if (message.mentions.length > 0) {
        targets = [...message.mentions];
      } else if (repliedAuthor) {
        // Thread reply without @ — continue with the person being answered.
        targets = [repliedAuthor];
      } else if (isCoordinatorModeActive(group) && group.leadSessionId) {
        targets = [group.leadSessionId];
      } else {
        const openTasks = listGroupTasks(group.id).filter(
          (task) =>
            task.status === "open" || task.status === "in_progress" || task.status === "in_review",
        );
        targets = selectAutonomousWakeTargets({
          body: message.body,
          members,
          ...(group.leadSessionId ? { leadSessionId: group.leadSessionId } : {}),
          openTasks,
        });
      }
    } else if (message.authorKind === "agent") {
      targets = []; // Only explicit task-tool targets dispatch agent work.
    } else {
      targets = [];
    }
    return [...new Set(targets)].filter(
      (id) => memberIds.has(id) && id !== message.authorSessionId,
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
      persistGroupChain(chain);
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
    persistGroupChain(chain);
    for (const [sessionId, queue] of this.queues) {
      for (const wake of queue.filter((wake) => wake.chainId === chain.chainId)) {
        updateGroupJob(wake, "cancelled");
        this.transcript.setState(
          wake,
          "cancelled",
          "The task chain ended before this turn started.",
        );
      }
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
    this.emitEvent({
      type: "group.chain-ended",
      groupId: chain.groupId,
      chainId: chain.chainId,
      reason,
    });
    this.emitActivity(chain.groupId);
    this.settleIdle();
  }

  private enqueue(wake: Wake): void {
    this.transcript.create(wake);
    persistGroupJob(wake);
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
    if (this.disposed || this.dispatching) return;
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
        .filter(
          ([sessionId]) =>
            !this.running.has(sessionId) &&
            !this.gated.has(sessionId) &&
            !this.cancelling.has(sessionId),
        )
        .map(([, queue]) => queue[0])
        .filter((wake): wake is Wake => Boolean(wake))
        .sort((a, b) => {
          const active = (id: string) =>
            [...this.running.values()].filter((w) => w.groupId === id).length;
          return (
            active(a.groupId) - active(b.groupId) ||
            Number(a.groupId === this.lastServedGroupId) -
              Number(b.groupId === this.lastServedGroupId) ||
            a.seq - b.seq
          );
        });
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
    this.lastServedGroupId = wake.groupId;
    wake.startedAt = wake.lastProgressAt = Date.now();
    updateGroupJob(wake, "running");
    this.transcript.setState(wake, "running");
    this.armWatchdog(wake);
    this.emitActivity(wake.groupId);
    let turn: Promise<PromptTurnResult>;
    try {
      const trigger = getGroupMessage(wake.triggerMessageId);
      const attachments = trigger?.attachments;
      const contextItems = (trigger?.contextItems ??
        []) as import("../../shared/contracts").ContextItem[];
      const model = modelIdOf(wake.groupId, wake.sessionId);
      turn = this.runtime.prompt(window, {
        sessionId: wake.sessionId,
        message: this.freshPrompt(wake),
        context: contextItems,
        delivery: "normal",
        ...(model ? { model } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
    } catch (error) {
      turn = Promise.reject(error);
    }
    turn
      .catch(
        (error): PromptTurnResult => ({
          outcome: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((result) => this.finishTurn(wake, result))
      .catch((error) => console.warn("[modus] group turn settle failed:", error));
  }

  /** The wake prompt rebuilt at start (current roster); the queued one on failure. */
  private freshPrompt(wake: Wake): string {
    const group = getAgentGroup(wake.groupId);
    const trigger = getGroupMessage(wake.triggerMessageId);
    if (!group || !trigger) throw new Error("The group or task no longer exists.");
    const members = membersOf(group.id);
    if (!members.some((m) => m.sessionId === wake.sessionId && !m.archived))
      throw new Error("This agent is no longer available in the group.");
    const instructions = instructionsOf(group.id, wake.sessionId);
    const history = listGroupMessages(group.id, { limit: 100 }).filter(
      (m) => m.id !== trigger.id && m.body.trim() && (!m.turnId || m.status === "completed"),
    );
    const prompt = composeGroupWakePrompt({
      group,
      members,
      sessionId: wake.sessionId,
      trigger,
      history,
      decisions: listGroupDecisions(group.id),
      ...(instructions ? { instructions } : {}),
      ...(isCoordinatorModeActive(group) && group.leadSessionId === wake.sessionId
        ? { snapshot: this.snapshotFor(group.id, wake.sessionId, members) }
        : {}),
      maxContextTokens: this.limits.maxEstimatedContextTokensPerWake,
    });
    if (!prompt) throw new Error("The refreshed task context exceeds the group context budget.");
    const chain = this.chains.get(wake.chainId);
    if (chain) {
      const tokens =
        chain.inputTokens + estimateGroupTokens(prompt) - estimateGroupTokens(wake.prompt);
      if (tokens > this.limits.maxEstimatedInputTokens)
        throw new Error("The refreshed task context exceeds the chain input budget.");
      chain.inputTokens = tokens;
      persistGroupChain(chain);
    }
    return prompt;
  }

  private finishTurn(wake: Wake, result: PromptTurnResult): void {
    if (wake.error && !result.error) result = { ...result, error: wake.error };
    this.clearWatchdog(wake);
    if (this.cancelling.get(wake.sessionId) === wake) this.cancelling.delete(wake.sessionId);
    if (this.disposed || wake.cancelled) {
      if (!this.disposed) {
        this.pump();
        this.settleIdle();
      }
      return;
    }
    if (this.running.get(wake.sessionId) === wake) this.running.delete(wake.sessionId);
    if (this.gated.get(wake.sessionId) === wake) this.gated.delete(wake.sessionId);
    const chain = this.chains.get(wake.chainId);
    const stillMember = listAgentGroupMembers(wake.groupId).some(
      (member) => member.sessionId === wake.sessionId,
    );
    if (!stillMember) {
      this.transcript.setState(
        wake,
        "interrupted",
        "This agent left the group before its turn finished.",
      );
      updateGroupJob(wake, "interrupted");
      this.emitActivity(wake.groupId);
      this.pump();
      this.retireIdleChains();
      this.settleIdle();
      return;
    }
    if (wake.worktreeBranch && result.outcome === "ok") result = { outcome: "ok" };
    const output = this.transcript.finish(wake, result);
    updateGroupJob(
      wake,
      result.outcome === "ok"
        ? "completed"
        : result.outcome === "blocked"
          ? "awaiting_user"
          : result.outcome === "aborted"
            ? "cancelled"
            : "failed",
      result.error,
    );
    if (chain) {
      chain.agentMessages += output.filter((m) => m.body.trim()).length;
      persistGroupChain(chain);
      if (chain.agentMessages >= this.limits.maxAgentMessages)
        this.endChain(chain, "max-agent-messages");
    }
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
    // Public text never dispatches work. Task tools carry explicit recipient IDs.
    if (result.outcome === "blocked") {
      if (isHyperPlanSessionReserved(wake.sessionId)) {
        this.awaitingUser.set(wake.sessionId, chain.chainId);
        this.endChain(chain, "blocked");
      } else {
        updateGroupJob(
          wake,
          "interrupted",
          "The turn ended before the pending question could be answered.",
        );
        this.transcript.setState(
          wake,
          "interrupted",
          "The turn ended before the pending question could be answered.",
        );
      }
    }
  }

  /**
   * The turn ended after group_start_worktree moved the member's cwd (PI
   * `terminate`, so outcome `ok`). Posts "Worktree
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

  private applyGatedTurnResult(_chain: ChainState, wake: Wake, result: PromptTurnResult): void {
    if (result.outcome === "blocked") {
      updateGroupJob(wake, "cancelled");
      this.transcript.setState(wake, "cancelled");
    }
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
    this.emitEvent({
      type: "group.activity",
      groupId,
      runningSessionIds,
      queuedSessionIds,
      waitingSessionIds,
    });
  }

  private emitMessage(message: GroupMessage): void {
    this.emitEvent({ type: "group.message", groupId: message.groupId, message });
  }

  private emitEvent(event: GroupRuntimeEvent): void {
    if (this.dispatching) this.bufferedEvents.push(event);
    else this.host.emit(event);
  }

  private settleIdle(): void {
    if (this.running.size > 0 || this.queuedCount() > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
