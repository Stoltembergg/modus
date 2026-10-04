import type { BrowserWindow as BrowserWindowType } from "electron";
import type {
  AgentEvent,
  AgentGroupInfo,
  GroupChainEndReason,
  GroupMemberStates,
  GroupMessage,
  GroupRuntimeEvent,
  GroupTask,
  PostGroupMessageInput,
  ResumeGroupExecutionInput,
} from "../../shared/contracts";
import {
  GROUP_BLOCKED_TEXT,
  groupBlockedErrorCode,
  groupBlockedReason,
} from "../../shared/group-blocked";
import { isCoordinatorModeActive } from "../../shared/group-coordinator";
import { bindSessionExecution, unbindSessionExecution } from "../../shared/group-execution-link";
import type {
  GroupDecisionSnapshot,
  GroupProactivityMode,
  GroupSuggestion,
  GroupSuggestionResolution,
  GroupTaskTransitionEvent,
  GroupTaskTrigger,
  ResolveGroupSuggestionInput,
} from "../../shared/group-work-state";
import { getHarnessQAEventByRowId } from "../agent/agent-event-store";
import { getAgentSession } from "../agent/agent-store";
import { isHyperPlanSessionReserved } from "../agent/harness/hyperplan-draft-store";
import type { PromptTurnResult, TurnSettledEvent } from "../agent/runtime";
import { getDatabase } from "../db/database";
import {
  getGroupJob,
  listRecoverableGroupJobs,
  persistGroupChain,
  persistGroupJob,
  readGroupChain,
  updateGroupJob,
} from "./group-job-store";
import { decideGroupNextAction } from "./group-proactivity-policy";
import {
  type GroupActionRecord,
  getGroupAction,
  getGroupActionByJobId,
  getGroupActionBySource,
  getGroupProactivityMode,
  invalidateDispatchedGroupAction,
  invalidateGroupAction,
  invalidateSuggestedGroupAction,
  listGroupActions,
  listPendingGroupActions,
  markGroupActionDispatched,
  markSuggestedActionsForNewExecution,
  persistGroupProactivityDecision,
  resolveSuggestedGroupAction,
  setGroupProactivityMode,
} from "./group-proactivity-store";
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
  latestGroupExecutionId,
  listAgentGroupMembers,
  listGroupDecisions,
  listGroupMessages,
  listGroupTasks,
  memberWorktreeBranchPrefix,
} from "./group-store";
import { getGroupTaskDetails } from "./group-task-details";
import { findGroupTaskForWake } from "./group-task-evidence";
import {
  getGroupTask,
  getGroupTaskRunBinding,
  groupTaskOperationFingerprint,
  isGroupTaskRunAssignmentCurrent,
  markGroupTaskExplicitDispatch,
  onGroupTaskTransition,
  reassignGroupTaskForSuggestion,
} from "./group-task-store";
import { GroupTurnTranscript } from "./group-turn-transcript";
import { getGroupWorkState } from "./group-work-state";

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
  private readonly processingChains = new Map<string, number>();
  private readonly validatingWakes = new Set<string>();
  /** Stop fences suggestion acceptances paused outside SQLite for source checks. */
  private readonly stopEpochByGroup = new Map<string, number>();
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
    this.unsubscribers.push(onGroupTaskTransition((event) => this.handleTaskTransition(event)));
    if (options.recoverPending) {
      this.recoverJobs();
      this.recoverUnprocessedTransitions();
      void this.recoverPendingActions();
    }
  }

  /** A user message into the room: new execution by default; Complementar joins one. */
  postUserMessage(input: PostGroupMessageInput): GroupMessage {
    const message = this.durableDispatch(() => this.saveUserMessage(input));
    this.supersedeWaiting(input.groupId);
    this.pump();
    return message;
  }

  getProactivityMode(groupId: string): GroupProactivityMode {
    return getGroupProactivityMode(groupId);
  }

  /** Rebuild the user-facing view from persisted task and transition identities. */
  listSuggestions(groupId: string): GroupSuggestion[] {
    const group = getAgentGroup(groupId);
    if (!group) throw new GroupStoreError("group-not-found", `Agent group not found: ${groupId}`);
    this.refreshSuggestionConfirmations(groupId);
    return listGroupActions(groupId)
      .filter((action) => action.deliveryState === "suggested")
      .slice(-100)
      .flatMap((action): GroupSuggestion[] => {
        const trigger = this.transitionForAction(action);
        if (!trigger) return [];
        const task = getGroupTask(action.taskId);
        const role = this.suggestionRole(trigger, task);
        const candidates = this.suggestionTargets(groupId, task, role);
        const proposedTargetSessionId = this.proposedTarget(trigger, task, group);
        const reason = this.suggestionReason(action.decision.reasonCode, trigger.kind);
        return [
          {
            actionId: action.id,
            version: action.version,
            state: "suggested",
            task: {
              id: task.id,
              title: task.title,
              stateVersion: task.stateVersion ?? trigger.taskVersion,
            },
            source: {
              eventId: trigger.sourceEventId,
              kind: trigger.kind,
              sequence: trigger.sequence,
              ...(trigger.executionId ? { executionId: trigger.executionId } : {}),
            },
            reasonCode: action.decision.reasonCode,
            reason,
            ...(proposedTargetSessionId ? { proposedTargetSessionId } : {}),
            candidateSessionIds: candidates,
            startNewExecution: action.requiresNewExecution,
          },
        ];
      });
  }

  /** Persist a per-group preference and revoke only automatic work not yet started. */
  setProactivityMode(groupId: string, mode: GroupProactivityMode): GroupProactivityMode {
    this.durableDispatch(() => {
      setGroupProactivityMode(groupId, mode);
      if (mode === "suggest") {
        for (const action of listGroupActions(groupId)) {
          if (action.deliveryState === "pending") {
            const invalidated = invalidateGroupAction(action.id);
            this.emitSuggestionChanged(invalidated);
            continue;
          }
          if (
            action.deliveryState !== "dispatched" ||
            action.decision.kind === "suggest" ||
            !action.jobId
          )
            continue;
          const queued = this.queues.get(action.decision.targetSessionId ?? "");
          const index = queued?.findIndex((wake) => wake.id === action.jobId) ?? -1;
          if (index < 0) continue;
          const wake = queued?.[index];
          if (!wake || getGroupJob(wake.id ?? "")?.status !== "pending") continue;
          queued?.splice(index, 1);
          if (queued?.length === 0) this.queues.delete(wake.sessionId);
          updateGroupJob(wake, "cancelled");
          const invalidated = invalidateDispatchedGroupAction(action.id);
          this.transcript.setState(wake, "cancelled");
          this.emitSuggestionChanged(invalidated);
        }
      }
      this.emitEvent({ type: "group.proactivity-mode-changed", groupId, mode });
    }, true);
    this.pump();
    return mode;
  }

  /** Resolve one stored suggestion; acceptance is one explicit, idempotent Group Runtime dispatch. */
  async resolveGroupSuggestion(
    input: ResolveGroupSuggestionInput,
  ): Promise<GroupSuggestionResolution> {
    const action = getGroupAction(input.actionId);
    if (!action) throw new GroupStoreError("invalid-value", "Unknown suggestion.");
    if (input.decision === "discard") {
      if (input.targetSessionId)
        throw new GroupStoreError("invalid-value", "Discard cannot include a target.");
      const resolved = this.durableDispatch(() => {
        const discarded = resolveSuggestedGroupAction({
          id: action.id,
          expectedVersion: input.expectedVersion,
          decision: "discard",
        });
        this.emitSuggestionChanged(discarded);
        return this.suggestionResolution(discarded);
      }, true);
      return resolved;
    }

    this.requireFreshExecutionConfirmation(action, input.expectedVersion);

    const stopEpoch = this.stopEpochByGroup.get(action.groupId) ?? 0;
    const initialTrigger = this.transitionForAction(action);
    if (!initialTrigger) return this.invalidateStaleSuggestion(action);
    const details = await getGroupTaskDetails(action.groupId, action.taskId);
    this.assertAcceptanceNotFenced(action.groupId, stopEpoch);
    const currentAction = getGroupAction(action.id);
    if (
      currentAction?.deliveryState !== "suggested" ||
      currentAction.version !== input.expectedVersion
    )
      throw new GroupStoreError("stale-task", "Suggestion changed while it was being accepted.");
    this.requireFreshExecutionConfirmation(currentAction, input.expectedVersion);
    const trigger = this.transitionForAction(currentAction);
    const task = getGroupTask(currentAction.taskId);
    const group = getAgentGroup(currentAction.groupId);
    if (
      !trigger ||
      !group ||
      task.groupId !== currentAction.groupId ||
      task.executionId !== currentAction.executionId ||
      task.stateVersion !== currentAction.taskVersion
    )
      return this.invalidateStaleSuggestion(currentAction);
    this.validateSuggestionTask(trigger, task, details);

    const role = this.suggestionRole(trigger, task);
    const eligibleTargets = this.suggestionTargets(group.id, task, role);
    const targetSessionId = input.targetSessionId ?? this.proposedTarget(trigger, task, group);
    const memberRows = listAgentGroupMembers(group.id);
    const member = memberRows.find((candidate) => candidate.sessionId === targetSessionId);
    const targetSession = targetSessionId ? getAgentSession(targetSessionId) : undefined;
    if (
      !targetSessionId ||
      !member ||
      member.archived ||
      !targetSession ||
      targetSession.archivedAt
    )
      throw new GroupStoreError(
        "not-a-member",
        "The selected target is not an active group member.",
      );
    if (!eligibleTargets.includes(targetSessionId)) {
      throw new GroupStoreError(
        role === "reviewer" && task.ownerSessionId === targetSessionId
          ? "self-review"
          : "invalid-transition",
        role === "reviewer"
          ? "Only a member other than the task owner can receive the review."
          : "The selected member cannot receive this owner assignment.",
      );
    }
    if (
      this.running.has(targetSessionId) ||
      this.gated.has(targetSessionId) ||
      this.cancelling.has(targetSessionId) ||
      (this.queues.get(targetSessionId)?.length ?? 0) > 0 ||
      this.runtime.isSessionStreaming(targetSessionId)
    )
      throw new GroupStoreError("invalid-transition", "The selected group member is unavailable.");

    const resolved = this.durableDispatch(() => {
      this.assertAcceptanceNotFenced(action.groupId, stopEpoch);
      const latestAction = getGroupAction(action.id);
      const latestTrigger = latestAction ? this.transitionForAction(latestAction) : undefined;
      const latestTask = getGroupTask(action.taskId);
      const latestGroup = getAgentGroup(action.groupId);
      if (
        latestAction?.deliveryState !== "suggested" ||
        latestAction.version !== input.expectedVersion
      )
        throw new GroupStoreError("stale-task", "Suggestion was resolved by another action.");
      if (
        !latestTrigger ||
        !latestGroup ||
        latestTask.groupId !== action.groupId ||
        latestTask.executionId !== action.executionId ||
        latestTask.stateVersion !== action.taskVersion
      )
        throw new GroupStoreError("stale-task", "Task changed before the suggestion could start.");
      this.validateSuggestionTask(latestTrigger, latestTask, details);
      const latestRole = this.suggestionRole(latestTrigger, latestTask);
      const latestEligibleTargets = this.suggestionTargets(action.groupId, latestTask, latestRole);
      if (!latestEligibleTargets.includes(targetSessionId)) {
        throw new GroupStoreError(
          latestRole === "reviewer" && latestTask.ownerSessionId === targetSessionId
            ? "self-review"
            : "invalid-transition",
          latestRole === "reviewer"
            ? "Only a member other than the task owner can receive the review."
            : "The selected member cannot receive this owner assignment.",
        );
      }
      const latestMember = listAgentGroupMembers(action.groupId).find(
        (candidate) => candidate.sessionId === targetSessionId,
      );
      const latestSession = getAgentSession(targetSessionId);
      if (!latestMember || latestMember.archived || !latestSession || latestSession.archivedAt)
        throw new GroupStoreError("not-a-member", "The selected target left the group.");

      const existing = this.continuableSuggestionChain(latestAction);
      const joinsExisting = Boolean(existing && !latestAction.requiresNewExecution);
      if (!joinsExisting && !latestAction.requiresNewExecution)
        throw new GroupStoreError(
          "stale-task",
          "This suggestion now requires confirmation to start a new execution. Refresh it first.",
        );
      const message = appendGroupMessage({
        createdAt: this.stamp(),
        groupId: action.groupId,
        authorKind: "user",
        body: `Suggestion accepted: continue task ${task.title} (${task.id}). Recheck its persisted state before acting.`,
        mentions: [targetSessionId],
        ...(joinsExisting && existing ? { chainId: existing.chainId } : { startsChain: true }),
      });
      this.emitMessage(message);
      const resolvedExecutionId = message.chainId ?? message.id;
      const chain = joinsExisting && existing ? existing : this.openChain(group.id, message.id);
      reassignGroupTaskForSuggestion({
        groupId: action.groupId,
        taskId: action.taskId,
        expectedVersion: latestTask.stateVersion ?? 1,
        operationId: `suggestion:${action.id}`,
        targetSessionId,
        role: latestRole,
        executionId: resolvedExecutionId,
      });
      this.route(chain, message, [targetSessionId], false, true);
      const wake = this.queues
        .get(targetSessionId)
        ?.find((item) => item.triggerMessageId === message.id);
      if (!wake?.id)
        throw new GroupStoreError("invalid-transition", "The accepted task could not be queued.");
      const dispatched = resolveSuggestedGroupAction({
        id: action.id,
        expectedVersion: input.expectedVersion,
        decision: "accept",
        wakeMessageId: message.id,
        jobId: wake.id,
        targetSessionId,
        resolvedExecutionId,
      });
      this.emitSuggestionChanged(dispatched);
      return this.suggestionResolution(dispatched);
    }, true);
    this.pump();
    return resolved;
  }

  /**
   * Resume an interrupted/failed turn by durable execution id (job/turn id).
   * Requeues the same job in its original chain — no new user message.
   */
  resumeExecution(input: ResumeGroupExecutionInput): void {
    if (this.disposed) throw new Error("Group runtime is disposed.");
    this.durableDispatch(() => this.requeueExecution(input));
    this.pump();
  }

  private requeueExecution(input: ResumeGroupExecutionInput): void {
    const job = getGroupJob(input.executionId);
    if (!job || job.wake.groupId !== input.groupId) {
      throw new GroupStoreError(
        "message-not-found",
        `Group execution not found: ${input.executionId}`,
      );
    }
    if (job.status !== "interrupted" && job.status !== "failed" && job.status !== "cancelled") {
      throw new GroupStoreError(
        "invalid-transition",
        `Cannot resume execution ${input.executionId}: it is ${job.status}.`,
      );
    }
    const member = membersOf(input.groupId).find((row) => row.sessionId === job.wake.sessionId);
    if (!member) {
      throw new GroupStoreError(
        "not-a-member",
        `Session ${job.wake.sessionId} is not a member of group ${input.groupId}.`,
      );
    }
    if (member.archived) {
      throw new GroupStoreError(
        "member-archived",
        `Session ${job.wake.sessionId} is archived and cannot be resumed.`,
      );
    }
    if (
      this.running.has(job.wake.sessionId) ||
      this.gated.has(job.wake.sessionId) ||
      (this.queues.get(job.wake.sessionId) ?? []).some((wake) => wake.id === job.wake.id)
    ) {
      throw new GroupStoreError(
        "invalid-transition",
        `Cannot resume execution ${input.executionId}: the member already has active work.`,
      );
    }
    const chain =
      this.chains.get(job.wake.chainId) ??
      this.retiredChains.get(job.wake.chainId) ??
      readGroupChain(job.wake.chainId);
    if (!chain) {
      throw new GroupStoreError(
        "message-not-found",
        `Execution chain not found for ${input.executionId}.`,
      );
    }
    if (chain.ended || chain.retired) {
      delete chain.ended;
      delete chain.retired;
      persistGroupChain(chain);
    }
    this.retiredChains.delete(chain.chainId);
    this.chains.set(chain.chainId, chain);
    // Rebuild wake without prior run/error/progress fields (exactOptionalPropertyTypes).
    const {
      error: _error,
      runId: _runId,
      lastEventCursor: _lastEventCursor,
      startedAt: _startedAt,
      lastProgressAt: _lastProgressAt,
      pausedAt: _pausedAt,
      worktreeBranch: _worktreeBranch,
      publicMessageIds: _publicMessageIds,
      assistantMessageIds: _assistantMessageIds,
      questionRequestIds: _questionRequestIds,
      watchdog: _watchdog,
      cancelled: _cancelled,
      gated: _gated,
      seq: _seq,
      ...base
    } = job.wake;
    const wake: Wake = {
      ...base,
      seq: ++this.seq,
      cancelled: false,
      gated: false,
    };
    updateGroupJob(wake, "pending");
    this.transcript.setState(wake, "queued");
    const queue = this.queues.get(wake.sessionId) ?? [];
    queue.push(wake);
    this.queues.set(wake.sessionId, queue);
    this.emitActivity(wake.groupId);
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
    const mode = input.executionMode ?? "new";
    let joinExecutionId: string | undefined;
    if (mode === "complement") {
      joinExecutionId = input.executionId ?? latestGroupExecutionId(input.groupId);
    }
    const message = appendGroupMessage({
      createdAt: this.stamp(),
      groupId: input.groupId,
      authorKind: "user",
      body: input.body,
      mentions,
      ...(joinExecutionId ? { chainId: joinExecutionId } : { startsChain: true }),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
      ...(input.contextItems && input.contextItems.length > 0
        ? { contextItems: input.contextItems }
        : {}),
    });
    this.emitMessage(message);
    const executionId = message.chainId ?? message.id;
    const chain = this.openChain(input.groupId, executionId);
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

  /** Consume only an exact committed task event; public room text is never a trigger. */
  handleTaskTransition(event: GroupTaskTransitionEvent): void {
    if (this.disposed || !event.executionId) return;
    const chain = this.chains.get(event.executionId);
    if (!chain || chain.ended || chain.retired || chain.groupId !== event.groupId) return;
    const trigger = this.persistedTrigger(event);
    if (!trigger) return;
    this.processingChains.set(chain.chainId, (this.processingChains.get(chain.chainId) ?? 0) + 1);
    void this.processTaskTrigger(trigger)
      .catch((error) => {
        console.warn("[modus] group task decision failed:", error);
      })
      .finally(() => {
        const count = (this.processingChains.get(chain.chainId) ?? 1) - 1;
        if (count > 0) this.processingChains.set(chain.chainId, count);
        else this.processingChains.delete(chain.chainId);
        this.retireIdleChains();
      });
  }

  private persistedTrigger(event: GroupTaskTransitionEvent): GroupTaskTrigger | undefined {
    const row = getDatabase()
      .prepare(`select rowid as sequence, group_id, task_id, task_version,
      execution_id, action, from_status, to_status, operation_id from group_task_events where id = ?`)
      .get(event.id) as
      | {
          sequence: number;
          group_id: string;
          task_id: string;
          task_version: number;
          execution_id: string | null;
          action: string;
          from_status: GroupTaskTrigger["fromStatus"];
          to_status: GroupTaskTrigger["toStatus"];
          operation_id: string | null;
        }
      | undefined;
    if (
      !row ||
      row.group_id !== event.groupId ||
      row.task_id !== event.taskId ||
      row.task_version !== event.taskVersion ||
      row.execution_id !== event.executionId ||
      row.action !== event.action ||
      row.from_status !== event.fromStatus ||
      row.to_status !== event.toStatus
    )
      return undefined;
    let kind: GroupTaskTrigger["kind"] | undefined;
    if (
      ["assign", "claim", "group_assign_task", "group_claim_task", "group_handoff"].includes(
        row.action,
      ) &&
      row.to_status === "in_progress"
    )
      kind = "task_assigned";
    else if (
      ["progress", "group_report_progress"].includes(row.action) &&
      row.from_status === "blocked" &&
      row.to_status === "in_progress"
    )
      kind = "task_unblocked";
    else if (
      ["request_review", "group_request_review"].includes(row.action) &&
      row.from_status === "in_progress" &&
      row.to_status === "in_review"
    )
      kind = "review_requested";
    else if (
      ["review", "group_review_task"].includes(row.action) &&
      row.from_status === "in_review" &&
      row.to_status === "in_progress"
    )
      kind = "review_changes_requested";
    else if (
      ["evidence", "group_record_task_evidence"].includes(row.action) &&
      row.operation_id?.startsWith("qa:")
    ) {
      const rowId = Number(row.operation_id.slice(3));
      // Agent events have run identity in their payload, not a separate SQL column.
      const qaRecord = getDatabase()
        .prepare(
          "select session_id, payload_json from agent_events where rowid = ? and type = 'harness.qa'",
        )
        .get(rowId) as { session_id: string; payload_json: string } | undefined;
      if (!qaRecord) return undefined;
      let runId: string;
      try {
        runId = (JSON.parse(qaRecord.payload_json) as { runId?: string }).runId ?? "";
      } catch {
        return undefined;
      }
      const binding = getGroupTaskRunBinding(qaRecord.session_id, runId);
      if (
        !binding ||
        !getHarnessQAEventByRowId(rowId, qaRecord.session_id, runId) ||
        binding.groupId !== row.group_id ||
        binding.taskId !== row.task_id ||
        binding.executionId !== row.execution_id ||
        !isGroupTaskRunAssignmentCurrent(binding)
      )
        return undefined;
      const task = getGroupTask(row.task_id);
      if (
        task.criteriaVersion !== binding.criteriaVersion ||
        task[binding.role === "owner" ? "ownerSessionId" : "reviewerSessionId"] !==
          binding.sessionId ||
        !(task.evidenceRefs ?? []).some(
          (ref) =>
            ref.eventRowId === rowId &&
            ref.sessionId === binding.sessionId &&
            ref.runId === binding.runId,
        )
      )
        return undefined;
      kind = "task_qa_updated";
    }
    if (!kind) return undefined;
    return {
      kind,
      groupId: row.group_id,
      taskId: row.task_id,
      taskVersion: row.task_version,
      ...(row.execution_id ? { executionId: row.execution_id } : {}),
      sourceEventId: event.id,
      sequence: row.sequence,
      fromStatus: row.from_status,
      toStatus: row.to_status,
    };
  }

  private async decisionSnapshot(
    trigger: GroupTaskTrigger,
    reservedWake?: Wake,
  ): Promise<GroupDecisionSnapshot | undefined> {
    const executionId = trigger.executionId;
    if (!executionId || this.disposed) return undefined;
    const chain = this.chains.get(executionId);
    if (
      !chain ||
      chain.ended ||
      chain.retired ||
      chain.groupId !== trigger.groupId ||
      !getAgentGroup(trigger.groupId)
    )
      return undefined;
    const task = getGroupTask(trigger.taskId);
    if (
      task.groupId !== trigger.groupId ||
      task.executionId !== executionId ||
      task.stateVersion !== trigger.taskVersion
    )
      return undefined;
    const details = await getGroupTaskDetails(trigger.groupId, trigger.taskId);
    if (this.disposed || this.chains.get(executionId) !== chain || chain.ended || chain.retired)
      return undefined;
    const current = getGroupTask(trigger.taskId);
    if (
      current.groupId !== trigger.groupId ||
      current.executionId !== executionId ||
      current.stateVersion !== trigger.taskVersion
    )
      return undefined;
    const workState = getGroupWorkState(trigger.groupId, executionId);
    workState.tasks = listGroupTasks(trigger.groupId);
    workState.members = listAgentGroupMembers(trigger.groupId);
    workState.gates[task.id] = details.gate;
    workState.budgets = {
      remainingAgentMessages: Math.max(0, this.limits.maxAgentMessages - chain.agentMessages),
      remainingMemberWakes: Math.max(
        0,
        workState.members.length * this.limits.maxWakesPerMember -
          [...chain.wakesByMember.values()].reduce((sum, wakes) => sum + wakes, 0) +
          (reservedWake ? 1 : 0),
      ),
      remainingInputTokens: Math.max(
        0,
        this.limits.maxEstimatedInputTokens -
          chain.inputTokens +
          (reservedWake ? estimateGroupTokens(reservedWake.prompt) : 0),
      ),
    };
    const availability: GroupDecisionSnapshot["memberAvailability"] = {};
    const remainingWakesByMember: GroupDecisionSnapshot["remainingWakesByMember"] = {};
    for (const member of workState.members) {
      const session = getAgentSession(member.sessionId);
      const reservedTarget = reservedWake?.sessionId === member.sessionId;
      availability[member.sessionId] =
        member.archived ||
        !session ||
        session.archivedAt ||
        (!reservedTarget && this.running.has(member.sessionId)) ||
        (!reservedTarget && this.gated.has(member.sessionId)) ||
        (this.queues.get(member.sessionId)?.some((wake) => wake.id !== reservedWake?.id) ??
          false) ||
        (!reservedTarget && this.cancelling.has(member.sessionId)) ||
        (!reservedTarget && this.runtime.isSessionStreaming(member.sessionId))
          ? "unavailable"
          : "available";
      remainingWakesByMember[member.sessionId] = Math.max(
        0,
        this.limits.maxWakesPerMember -
          (chain.wakesByMember.get(member.sessionId) ?? 0) +
          (reservedWake?.sessionId === member.sessionId ? 1 : 0),
      );
    }
    const reviewReadiness =
      details.source.availability !== "available" &&
      (task.criteria ?? []).some((criterion) => criterion.requiredCheckKinds.length > 0)
        ? "unavailable"
        : details.criteria
            .filter((criterion) => criterion.requiredCheckKinds.length > 0)
            .reduce<GroupDecisionSnapshot["reviewReadiness"][string]>(
              (status, criterion) =>
                status !== "ready"
                  ? status
                  : criterion.status === "passed"
                    ? "ready"
                    : criterion.status === "failed" ||
                        criterion.status === "stale" ||
                        criterion.status === "unavailable"
                      ? criterion.status
                      : "missing",
              "ready",
            );
    const receipt = getDatabase()
      .prepare("select 1 from group_task_dispatches where group_id = ? and source_event_id = ?")
      .get(trigger.groupId, trigger.sourceEventId);
    return {
      workState,
      mode: getGroupProactivityMode(trigger.groupId),
      triggers: [trigger],
      explicitWakeSourceEventIds: receipt ? [trigger.sourceEventId] : [],
      memberAvailability: availability,
      remainingWakesByMember,
      reviewStates: {
        [task.id]: details.review.status === "not_required" ? "pending" : details.review.status,
      },
      reviewReadiness: { [task.id]: reviewReadiness },
      stopRequested: Boolean(chain.ended),
      waitingForUser:
        [...this.gated.values()].some((wake) => wake.chainId === executionId) ||
        [...this.awaitingUser.values()].includes(executionId),
    };
  }

  private async processTaskTrigger(trigger: GroupTaskTrigger): Promise<void> {
    if (getGroupActionBySource(trigger.groupId, trigger.sourceEventId)) return;
    const snapshot = await this.decisionSnapshot(trigger);
    if (!snapshot) return;
    const decision = decideGroupNextAction(snapshot);
    if (
      !decision ||
      this.disposed ||
      !this.isTriggerChainLive(trigger) ||
      getGroupActionBySource(trigger.groupId, trigger.sourceEventId)
    )
      return;
    const action = persistGroupProactivityDecision(decision);
    if (action.deliveryState === "suggested") this.emitSuggestionChanged(action);
    if (action.deliveryState === "pending") await this.materializeAction(action, trigger);
  }

  private isTriggerChainLive(trigger: GroupTaskTrigger): boolean {
    const chain = trigger.executionId ? this.chains.get(trigger.executionId) : undefined;
    return Boolean(chain && chain.groupId === trigger.groupId && !chain.ended && !chain.retired);
  }

  private invalidatePendingAction(id: string): void {
    if (this.disposed) return;
    if (getGroupAction(id)?.deliveryState === "pending") invalidateGroupAction(id);
  }

  private async materializeAction(
    action: GroupActionRecord,
    trigger: GroupTaskTrigger,
  ): Promise<void> {
    if (action.deliveryState !== "pending" || this.disposed) return;
    const snapshot = await this.decisionSnapshot(trigger);
    if (this.disposed) return;
    const current = snapshot ? decideGroupNextAction(snapshot) : null;
    if (
      !current ||
      current.kind === "suggest" ||
      current.idempotencyKey !== action.decision.idempotencyKey ||
      current.targetSessionId !== action.decision.targetSessionId
    ) {
      this.invalidatePendingAction(action.id);
      return;
    }
    const target = current.targetSessionId;
    const chain = trigger.executionId ? this.chains.get(trigger.executionId) : undefined;
    if (!target || !chain || chain.ended || chain.retired) {
      this.invalidatePendingAction(action.id);
      return;
    }
    try {
      this.durableDispatch(() => {
        const fresh = this.chains.get(chain.chainId);
        if (
          !fresh ||
          fresh.ended ||
          fresh.retired ||
          getGroupProactivityMode(action.groupId) !== "opt_in_auto" ||
          getGroupTask(action.taskId).stateVersion !== action.taskVersion ||
          getDatabase()
            .prepare("select 1 from group_task_dispatches where source_event_id = ?")
            .get(action.sourceEventId)
        )
          throw new Error("Proactive action became stale before dispatch.");
        const message = appendGroupMessage({
          createdAt: this.stamp(),
          groupId: action.groupId,
          authorKind: "system",
          kind: "status",
          body: `Task ${current.kind === "wake_reviewer" ? "review" : "work"} ready: ${getGroupTask(action.taskId).title}`,
          mentions: [target],
          chainId: chain.chainId,
        });
        this.emitMessage(message);
        this.route(fresh, message, [target], false, true);
        const wake = this.queues.get(target)?.find((item) => item.triggerMessageId === message.id);
        if (!wake?.id) throw new Error("Proactive wake exceeded chain limits.");
        markGroupActionDispatched(action.id, message.id, wake.id);
      }, true);
      this.pump();
    } catch {
      this.invalidatePendingAction(action.id);
    }
  }

  private async recoverPendingActions(): Promise<void> {
    for (const action of listPendingGroupActions()) {
      if (this.disposed) return;
      try {
        const chain = action.executionId ? readGroupChain(action.executionId) : undefined;
        if (!chain || chain.ended || chain.retired || chain.groupId !== action.groupId) {
          this.invalidatePendingAction(action.id);
          continue;
        }
        if (!this.chains.has(chain.chainId)) this.chains.set(chain.chainId, chain);
        const row = getDatabase()
          .prepare(`select id, group_id, task_id, task_version, action,
        execution_id, from_status, to_status, created_at from group_task_events where id = ?`)
          .get(action.sourceEventId) as
          | {
              id: string;
              group_id: string;
              task_id: string;
              task_version: number;
              action: string;
              execution_id: string | null;
              from_status: GroupTaskTransitionEvent["fromStatus"];
              to_status: GroupTaskTransitionEvent["toStatus"];
              created_at: string;
            }
          | undefined;
        const trigger =
          row &&
          this.persistedTrigger({
            id: row.id,
            groupId: row.group_id,
            taskId: row.task_id,
            taskVersion: row.task_version,
            action: row.action,
            ...(row.execution_id ? { executionId: row.execution_id } : {}),
            fromStatus: row.from_status,
            toStatus: row.to_status,
            createdAt: row.created_at,
          });
        if (!trigger) {
          this.invalidatePendingAction(action.id);
          continue;
        }
        await this.materializeAction(action, trigger);
        this.retireIdleChains();
      } catch (error) {
        if (this.disposed) return;
        this.invalidatePendingAction(action.id);
        console.warn("[modus] pending group action could not be recovered:", error);
      }
    }
  }

  private recoverUnprocessedTransitions(): void {
    if (this.disposed) return;
    // The transition row is the durable inbox. A crash may occur during the
    // asynchronous source lookup, before an action can be inserted.
    const rows = getDatabase()
      .prepare(`select e.id, e.group_id, e.task_id, e.task_version, e.action,
        e.execution_id, e.from_status, e.to_status, e.created_at
        from group_task_events e left join group_proactivity_actions a
          on a.group_id = e.group_id and a.source_event_id = e.id
        where e.execution_id is not null and a.id is null order by e.rowid`)
      .all() as Array<{
      id: string;
      group_id: string;
      task_id: string;
      task_version: number;
      action: string;
      execution_id: string;
      from_status: GroupTaskTransitionEvent["fromStatus"];
      to_status: GroupTaskTransitionEvent["toStatus"];
      created_at: string;
    }>;
    for (const row of rows) {
      if (this.disposed) return;
      const chain = this.chains.get(row.execution_id) ?? readGroupChain(row.execution_id);
      if (!chain || chain.ended || chain.retired || chain.groupId !== row.group_id) continue;
      const event: GroupTaskTransitionEvent = {
        id: row.id,
        groupId: row.group_id,
        taskId: row.task_id,
        taskVersion: row.task_version,
        action: row.action,
        executionId: row.execution_id,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        createdAt: row.created_at,
      };
      if (!this.persistedTrigger(event)) continue;
      this.chains.set(chain.chainId, chain);
      this.handleTaskTransition(event);
    }
  }

  private saveTaskWake(input: GroupTaskWake): GroupMessage | undefined {
    const db = getDatabase();
    const identity = groupTaskOperationFingerprint(input);
    if (input.operationId) {
      const previous = db
        .prepare(
          "select operation_id, input_json, message_id from group_task_dispatches where operation_id = ? or source_event_id = ?",
        )
        .get(input.operationId, input.sourceEventId ?? null) as
        | { operation_id: string; input_json: string; message_id: string }
        | undefined;
      if (previous) {
        if (previous.operation_id !== input.operationId || previous.input_json !== identity)
          throw new GroupStoreError(
            "invalid-value",
            "Operation ID was reused with a conflicting task dispatch payload.",
          );
        const message = getGroupMessage(previous.message_id);
        // Publish at least once: a prior durable commit may have lost its live event.
        if (message) this.emitMessage(message);
        return message;
      }
    }
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
    if (input.wake !== false && input.targetSessionId) {
      const chain = joined ?? this.openChain(input.groupId, message.id);
      this.route(chain, message, [input.targetSessionId]);
      this.retireIdleChains();
    }
    if (input.operationId) {
      db.prepare(
        "insert into group_task_dispatches (operation_id, source_event_id, group_id, input_json, message_id) values (?, ?, ?, ?, ?)",
      ).run(input.operationId, input.sourceEventId ?? null, input.groupId, identity, message.id);
      // Delivery and marker commit with the message, jobs and budget counters.
      markGroupTaskExplicitDispatch(input.operationId);
    }
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
    this.stopEpochByGroup.set(groupId, (this.stopEpochByGroup.get(groupId) ?? 0) + 1);
    const queued = [...this.queues.values()].flat().filter((wake) => wake.groupId === groupId);
    const running = [...this.running.values()].filter((wake) => wake.groupId === groupId);
    const waiting = [...this.gated.values()].filter((wake) => wake.groupId === groupId);
    const awaiting = [...this.awaitingUser.keys()].filter(
      (id) => getAgentGroupForSession(id)?.id === groupId,
    );
    const pendingActions = listPendingGroupActions(groupId);
    const processing = [...this.processingChains.keys()].some(
      (chainId) => this.chains.get(chainId)?.groupId === groupId,
    );
    if (
      queued.length === 0 &&
      running.length === 0 &&
      waiting.length === 0 &&
      awaiting.length === 0 &&
      pendingActions.length === 0 &&
      !processing
    )
      return;
    for (const action of pendingActions) {
      this.invalidatePendingAction(action.id);
      if (!action.executionId) continue;
      const chain = this.chains.get(action.executionId) ?? readGroupChain(action.executionId);
      if (chain && !chain.ended) {
        chain.ended = "stopped";
        persistGroupChain(chain);
      }
    }
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
    this.retireIdleChains();
    this.settleIdle();
  }

  /* ── internals ────────────────────────────────────────────────────── */

  /** A request, its cards and every queued wake survive or roll back together. */
  private durableDispatch<T>(action: () => T, isolatePostCommitEmission = false): T {
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
    for (const event of events) {
      try {
        this.host.emit(event);
      } catch (error) {
        if (!isolatePostCommitEmission) throw error;
        console.warn("[modus] committed group event could not be emitted:", error);
      }
    }
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
        chain.ended === "blocked" ||
        chain.ended === "stopped" ||
        !membersOf(wake.groupId).some((m) => m.sessionId === wake.sessionId && !m.archived)
      ) {
        updateGroupJob(wake, "cancelled");
        const action = wake.id ? getGroupActionByJobId(wake.id) : undefined;
        if (action?.deliveryState === "dispatched") invalidateDispatchedGroupAction(action.id);
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
    if (event.type === "harness.qa" && Number.isSafeInteger(event.eventCursor)) {
      const binding = getGroupTaskRunBinding(event.sessionId, event.runId);
      if (binding && isGroupTaskRunAssignmentCurrent(binding)) {
        const row = getDatabase()
          .prepare(`select id, group_id, task_id, task_version, action,
          execution_id, from_status, to_status, created_at from group_task_events where operation_id = ?`)
          .get(`qa:${event.eventCursor}`) as
          | {
              id: string;
              group_id: string;
              task_id: string;
              task_version: number;
              action: string;
              execution_id: string | null;
              from_status: GroupTaskTransitionEvent["fromStatus"];
              to_status: GroupTaskTransitionEvent["toStatus"];
              created_at: string;
            }
          | undefined;
        if (
          row &&
          row.task_id === binding.taskId &&
          row.group_id === binding.groupId &&
          row.execution_id === binding.executionId
        )
          this.handleTaskTransition({
            id: row.id,
            groupId: row.group_id,
            taskId: row.task_id,
            taskVersion: row.task_version,
            action: row.action,
            ...(row.execution_id ? { executionId: row.execution_id } : {}),
            fromStatus: row.from_status,
            toStatus: row.to_status,
            createdAt: row.created_at,
          });
      }
    }
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
      if (busy.has(chainId) || this.processingChains.has(chainId)) continue;
      this.chains.delete(chainId);
      if (!this.disposed) {
        chain.retired = true;
        persistGroupChain(chain);
        if (!chain.ended) this.requireNewExecutionForSuggestions(chain.chainId);
      }
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
    deferPump = false,
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
    if (!deferPump) this.pump();
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
   * Stops new handoffs in a chain. Human blocks and explicit Stop also cancel
   * queued work; resource limits let already admitted turns drain normally.
   */
  private endChain(chain: ChainState, reason: GroupChainEndReason): void {
    if (chain.ended) return;
    chain.ended = reason;
    persistGroupChain(chain);
    this.requireNewExecutionForSuggestions(chain.chainId);
    if (reason === "blocked" || reason === "stopped") {
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
    bindSessionExecution(wake.sessionId, wake.chainId);
    const queue = this.queues.get(wake.sessionId) ?? [];
    queue.push(wake);
    this.queues.set(wake.sessionId, queue);
  }

  private queuedCount(): number {
    let count = 0;
    for (const queue of this.queues.values()) count += queue.length;
    return count;
  }

  private transitionForAction(action: GroupActionRecord): GroupTaskTrigger | undefined {
    const row = getDatabase()
      .prepare(`select id, group_id, task_id, task_version, action,
        execution_id, from_status, to_status, created_at from group_task_events where id = ?`)
      .get(action.sourceEventId) as
      | {
          id: string;
          group_id: string;
          task_id: string;
          task_version: number;
          action: string;
          execution_id: string | null;
          from_status: GroupTaskTransitionEvent["fromStatus"];
          to_status: GroupTaskTransitionEvent["toStatus"];
          created_at: string;
        }
      | undefined;
    return row
      ? this.persistedTrigger({
          id: row.id,
          groupId: row.group_id,
          taskId: row.task_id,
          taskVersion: row.task_version,
          action: row.action,
          ...(row.execution_id ? { executionId: row.execution_id } : {}),
          fromStatus: row.from_status,
          toStatus: row.to_status,
          createdAt: row.created_at,
        })
      : undefined;
  }

  private suggestionReason(reasonCode: string, kind: GroupTaskTrigger["kind"]): string {
    const known: Record<string, string> = {
      "actionable-task-event":
        kind === "review_requested" || kind === "task_qa_updated"
          ? "The task is ready for its assigned reviewer."
          : "The assigned task is ready for its next step.",
      "dependency-incomplete": "A prerequisite task must be completed first.",
      "task-blocked": "The task is blocked and needs an update before work continues.",
      "review-unavailable": "The assigned reviewer is not ready for this review transition.",
      "qa-missing": "Required checks are missing or have not passed yet.",
      "execution-unavailable": "The previous execution ended; accepting starts a new one.",
      "target-unassigned": "Choose an active group member to receive this task.",
      "member-unavailable": "The suggested member is unavailable; choose another active member.",
      "budget-exhausted": "The previous execution reached its wake budget.",
      "owner-ready": "The task owner is ready for the next step.",
      "review-ready": "The task is ready for review.",
    };
    return known[reasonCode] ?? "Review the task state and choose whether to send the next step.";
  }

  private proposedTarget(
    trigger: GroupTaskTrigger,
    task: GroupTask,
    group: AgentGroupInfo,
  ): string | undefined {
    const role = this.suggestionRole(trigger, task);
    const eligible = this.suggestionTargets(group.id, task, role);
    const preferred = role === "reviewer" ? task.reviewerSessionId : task.ownerSessionId;
    if (preferred && eligible.includes(preferred)) return preferred;
    if (group.leadSessionId && eligible.includes(group.leadSessionId)) return group.leadSessionId;
    return undefined;
  }

  private suggestionRole(trigger: GroupTaskTrigger, task: GroupTask): "owner" | "reviewer" {
    return trigger.kind === "review_requested" ||
      (trigger.kind === "task_qa_updated" &&
        task.status === "in_review" &&
        task.verificationPolicy?.requireReview)
      ? "reviewer"
      : "owner";
  }

  private suggestionTargets(
    groupId: string,
    task: GroupTask,
    role: "owner" | "reviewer",
  ): string[] {
    const excluded = role === "reviewer" ? task.ownerSessionId : task.reviewerSessionId;
    return listAgentGroupMembers(groupId)
      .filter((member) => !member.archived && member.sessionId !== excluded)
      .filter((member) => {
        const session = getAgentSession(member.sessionId);
        return Boolean(session && !session.archivedAt);
      })
      .map((member) => member.sessionId);
  }

  private refreshSuggestionConfirmations(groupId: string): void {
    const executionIds = new Set<string>();
    for (const action of listGroupActions(groupId)) {
      if (
        action.deliveryState === "suggested" &&
        !action.requiresNewExecution &&
        action.executionId &&
        !this.continuableSuggestionChain(action)
      )
        executionIds.add(action.executionId);
    }
    for (const executionId of executionIds) this.requireNewExecutionForSuggestions(executionId);
  }

  /** A durable chain is joinable only when recovery admitted it to this runtime. */
  private continuableSuggestionChain(action: GroupActionRecord): ChainState | undefined {
    if (!action.executionId) return undefined;
    const chain = this.chains.get(action.executionId);
    return chain && chain.groupId === action.groupId && !chain.ended && !chain.retired
      ? chain
      : undefined;
  }

  private requireNewExecutionForSuggestions(executionId: string): void {
    for (const action of markSuggestedActionsForNewExecution(executionId))
      this.emitSuggestionChanged(action);
  }

  private requireFreshExecutionConfirmation(
    action: GroupActionRecord,
    expectedVersion: number,
  ): void {
    if (action.version !== expectedVersion)
      throw new GroupStoreError("stale-task", "Suggestion changed. Refresh it before acting.");
    if (action.deliveryState !== "suggested" || action.requiresNewExecution) return;
    if (this.continuableSuggestionChain(action)) return;
    this.requireNewExecutionForSuggestions(action.executionId ?? "");
    throw new GroupStoreError(
      "stale-task",
      "This suggestion now requires confirmation to start a new execution. Refresh it first.",
    );
  }

  private validateSuggestionTask(
    trigger: GroupTaskTrigger,
    task: GroupTask,
    details: Awaited<ReturnType<typeof getGroupTaskDetails>>,
  ): void {
    if (task.status === "done" || task.status === "cancelled" || task.status === "blocked")
      throw new GroupStoreError("invalid-transition", "The task is not ready to continue.");
    const tasks = new Map(listGroupTasks(task.groupId).map((item) => [item.id, item]));
    if ((task.dependencyIds ?? []).some((id) => tasks.get(id)?.status !== "done"))
      throw new GroupStoreError("invalid-dependency", "Complete prerequisite tasks first.");

    if (trigger.kind === "task_assigned" || trigger.kind === "task_unblocked") {
      if (task.status !== "in_progress")
        throw new GroupStoreError("stale-task", "The task no longer has an active owner stage.");
      return;
    }
    if (trigger.kind === "review_changes_requested") {
      if (task.status !== "in_progress" || details.review.status !== "changes_requested")
        throw new GroupStoreError("stale-task", "The review change request is no longer current.");
      return;
    }
    if (trigger.kind === "task_qa_updated" && task.status !== "in_review") return;
    if (task.status !== "in_review" || details.review.status !== "pending")
      throw new GroupStoreError("stale-task", "The task is no longer waiting for review.");
    const requiredCriteria = details.criteria.filter(
      (criterion) => criterion.requiredCheckKinds.length > 0,
    );
    if (
      requiredCriteria.some((criterion) => criterion.status !== "passed") ||
      (requiredCriteria.length > 0 && details.source.availability !== "available")
    )
      throw new GroupStoreError(
        "verification-required",
        "Required checks must pass before review.",
      );
  }

  private assertAcceptanceNotFenced(groupId: string, stopEpoch: number): void {
    if (this.disposed)
      throw new GroupStoreError(
        "invalid-transition",
        "Runtime stopped before the suggestion could start.",
      );
    if ((this.stopEpochByGroup.get(groupId) ?? 0) !== stopEpoch)
      throw new GroupStoreError(
        "invalid-transition",
        "Stop was requested before the suggestion could start.",
      );
  }

  private invalidateStaleSuggestion(action: GroupActionRecord): never {
    const current = getGroupAction(action.id);
    if (current?.deliveryState === "suggested" && current.version === action.version) {
      const invalidated = this.durableDispatch(
        () => invalidateSuggestedGroupAction(action.id, action.version),
        true,
      );
      this.emitSuggestionChanged(invalidated);
    }
    throw new GroupStoreError("stale-task", "Task or source changed; reload this suggestion.");
  }

  private suggestionResolution(action: GroupActionRecord): GroupSuggestionResolution {
    return {
      actionId: action.id,
      groupId: action.groupId,
      taskId: action.taskId,
      sourceEventId: action.sourceEventId,
      ...(action.executionId ? { executionId: action.executionId } : {}),
      deliveryState: action.deliveryState === "discarded" ? "discarded" : "dispatched",
      version: action.version,
      ...(action.resolvedExecutionId ? { resolvedExecutionId: action.resolvedExecutionId } : {}),
      ...(action.resolutionTargetSessionId
        ? { resolutionTargetSessionId: action.resolutionTargetSessionId }
        : {}),
      ...(action.wakeMessageId ? { wakeMessageId: action.wakeMessageId } : {}),
      ...(action.jobId ? { jobId: action.jobId } : {}),
    };
  }

  private emitSuggestionChanged(action: GroupActionRecord): void {
    this.emitEvent({
      type: "group.suggestion-changed",
      groupId: action.groupId,
      actionId: action.id,
      version: action.version,
    });
  }

  private cancelStaleAutomaticWake(wake: Wake, actionId: string): void {
    if (this.disposed || this.queues.get(wake.sessionId)?.[0]?.id !== wake.id) return;
    this.durableDispatch(() => {
      const queue = this.queues.get(wake.sessionId);
      if (!queue || queue[0]?.id !== wake.id) return;
      queue.shift();
      if (queue.length === 0) this.queues.delete(wake.sessionId);
      updateGroupJob(wake, "cancelled");
      invalidateDispatchedGroupAction(actionId);
      this.transcript.setState(wake, "cancelled");
    });
    this.retireIdleChains();
    this.settleIdle();
  }

  private async validateAutomaticWake(wake: Wake, action: GroupActionRecord): Promise<void> {
    const jobId = wake.id;
    try {
      if (!jobId) {
        this.cancelStaleAutomaticWake(wake, action.id);
        return;
      }
      const trigger = this.transitionForAction(action);
      const snapshot = trigger ? await this.decisionSnapshot(trigger, wake) : undefined;
      if (this.disposed || this.queues.get(wake.sessionId)?.[0]?.id !== wake.id) return;
      const current = snapshot ? decideGroupNextAction(snapshot) : null;
      const saved = getGroupActionByJobId(jobId);
      if (
        !trigger ||
        trigger.groupId !== action.groupId ||
        trigger.taskId !== action.taskId ||
        trigger.taskVersion !== action.taskVersion ||
        trigger.executionId !== action.executionId ||
        !current ||
        current.kind !== action.decision.kind ||
        current.idempotencyKey !== action.decision.idempotencyKey ||
        current.targetSessionId !== wake.sessionId ||
        saved?.id !== action.id ||
        saved.deliveryState !== "dispatched" ||
        saved.wakeMessageId !== wake.triggerMessageId ||
        getGroupJob(jobId)?.status !== "pending"
      ) {
        this.cancelStaleAutomaticWake(wake, action.id);
        return;
      }
      const window = this.host.getWindow();
      if (
        !window ||
        this.host.isUpdatePending() ||
        this.running.has(wake.sessionId) ||
        this.gated.has(wake.sessionId) ||
        this.cancelling.has(wake.sessionId) ||
        this.runtime.isSessionStreaming(wake.sessionId)
      ) {
        this.scheduleRetry();
        return;
      }
      // No await separates the final authority check from starting the exact job.
      this.queues.get(wake.sessionId)?.shift();
      if (this.queues.get(wake.sessionId)?.length === 0) this.queues.delete(wake.sessionId);
      this.start(window, wake);
    } catch (error) {
      console.warn("[modus] automatic group job validation failed:", error);
      this.cancelStaleAutomaticWake(wake, action.id);
    } finally {
      if (jobId) this.validatingWakes.delete(jobId);
      this.pump();
    }
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
    while (this.running.size + this.validatingWakes.size < this.maxConcurrent) {
      const heads = [...this.queues.entries()]
        // One group turn per member: a gated turn is still pending in that session.
        .filter(
          ([sessionId]) =>
            !this.running.has(sessionId) &&
            !this.gated.has(sessionId) &&
            !this.cancelling.has(sessionId),
        )
        .map(([, queue]) => queue[0])
        .filter(
          (wake): wake is Wake =>
            wake !== undefined && (!wake.id || !this.validatingWakes.has(wake.id)),
        )
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
      const action = next.id ? getGroupActionByJobId(next.id) : undefined;
      if (action && next.id) {
        const explicitAcceptance =
          action.decision.kind === "suggest" &&
          action.deliveryState === "dispatched" &&
          action.wakeMessageId === next.triggerMessageId &&
          action.resolutionTargetSessionId === next.sessionId &&
          action.resolvedExecutionId === next.chainId;
        if (!explicitAcceptance) {
          this.validatingWakes.add(next.id);
          void this.validateAutomaticWake(next, action);
          continue;
        }
      }
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
      const groupTask = findGroupTaskForWake(wake.groupId, wake.sessionId, wake.chainId);
      turn = this.runtime.prompt(window, {
        sessionId: wake.sessionId,
        message: this.freshPrompt(wake),
        context: contextItems,
        delivery: "normal",
        ...(groupTask ? { groupTask } : {}),
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
    if (
      !this.running.has(wake.sessionId) &&
      !this.gated.has(wake.sessionId) &&
      (this.queues.get(wake.sessionId)?.length ?? 0) === 0
    ) {
      unbindSessionExecution(wake.sessionId);
    }
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
