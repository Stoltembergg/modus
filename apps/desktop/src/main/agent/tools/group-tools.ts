import { randomUUID } from "node:crypto";
import {
  type AgentToolResult,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { GroupMessage, GroupTask, GroupTaskStatus } from "../../../shared/contracts";
import {
  GROUP_BLOCKED_TEXT,
  groupBlockedErrorCode,
  groupBlockedReason,
} from "../../../shared/group-blocked";
import { formatGroupCollabStatus } from "../../../shared/group-collab-status";
import { encodeGroupErrorMessage, isGroupErrorCode } from "../../../shared/group-errors";
import { sessionExecutionId } from "../../../shared/group-execution-link";
import { evaluateGroupTaskGate } from "../../../shared/group-task-policy";
import type {
  GroupTaskDraft,
  GroupTaskProgressInput,
  GroupTaskReview,
} from "../../../shared/group-work-state";
import { GROUP_MEMBER_TOOL_NAMES, type ToolProfileName } from "../../../shared/tools";
import {
  createMemberWorktree,
  MemberBranchCheckedOutError,
  MemberWorktreeUnavailableError,
} from "../../git/git-service";
import {
  ESTIMATED_CONTEXT_TOKENS_PER_WAKE,
  estimateGroupTokens,
  type GroupTaskWake,
  type GroupWorktreeReady,
} from "../../groups/group-runtime";
import {
  assignGroupTask,
  claimGroupTask,
  createMemberGroupTask,
  fillMemberTaskBranches,
  GroupStoreError,
  getAgentGroup,
  getAgentGroupForSession,
  getGroupMessage,
  listAgentGroupMembers,
  listGroupMessages,
  listGroupTasks,
  memberWorktreeBranchPrefix,
  recordGroupDecision,
  releaseGroupTask,
  requestGroupTaskReview,
} from "../../groups/group-store";
import { verifyGroupTaskForTransition } from "../../groups/group-task-evidence";
import {
  applyGroupAgreementOperation,
  applyGroupTasklessOperation,
  applyGroupTaskOperation,
  commitVerifiedGroupTask,
  type GroupTaskOperationInput,
  type GroupTaskOperationResult,
  getGroupTask,
  handoffGroupTask,
  hasGroupTaskDispatchReceipt,
  hasGroupTaskExplicitDispatch,
  markGroupTaskExplicitDispatch,
  replayGroupTaskOperation,
  reportGroupTaskProgress,
} from "../../groups/group-task-store";
import { getGroupWorkState } from "../../groups/group-work-state";
import { getWorkspace } from "../../workspace/workspace-store";
import { getActiveAgentRun } from "../agent-run-store";
import { getAgentSession, updateAgentSessionWorktree } from "../agent-store";
import { toolRegistry } from "./registry";
import { lastAssistantToolCallCount } from "./tool-batch";
import { resolveAgentToolContext } from "./tool-context";

/**
 * Agent Groups member tools (PR 4a). Active ONLY in sessions that are group
 * members (see activeToolNamesForSession); every call re-checks membership.
 * There is deliberately no "post to room" tool: a member's final turn text is
 * the only way it posts. Task transition rules live in the group store; a
 * rejected transition comes back to the model as `[group-error:<code>] …`
 * text, never as a thrown error. PR 4b adds group_start_worktree (a member's
 * own worktree + branch of the group's Project, see startMemberWorktree).
 * PR 6 adds group_record_decision (the group's shared context; only the user
 * deletes decisions, from the room's side panel).
 */

export const GROUP_READ_MESSAGES_TOOL = "group_read_messages";
export const GROUP_LIST_TASKS_TOOL = "group_list_tasks";
export const GROUP_CREATE_TASK_TOOL = "group_create_task";
export const GROUP_CLAIM_TASK_TOOL = "group_claim_task";
export const GROUP_RELEASE_TASK_TOOL = "group_release_task";
export const GROUP_REQUEST_REVIEW_TOOL = "group_request_review";
export const GROUP_REVIEW_TASK_TOOL = "group_review_task";
export const GROUP_START_WORKTREE_TOOL = "group_start_worktree";
export const GROUP_RECORD_DECISION_TOOL = "group_record_decision";
export const GROUP_ASSIGN_TASK_TOOL = "group_assign_task";
export const GROUP_PROPOSE_AGREEMENT_TOOL = "group_propose_agreement";
export const GROUP_AGREE_TOOL = "group_agree";
export const GROUP_BLOCK_TOOL = "group_block";
export const GROUP_HANDOFF_TOOL = "group_handoff";

export const GROUP_REPORT_PROGRESS_TOOL = "group_report_progress";
export const GROUP_GET_WORK_STATE_TOOL = "group_get_work_state";
export const GROUP_TOOL_NAMES = GROUP_MEMBER_TOOL_NAMES;

export type GroupToolName = (typeof GROUP_TOOL_NAMES)[number];
/** The tools runGroupTool runs synchronously (group_start_worktree runs git: startMemberWorktree). */
export type SyncGroupToolName = Exclude<
  GroupToolName,
  typeof GROUP_START_WORKTREE_TOOL | typeof GROUP_REVIEW_TASK_TOOL | typeof GROUP_AGREE_TOOL
>;

/** Page size cap for group_read_messages. */
export const GROUP_READ_MESSAGES_MAX_LIMIT = 50;
const GROUP_READ_MESSAGES_DEFAULT_LIMIT = 20;
/** Same estimated cap as one wake's group context (chars / 4, estimateGroupTokens). */
export const GROUP_READ_MESSAGES_MAX_TOKENS = ESTIMATED_CONTEXT_TOKENS_PER_WAKE;
const MAX_NOTE_CHARS = 500;

/* ── wake sink (set by the app wiring; the GroupRuntime routes the wake) ── */

type TaskWakeSink = (wake: GroupTaskWake) => Pick<GroupMessage, "id"> | undefined;
let taskWakeSink: TaskWakeSink | undefined;

/** A persisted message ID acknowledges durable delivery; absence leaves the operation retryable. */
export function setGroupTaskWakeSink(sink: TaskWakeSink | undefined): void {
  taskWakeSink = sink;
}

let worktreeReadySink: ((ready: GroupWorktreeReady) => boolean) | undefined;

/**
 * Told when group_start_worktree moved a member's cwd (GroupRuntime.handleWorktreeReady
 * in the app). Returns true when the call ran inside the member's group turn:
 * that turn then ends after the tool result and the runtime re-wakes the member.
 */
export function setGroupWorktreeReadySink(
  sink: ((ready: GroupWorktreeReady) => boolean) | undefined,
): void {
  worktreeReadySink = sink;
}

/* ── core (pure of PI; tested directly) ──────────────────────────────── */

export type GroupToolCaller = {
  sessionId: string;
  groupId?: string | undefined;
  runId?: string | undefined;
  toolCallId?: string;
};
type TaskOperationParams = { expectedVersion?: number; operationId?: string };

type TaskStatusParam = GroupTaskStatus;

export type GroupToolParams = {
  group_read_messages: { before?: string; limit?: number };
  group_list_tasks: { status?: TaskStatusParam; owner?: string; executionId?: string };
  group_create_task: TaskOperationParams & {
    title?: string;
    description?: string;
    reviewer?: string;
    draft?: Omit<GroupTaskDraft, "groupId" | "reviewerSessionId">;
  };
  group_claim_task: TaskOperationParams & { id: string };
  group_release_task: TaskOperationParams & { id: string };
  group_request_review: TaskOperationParams & { id: string; reviewer: string };
  group_review_task: TaskOperationParams & {
    id: string;
    verdict: "approve" | "changes";
    note?: string;
    approvedCriterionIds?: string[];
  };
  group_start_worktree: Record<string, never>;
  group_record_decision: { text: string };
  group_assign_task: TaskOperationParams & { taskId: string; memberId: string; note?: string };
  group_propose_agreement: TaskOperationParams & {
    summary: string;
    taskId?: string;
    confirmer?: string;
  };
  group_agree: TaskOperationParams & { note?: string; taskId?: string; decision?: string };
  group_block: TaskOperationParams & { reason: string; taskId?: string; returnTo?: string };
  group_handoff: TaskOperationParams & {
    memberId: string;
    objective: string;
    taskTitle?: string;
    taskId?: string;
  };
  group_report_progress: Omit<GroupTaskProgressInput, "groupId" | "actorSessionId">;
  group_get_work_state: { executionId?: string };
};

class ToolInputError extends Error {
  constructor(
    readonly code:
      | "not-a-member"
      | "invalid-value"
      | "message-not-found"
      | "ambiguous-member"
      | "no-git-project"
      | "branch-checked-out"
      | "call-alone"
      | "member-archived"
      | "group-project-required"
      | "group-min-members",
    message: string,
  ) {
    super(message);
  }
}

function errorText(error: unknown): string {
  if (error instanceof ToolInputError) return encodeGroupErrorMessage(error.code, error.message);
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (error instanceof Error && isGroupErrorCode(code)) {
    return encodeGroupErrorMessage(code, error.message);
  }
  return `Group tool failed: ${error instanceof Error ? error.message : String(error)}`;
}

type Roster = {
  groupId: string;
  /** Session id → its agent's name (names are unique across agents). */
  titles: Map<string, string>;
  /** Members whose agent is archived (still members, never woken or assigned). */
  archived: Set<string>;
  handles: Map<string, string>;
  /** Normalized titles shared by several members → their session ids. */
  ambiguous: Map<string, string[]>;
};

function roster(groupId: string): Roster {
  const titles = new Map<string, string>();
  const handles = new Map<string, string>();
  const archived = new Set<string>();
  for (const member of listAgentGroupMembers(groupId)) {
    titles.set(member.sessionId, member.name);
    handles.set(member.sessionId.toLowerCase(), member.sessionId);
    if (member.archived) archived.add(member.sessionId);
  }
  // Titles resolve only when unique (case-insensitive); ids always resolve.
  const byTitle = new Map<string, string[]>();
  for (const [sessionId, title] of titles) {
    const key = title.trim().replace(/^@/, "").toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), sessionId]);
  }
  const ambiguous = new Map<string, string[]>();
  for (const [key, ids] of byTitle) {
    if (ids.length === 1 && ids[0]) handles.set(key, ids[0]);
    else if (!handles.has(key)) ambiguous.set(key, ids);
  }
  return { groupId, titles, archived, handles, ambiguous };
}

/** A member by session id or unique title (with or without a leading @). */
function resolveMember(members: Roster, handle: string): string {
  const key = handle.trim().replace(/^@/, "").toLowerCase();
  const id = members.handles.get(key);
  const matches = id ? undefined : members.ambiguous.get(key);
  if (matches) {
    throw new ToolInputError(
      "ambiguous-member",
      `"${handle}" matches ${matches.length} members (${matches.join(", ")}); retry with one of these session ids.`,
    );
  }
  if (!id) {
    throw new ToolInputError(
      "not-a-member",
      `"${handle}" is not a member of this group (use a member's title or session id).`,
    );
  }
  return id;
}

/** The caller's group, re-checked now (the member may have left since the turn began). */
function requireCallerGroup(caller: GroupToolCaller): string {
  const current = getAgentGroupForSession(caller.sessionId)?.id;
  if (!current || (caller.groupId !== undefined && current !== caller.groupId)) {
    throw new ToolInputError("not-a-member", "This session is not a member of an agent group.");
  }
  return current;
}

function label(members: Roster, sessionId: string | undefined): string {
  if (!sessionId) return "none";
  return `@${members.titles.get(sessionId) ?? sessionId}`;
}

function formatTask(members: Roster, task: GroupTask, state = false): string {
  const parts = [
    `task ${task.id} [${task.status}] "${task.title}"`,
    `owner=${label(members, task.ownerSessionId)}`,
    `reviewer=${label(members, task.reviewerSessionId)}`,
  ];
  if (state)
    parts.push(
      `version=${task.stateVersion} stage=${task.stage ?? "none"} blocked=${task.blockedReason ?? "none"} dependencies=${(task.dependencyIds ?? []).join(",") || "none"} criteria=${task.criteria?.length ?? 0} evidence=${task.evidenceRefs?.length ?? 0}`,
    );
  if (task.branch) parts.push(`branch=${task.branch}`);
  const head = parts.join(" ");
  return task.description ? `${head}\n  ${task.description}` : head;
}

function formatMessage(members: Roster, message: GroupMessage): string {
  const author =
    message.authorKind === "agent" ? label(members, message.authorSessionId) : message.authorKind;
  const kind = message.kind === "status" ? " status" : "";
  return `[${message.id} ${message.createdAt}] ${author}${kind}: ${message.body}`;
}

function readMessages(
  groupId: string,
  members: Roster,
  params: { before?: string; limit?: number },
) {
  const limit = Math.max(
    1,
    Math.min(
      GROUP_READ_MESSAGES_MAX_LIMIT,
      Math.floor(params.limit ?? GROUP_READ_MESSAGES_DEFAULT_LIMIT),
    ),
  );
  let before: { createdAt: string; id: string } | undefined;
  if (params.before) {
    const anchor = getGroupMessage(params.before);
    if (!anchor || anchor.groupId !== groupId) {
      throw new ToolInputError(
        "message-not-found",
        `Message ${params.before} is not in this group.`,
      );
    }
    before = { createdAt: anchor.createdAt, id: anchor.id };
  }
  // One extra row tells whether older messages exist.
  const page = listGroupMessages(groupId, { ...(before ? { before } : {}), limit: limit + 1 });
  let hasOlder = page.length > limit;
  const window = hasOlder ? page.slice(1) : page;
  // Newest first until the estimated cap, shown oldest first.
  const lines: string[] = [];
  let used = 0;
  let oldest: GroupMessage | undefined;
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const message = window[index];
    if (!message) continue;
    const line = formatMessage(members, message);
    const cost = estimateGroupTokens(`${line}\n`);
    if (used + cost > GROUP_READ_MESSAGES_MAX_TOKENS) {
      hasOlder = true;
      break;
    }
    used += cost;
    lines.unshift(line);
    oldest = message;
  }
  if (lines.length === 0) {
    return hasOlder
      ? `The next message exceeds the ${GROUP_READ_MESSAGES_MAX_TOKENS / 1000}k-token read cap.`
      : "No messages.";
  }
  const footer =
    hasOlder && oldest
      ? `\n(older messages: call ${GROUP_READ_MESSAGES_TOOL} with before="${oldest.id}")`
      : "\n(no older messages)";
  return `${lines.join("\n")}${footer}`;
}

function operationInput(
  name: GroupToolName,
  caller: GroupToolCaller,
  groupId: string,
  params: TaskOperationParams & { id?: string; taskId?: string },
): GroupTaskOperationInput {
  return {
    groupId,
    actorSessionId: caller.sessionId,
    action: name,
    operationId:
      params.operationId ??
      (caller.toolCallId
        ? `group:${caller.runId ?? caller.sessionId}:${caller.toolCallId}`
        : randomUUID()),
    ...((params.id ?? params.taskId) ? { taskId: params.id ?? params.taskId } : {}),
    ...(params.expectedVersion !== undefined ? { expectedVersion: params.expectedVersion } : {}),
    params,
  };
}

/** Runtime receipts allow event replay without creating a second message or wake. */
function shouldDeliverTaskOperation(operationId: string): boolean {
  return !hasGroupTaskExplicitDispatch(operationId) || hasGroupTaskDispatchReceipt(operationId);
}

function dispatchTaskOperation(
  wake: GroupTaskWake,
  operation: GroupTaskOperationInput | undefined,
  result: GroupTaskOperationResult | undefined,
  caller: GroupToolCaller,
): void {
  if (!taskWakeSink) return;
  if (operation && result && !shouldDeliverTaskOperation(operation.operationId)) return;
  const ack = taskWakeSink({
    ...wake,
    ...(operation &&
    result &&
    ((operation.params as TaskOperationParams).operationId || caller.toolCallId)
      ? {
          taskId: result.task.id,
          operationId: operation.operationId,
          sourceEventId: result.eventId,
        }
      : {}),
  });
  if (!ack?.id)
    throw new Error("Group task delivery was not acknowledged; retry the same operation.");
  if (operation && result) markGroupTaskExplicitDispatch(operation.operationId);
}

/** Runs one member tool for `caller`; always returns text (errors included). */
export function runGroupTool<N extends SyncGroupToolName>(
  name: N,
  caller: GroupToolCaller,
  params: GroupToolParams[N],
): string {
  try {
    const groupId = requireCallerGroup(caller);
    const members = roster(groupId);
    const blocked =
      name === "group_assign_task"
        ? groupBlockedReason(getAgentGroup(groupId) ?? {}, members.titles.size)
        : null;
    if (blocked) {
      // A blocked group is read-only: no assign (and so no wake).
      throw new ToolInputError(groupBlockedErrorCode(blocked), GROUP_BLOCKED_TEXT[blocked]);
    }
    const actor = caller.sessionId;
    const op = operationInput(name, caller, groupId, params as TaskOperationParams);
    let operationResult: GroupTaskOperationResult | undefined;
    const mutate = (
      write: () => GroupTask | { task: GroupTask; data?: Record<string, string> },
    ) => {
      operationResult = applyGroupTaskOperation(op, write);
      return operationResult.task;
    };
    const dispatch = (wake: GroupTaskWake) =>
      dispatchTaskOperation(wake, op, operationResult, caller);
    switch (name) {
      case "group_get_work_state":
        return JSON.stringify(
          getGroupWorkState(
            groupId,
            (params as GroupToolParams["group_get_work_state"]).executionId,
          ),
        );
      case "group_report_progress": {
        const input = params as GroupToolParams["group_report_progress"];
        const task = mutate(() =>
          reportGroupTaskProgress({ ...input, groupId, actorSessionId: actor }),
        );
        return `Progress: ${formatTask(members, task, true)}`;
      }
      case "group_read_messages":
        return readMessages(groupId, members, params as GroupToolParams["group_read_messages"]);
      case "group_list_tasks": {
        const { status, owner, executionId } = params as GroupToolParams["group_list_tasks"];
        const ownerId = owner ? resolveMember(members, owner) : undefined;
        const tasks = listGroupTasks(groupId, status ? { status } : {}).filter(
          (task) =>
            (!ownerId || task.ownerSessionId === ownerId) &&
            (!executionId || task.executionId === executionId),
        );
        return tasks.length > 0
          ? tasks.map((t) => formatTask(members, t, true)).join("\n")
          : "No tasks.";
      }
      case "group_create_task": {
        const input = params as GroupToolParams["group_create_task"];
        const executionId = sessionExecutionId(actor);
        const task = mutate(() =>
          createMemberGroupTask({
            ...input.draft,
            groupId,
            actorSessionId: actor,
            title: input.draft?.title ?? input.title ?? "",
            ...(input.description ? { description: input.description } : {}),
            ...(input.reviewer
              ? { reviewerSessionId: resolveMember(members, input.reviewer) }
              : {}),
            ...(executionId ? { executionId } : {}),
          }),
        );
        return `Created ${formatTask(members, task)}`;
      }
      case "group_claim_task": {
        const { id } = params as GroupToolParams["group_claim_task"];
        const branch = memberWorktreeBranch(groupId, actor);
        const task = mutate(() => claimGroupTask(groupId, id, actor, branch ? { branch } : {}));
        return `Claimed ${formatTask(members, task)}`;
      }
      case "group_release_task": {
        const { id } = params as GroupToolParams["group_release_task"];
        return `Released ${formatTask(
          members,
          mutate(() => releaseGroupTask(groupId, id, actor)),
        )}`;
      }
      case "group_request_review": {
        const input = params as GroupToolParams["group_request_review"];
        const reviewer = resolveMember(members, input.reviewer);
        const task = mutate(() => requestGroupTaskReview(groupId, input.id, actor, reviewer));
        dispatch({
          groupId,
          actorSessionId: actor,
          targetSessionId: reviewer,
          body: `Review requested: "${task.title}" (task ${task.id}) ${label(members, reviewer)}`,
        });
        return `Review requested from ${label(members, reviewer)}: ${formatTask(members, task)}`;
      }
      case "group_record_decision": {
        const { text } = params as GroupToolParams["group_record_decision"];
        const executionId = sessionExecutionId(actor);
        const decision = recordGroupDecision({
          groupId,
          text,
          authorSessionId: actor,
          ...(executionId ? { executionId } : {}),
        });
        // Recorded in the room as the member, but wakes nobody.
        dispatch({
          groupId,
          actorSessionId: actor,
          body: `Decision: ${decision.text}`,
          wake: false,
        });
        return `Recorded decision ${decision.id}: ${decision.text}`;
      }
      case "group_assign_task": {
        const input = params as GroupToolParams["group_assign_task"];
        const assignee = resolveMember(members, input.memberId);
        if (members.archived.has(assignee)) {
          throw new ToolInputError(
            "member-archived",
            `${label(members, assignee)} is archived and cannot take tasks.`,
          );
        }
        const branch = memberWorktreeBranch(groupId, assignee);
        const task = mutate(() => {
          const assigned = assignGroupTask(
            groupId,
            input.taskId,
            actor,
            assignee,
            branch ? { branch } : {},
          );
          return {
            task: assigned.task,
            ...(assigned.previousOwnerSessionId
              ? { data: { previousOwnerSessionId: assigned.previousOwnerSessionId } }
              : {}),
          };
        });
        const previousOwnerSessionId = operationResult?.data?.previousOwnerSessionId;
        const note = input.note?.trim().slice(0, MAX_NOTE_CHARS);
        const subject = `"${task.title}" (task ${task.id})`;
        // A reassigned task keeps the old owner's branch (where the earlier work is).
        const body = previousOwnerSessionId
          ? `Reassigned: ${subject}: ${label(members, previousOwnerSessionId)} → ${label(members, assignee)}${
              task.branch ? ` (branch: \`${task.branch}\`)` : ""
            }`
          : `Assigned: ${subject} → ${label(members, assignee)}`;
        // Wakes the new owner (a hop); the Lead assigning itself only posts the line.
        dispatch({
          groupId,
          actorSessionId: actor,
          targetSessionId: assignee,
          body: note ? `${body}: ${note}` : body,
          ...(assignee === actor ? { wake: false } : {}),
        });
        return `${previousOwnerSessionId ? "Reassigned" : "Assigned"} ${formatTask(members, task)}`;
      }
      case "group_propose_agreement": {
        const input = params as GroupToolParams["group_propose_agreement"];
        const summary = input.summary.trim();
        if (!summary) {
          throw new ToolInputError("invalid-value", "summary is required.");
        }
        let taskLine = "";
        const taskId = input.taskId;
        if (taskId) {
          if (input.confirmer) {
            const confirmer = resolveMember(members, input.confirmer);
            const task = mutate(() => requestGroupTaskReview(groupId, taskId, actor, confirmer));
            dispatch({
              groupId,
              actorSessionId: actor,
              targetSessionId: confirmer,
              body: formatGroupCollabStatus({ kind: "proposed", summary }),
            });
            taskLine = ` Task ${formatTask(members, task)}.`;
          } else {
            const tasks = listGroupTasks(groupId);
            const task = tasks.find((item) => item.id === input.taskId);
            if (!task) {
              throw new ToolInputError("invalid-value", `Unknown task ${input.taskId}.`);
            }
            dispatch({
              groupId,
              actorSessionId: actor,
              body: formatGroupCollabStatus({ kind: "proposed", summary }),
              wake: false,
            });
            taskLine = ` Task ${formatTask(members, task)}.`;
          }
        } else {
          dispatch({
            groupId,
            actorSessionId: actor,
            body: formatGroupCollabStatus({ kind: "proposed", summary }),
            wake: false,
          });
        }
        return `Proposed agreement: ${summary}.${taskLine}`;
      }
      case "group_block": {
        const input = params as GroupToolParams["group_block"];
        const reason = input.reason.trim();
        if (!reason) {
          throw new ToolInputError("invalid-value", "reason is required.");
        }
        if (input.taskId && !listGroupTasks(groupId).some((task) => task.id === input.taskId))
          throw new ToolInputError("invalid-value", `Unknown task ${input.taskId}.`);
        const returnTo = input.returnTo ? resolveMember(members, input.returnTo) : undefined;
        const taskId = input.taskId;
        if (taskId)
          mutate(() =>
            reportGroupTaskProgress({
              groupId,
              taskId,
              actorSessionId: actor,
              expectedVersion: input.expectedVersion ?? getGroupTask(taskId).stateVersion ?? 1,
              operationId: op.operationId,
              blockedReason: reason,
            }),
          );
        const body = formatGroupCollabStatus({ kind: "blocked", reason });
        dispatch({
          groupId,
          actorSessionId: actor,
          body,
          ...(returnTo ? { targetSessionId: returnTo } : {}),
          ...(!returnTo || returnTo === actor ? { wake: false } : {}),
        });
        const taskNote = input.taskId ? ` (task ${input.taskId})` : "";
        return `Blocked${taskNote}: ${reason}`;
      }
      case "group_handoff": {
        const input = params as GroupToolParams["group_handoff"];
        const objective = input.objective.trim();
        if (!objective) {
          throw new ToolInputError("invalid-value", "objective is required.");
        }
        const target = resolveMember(members, input.memberId);
        if (members.archived.has(target)) {
          throw new ToolInputError(
            "member-archived",
            `${label(members, target)} is archived and cannot take handoffs.`,
          );
        }
        const targetName = members.titles.get(target) ?? target;
        let taskLine = "";
        if (input.taskId && input.taskTitle)
          throw new ToolInputError("invalid-value", "Use taskId or taskTitle, not both.");
        const taskTitle = input.taskTitle?.trim();
        if (input.taskId || taskTitle) {
          const executionId = sessionExecutionId(actor);
          const branch = memberWorktreeBranch(groupId, target);
          const task = mutate(() =>
            handoffGroupTask({
              groupId,
              actorSessionId: actor,
              targetSessionId: target,
              description: objective,
              ...(input.taskId ? { taskId: input.taskId } : { title: taskTitle ?? "" }),
              ...(executionId ? { executionId } : {}),
              ...(branch ? { branch } : {}),
            }),
          );
          taskLine = ` ${input.taskId ? "Assigned" : "Created"} ${formatTask(members, task)}.`;
        }
        const body = formatGroupCollabStatus({
          kind: "handoff",
          targetName,
          objective,
        });
        if (!input.taskId && !taskTitle) {
          const saved = applyGroupTasklessOperation(op, () => ({
            text: `Handed off to ${label(members, target)}: ${objective}.`,
            wake: {
              groupId,
              actorSessionId: actor,
              targetSessionId: target,
              body,
              ...(target === actor ? { wake: false } : {}),
            },
          }));
          if (taskWakeSink && shouldDeliverTaskOperation(op.operationId)) {
            const ack = taskWakeSink({
              ...saved.wake,
              ...(input.operationId || caller.toolCallId
                ? { operationId: op.operationId, sourceEventId: saved.sourceEventId }
                : {}),
            });
            if (!ack?.id)
              throw new Error(
                "Group task delivery was not acknowledged; retry the same operation.",
              );
            markGroupTaskExplicitDispatch(op.operationId);
          }
          return saved.text;
        }
        dispatch({
          groupId,
          actorSessionId: actor,
          targetSessionId: target,
          body,
          ...(target === actor ? { wake: false } : {}),
        });
        return `Handed off to ${label(members, target)}: ${objective}.${taskLine}`;
      }
      default:
        throw new ToolInputError("invalid-value", `Unknown group tool ${String(name)}.`);
    }
  } catch (error) {
    return errorText(error);
  }
}

/** Git verification completes before opening the synchronous Task Store operation. */
export async function runGroupVerifiedTool<N extends "group_review_task" | "group_agree">(
  name: N,
  caller: GroupToolCaller,
  params: GroupToolParams[N],
): Promise<string> {
  try {
    const groupId = requireCallerGroup(caller);
    const members = roster(groupId);
    const actor = caller.sessionId;
    const op = operationInput(name, caller, groupId, params);
    let result: GroupTaskOperationResult | undefined;
    const reviewParams = params as GroupToolParams["group_review_task"];
    const agreeParams = params as GroupToolParams["group_agree"];
    const taskId = name === "group_review_task" ? reviewParams.id : agreeParams.taskId;
    const note = params.note?.trim().slice(0, MAX_NOTE_CHARS) ?? "";
    if (name === "group_review_task" && !["approve", "changes"].includes(reviewParams.verdict))
      throw new ToolInputError("invalid-value", 'verdict must be "approve" or "changes".');
    if (!taskId) {
      const executionId = sessionExecutionId(actor);
      const decision = applyGroupAgreementOperation(op, () =>
        recordGroupDecision({
          groupId,
          authorSessionId: actor,
          text: agreeParams.decision?.trim() || note || "Agreed",
          ...(executionId ? { executionId } : {}),
        }),
      );
      if (taskWakeSink && shouldDeliverTaskOperation(op.operationId)) {
        const ack = taskWakeSink({
          groupId,
          actorSessionId: actor,
          body: formatGroupCollabStatus({ kind: "agreed", note }),
          wake: false,
          ...(params.operationId || caller.toolCallId
            ? { operationId: op.operationId, sourceEventId: decision.id }
            : {}),
        });
        if (!ack?.id)
          throw new Error("Group task delivery was not acknowledged; retry the same operation.");
        markGroupTaskExplicitDispatch(op.operationId);
      }
      return `Agreed. Recorded decision ${decision.id}: ${decision.text}`;
    }
    result = replayGroupTaskOperation(op);
    if (!result) {
      const task = getGroupTask(taskId);
      if (task.groupId !== groupId)
        throw new ToolInputError("invalid-value", `Unknown task ${taskId}.`);
      if (task.status === "done" || task.status === "cancelled")
        throw new GroupStoreError("invalid-transition", `Task ${task.id} is closed.`);
      if (
        name === "group_review_task" &&
        (task.status !== "in_review" || task.reviewerSessionId !== actor)
      )
        throw new GroupStoreError(
          "not-reviewer",
          `Only the reviewer of a pending review can review task ${taskId}.`,
        );
      const expectedVersion = params.expectedVersion ?? task.stateVersion ?? 1;
      if (name === "group_review_task" && reviewParams.verdict === "changes") {
        const snapshot = await verifyGroupTaskForTransition({
          taskId,
          expectedVersion,
          action: "approve",
        });
        const review: GroupTaskReview = {
          reviewerSessionId: actor,
          verdict: "changes",
          criteriaVersion: task.criteriaVersion ?? 1,
          sourceFingerprint: snapshot.sourceFingerprint,
          eventId: op.operationId,
          approvedCriterionIds: [],
        };
        result = applyGroupTaskOperation(op, () =>
          commitVerifiedGroupTask({
            groupId,
            taskId,
            actorSessionId: actor,
            action: "changes",
            snapshot,
            review,
          }),
        );
      } else {
        let snapshot = await verifyGroupTaskForTransition({
          taskId,
          expectedVersion,
          action: name === "group_review_task" ? "approve" : "agree",
        });
        let review: GroupTaskReview | undefined;
        if (name === "group_review_task") {
          const approvedCriterionIds =
            reviewParams.approvedCriterionIds ??
            (task.criteria ?? [])
              .filter((criterion) => criterion.requiredCheckKinds.length > 0)
              .map((criterion) => criterion.id);
          if (
            approvedCriterionIds.some(
              (id) => !(task.criteria ?? []).some((criterion) => criterion.id === id),
            )
          )
            throw new ToolInputError("invalid-value", "Approval contains an unknown criterion ID.");
          review = {
            reviewerSessionId: actor,
            verdict: "approve",
            criteriaVersion: task.criteriaVersion ?? 1,
            sourceFingerprint: snapshot.sourceFingerprint,
            eventId: op.operationId,
            approvedCriterionIds,
          };
          snapshot = await verifyGroupTaskForTransition({
            taskId,
            expectedVersion,
            action: "approve",
            review,
          });
        }
        result = applyGroupTaskOperation(op, () => {
          if (name === "group_review_task")
            return commitVerifiedGroupTask({
              groupId,
              taskId,
              actorSessionId: actor,
              action: "approve",
              snapshot,
              ...(review ? { review } : {}),
            });
          const executionId = sessionExecutionId(actor);
          const decision = recordGroupDecision({
            groupId,
            authorSessionId: actor,
            text: (agreeParams.decision?.trim() || note || "Agreed").slice(0, MAX_NOTE_CHARS),
            ...(executionId ? { executionId } : {}),
          });
          // A failed completion still records the agreement; it cannot advance the task.
          const gate = evaluateGroupTaskGate(snapshot);
          if (!gate.satisfied)
            return {
              task: getGroupTask(taskId),
              data: {
                decisionId: decision.id,
                decisionText: decision.text,
                gateReason: gate.reasonCodes.join(", "),
              },
            };
          const completed = commitVerifiedGroupTask({
            groupId,
            taskId,
            actorSessionId: actor,
            action: "agree",
            snapshot,
          });
          return {
            task: completed,
            data: { decisionId: decision.id, decisionText: decision.text },
          };
        });
      }
    }
    const task = result.task;
    if (name === "group_agree") {
      dispatchTaskOperation(
        {
          groupId,
          actorSessionId: actor,
          body: formatGroupCollabStatus({ kind: "agreed", note }),
          wake: false,
        },
        op,
        result,
        caller,
      );
      const decision = `Recorded decision ${result.data?.decisionId}: ${result.data?.decisionText}`;
      return result.data?.gateReason
        ? `[group-error:verification-required] Task ${task.id} cannot complete: ${result.data.gateReason}. ${decision}`
        : `Agreed. Closed ${formatTask(members, task)}. ${decision}`;
    }
    if (task.ownerSessionId)
      dispatchTaskOperation(
        {
          groupId,
          actorSessionId: actor,
          targetSessionId: task.ownerSessionId,
          body:
            reviewParams.verdict === "approve"
              ? note
                ? `Approved: ${note}`
                : "Approved"
              : `Changes requested on "${task.title}" (task ${task.id}) ${label(members, task.ownerSessionId)}${note ? `: ${note}` : ""}`,
          ...(reviewParams.verdict === "approve" ? { wake: false } : {}),
        },
        op,
        result,
        caller,
      );
    return `${reviewParams.verdict === "approve" ? "Approved" : "Changes requested"}: ${formatTask(members, task)}`;
  } catch (error) {
    return errorText(error);
  }
}

/** The member's worktree branch in `groupId`, when it has started one. */
function memberWorktreeBranch(groupId: string, sessionId: string): string | undefined {
  const branch = getAgentSession(sessionId)?.subagentWorktree?.branch;
  return branch?.startsWith(memberWorktreeBranchPrefix(groupId)) ? branch : undefined;
}

/** What group_start_worktree returns: the tool text, and whether the turn ends after it. */
export type StartWorktreeResult = { text: string; endTurn: boolean };

/**
 * group_start_worktree: gives the caller its own worktree of the group's
 * Project (created once, then reused across tasks) and moves the session's
 * cwd into it. Fills `branch` on the caller's in_progress tasks that have
 * none. Never merges anything back into the Project root. Errors come back as
 * `[group-error:<code>] …` text like runGroupTool.
 *
 * PI fixes a session's cwd (tools, permission extension, Project rules) when
 * the session is built, so a moved cwd only applies to the next turn. Inside
 * the member's group turn (the sink says so) the turn ends right after this
 * result (`endTurn` → PI `terminate`) and the GroupRuntime re-wakes the member
 * in the worktree. Outside one, or when the cwd did not move, nothing stops.
 */
export async function startMemberWorktree(caller: GroupToolCaller): Promise<StartWorktreeResult> {
  try {
    const groupId = requireCallerGroup(caller);
    const actor = caller.sessionId;
    // PI ends the turn only when every call of the batch terminates: refuse
    // before touching anything unless this call is alone (count unknown = refuse).
    const batch = lastAssistantToolCallCount(actor);
    if (batch !== 1) {
      throw new ToolInputError(
        "call-alone",
        `${
          batch === undefined
            ? "Could not tell how many tool calls your message made."
            : `Your message made ${batch} tool calls.`
        } Nothing was changed: call group_start_worktree alone in its own message.`,
      );
    }
    const workspaceId = getAgentGroupForSession(actor)?.workspaceId;
    const project = workspaceId ? getWorkspace(workspaceId) : undefined;
    if (!project) {
      throw new ToolInputError(
        "no-git-project",
        "This group has no Project; member worktrees need a Git repository Project.",
      );
    }
    const session = getAgentSession(actor);
    const memberKey = actor.replace(/[^a-z0-9]/gi, "").slice(0, 8) || actor.slice(0, 8);
    const current = memberWorktreeBranch(groupId, actor);
    // Keep the slug the member already has (its title may have changed since).
    const memberSlug = current
      ? current.slice(memberWorktreeBranchPrefix(groupId).length)
      : `${session?.title ?? "member"}-${memberKey}`;
    let worktree: Awaited<ReturnType<typeof createMemberWorktree>>;
    try {
      worktree = await createMemberWorktree(project.rootPath, { groupId, memberSlug, memberKey });
    } catch (error) {
      if (error instanceof MemberWorktreeUnavailableError) {
        throw new ToolInputError("no-git-project", error.message);
      }
      if (error instanceof MemberBranchCheckedOutError) {
        throw new ToolInputError(
          "branch-checked-out",
          `${error.message} Do not retry: the user must switch that checkout to another branch first.`,
        );
      }
      throw error;
    }
    // Re-check after git ran: a member removed meanwhile must not get its cwd moved back.
    requireCallerGroup({ sessionId: actor, groupId });
    const { cwd, created, ...info } = worktree;
    const moved = getAgentSession(actor)?.cwd !== cwd;
    updateAgentSessionWorktree(actor, info, { cwd });
    const tagged = fillMemberTaskBranches(groupId, actor, info.branch);
    const endTurn =
      moved && (worktreeReadySink?.({ groupId, sessionId: actor, branch: info.branch }) ?? false);
    const next = !moved
      ? "You are already working in it."
      : endTurn
        ? "Your turn ends now; you will be woken again in the worktree to continue the same message. Do not call more tools."
        : "It becomes your working directory from your next message; until then use absolute paths under it.";
    const text = [
      `Worktree ${created ? "created" : "reused"}: ${cwd}`,
      `branch=${info.branch} base=${info.baseSha.slice(0, 12)}`,
      tagged.length > 0
        ? `Branch set on your in_progress task(s): ${tagged.map((task) => task.id).join(", ")}.`
        : "No in_progress task of yours needed a branch.",
      next,
      "Nothing is merged back into the Project automatically.",
    ].join("\n");
    return { text, endTurn };
  } catch (error) {
    return { text: errorText(error), endTurn: false };
  }
}

/* ── PI tool definitions ─────────────────────────────────────────────── */

const idParam = Type.String({ minLength: 1, description: "Task id (from group_list_tasks)." });
const statusParam = Type.Union([
  Type.Literal("open"),
  Type.Literal("in_progress"),
  Type.Literal("blocked"),
  Type.Literal("in_review"),
  Type.Literal("done"),
  Type.Literal("cancelled"),
]);

const operationParams = {
  expectedVersion: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Authoritative version from group_get_work_state or group_list_tasks.",
    }),
  ),
  operationId: Type.Optional(
    Type.String({ minLength: 1, description: "Stable identity reused on retries." }),
  ),
};
const stageParam = Type.Union([
  Type.Literal("plan"),
  Type.Literal("implement"),
  Type.Literal("verify"),
  Type.Literal("review"),
  Type.Literal("deliver"),
]);
const draftParam = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    kind: Type.Union(
      ["legacy", "code", "docs", "design", "review", "research", "question"].map((kind) =>
        Type.Literal(kind),
      ),
    ),
    priority: Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")]),
    dependencyIds: Type.Array(idParam, { maxItems: 256 }),
    criteria: Type.Array(
      Type.Object(
        {
          id: idParam,
          description: Type.String({ minLength: 1, maxLength: 2000 }),
          requiredCheckKinds: Type.Array(
            Type.Union([
              Type.Literal("tests"),
              Type.Literal("typecheck"),
              Type.Literal("lint"),
              Type.Literal("build"),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 128 },
    ),
    verificationPolicy: Type.Object(
      {
        mode: Type.Union([Type.Literal("none"), Type.Literal("required")]),
        requireReview: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const schemas = {
  group_get_work_state: Type.Object(
    { executionId: Type.Optional(Type.String()) },
    { additionalProperties: false },
  ),
  group_report_progress: Type.Object(
    {
      taskId: idParam,
      expectedVersion: Type.Integer({ minimum: 1 }),
      stage: Type.Optional(stageParam),
      blockedReason: Type.Optional(
        Type.Union([Type.String({ minLength: 1, maxLength: MAX_NOTE_CHARS }), Type.Null()]),
      ),
      operationId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  group_read_messages: Type.Object(
    {
      before: Type.Optional(
        Type.String({ description: "Message id: return messages older than it (pagination)." }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: GROUP_READ_MESSAGES_MAX_LIMIT,
          description: "Max 50.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  group_list_tasks: Type.Object(
    {
      status: Type.Optional(statusParam),
      owner: Type.Optional(Type.String()),
      executionId: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  group_create_task: Type.Object(
    {
      ...operationParams,
      draft: Type.Optional(draftParam),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      description: Type.Optional(Type.String({ maxLength: 2_000 })),
      reviewer: Type.Optional(Type.String({ description: "Member title or session id." })),
    },
    { additionalProperties: false },
  ),
  group_claim_task: Type.Object(
    { id: idParam, ...operationParams },
    { additionalProperties: false },
  ),
  group_release_task: Type.Object(
    { id: idParam, ...operationParams },
    { additionalProperties: false },
  ),
  group_request_review: Type.Object(
    {
      ...operationParams,
      id: idParam,
      reviewer: Type.String({ minLength: 1, description: "Another member's title or session id." }),
    },
    { additionalProperties: false },
  ),
  group_review_task: Type.Object(
    {
      ...operationParams,
      id: idParam,
      verdict: Type.Union([Type.Literal("approve"), Type.Literal("changes")]),
      approvedCriterionIds: Type.Optional(Type.Array(idParam, { maxItems: 128 })),
      note: Type.Optional(Type.String({ maxLength: MAX_NOTE_CHARS })),
    },
    { additionalProperties: false },
  ),
  group_start_worktree: Type.Object({}, { additionalProperties: false }),
  // No length bounds here: the store trims and answers invalid-text itself.
  group_record_decision: Type.Object(
    { text: Type.String({ description: "The decision, 1-500 characters." }) },
    { additionalProperties: false },
  ),
  group_assign_task: Type.Object(
    {
      ...operationParams,
      taskId: idParam,
      memberId: Type.String({
        minLength: 1,
        description: "Member session id (preferred) or unique title.",
      }),
      note: Type.Optional(Type.String({ maxLength: MAX_NOTE_CHARS })),
    },
    { additionalProperties: false },
  ),
  group_propose_agreement: Type.Object(
    {
      ...operationParams,
      summary: Type.String({ minLength: 1, maxLength: MAX_NOTE_CHARS }),
      taskId: Type.Optional(idParam),
      confirmer: Type.Optional(
        Type.String({ description: "Confirmer's session id (preferred) or unique title." }),
      ),
    },
    { additionalProperties: false },
  ),
  group_agree: Type.Object(
    {
      ...operationParams,
      note: Type.Optional(Type.String({ maxLength: MAX_NOTE_CHARS })),
      taskId: Type.Optional(idParam),
      decision: Type.Optional(
        Type.String({ description: "Decision text to persist (defaults to note / Agreed)." }),
      ),
    },
    { additionalProperties: false },
  ),
  group_block: Type.Object(
    {
      ...operationParams,
      reason: Type.String({ minLength: 1, maxLength: MAX_NOTE_CHARS }),
      taskId: Type.Optional(idParam),
      returnTo: Type.Optional(
        Type.String({
          description: "Member session id (preferred) or unique title to return the blocker to.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  group_handoff: Type.Object(
    {
      ...operationParams,
      memberId: Type.String({
        minLength: 1,
        description: "Next owner's session id (preferred) or unique title.",
      }),
      objective: Type.String({ minLength: 1, maxLength: MAX_NOTE_CHARS }),
      taskId: Type.Optional(idParam),
      taskTitle: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 200,
          description: "When set, creates and assigns a group task atomically before waking.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
} satisfies Record<GroupToolName, unknown>;

const DESCRIPTIONS: Record<GroupToolName, { label: string; description: string; snippet: string }> =
  {
    group_get_work_state: {
      label: "Read group work state",
      description:
        "Read bounded authoritative task versions, stages, blockers, dependencies, QA summaries and execution budgets. Reports omitted items; Git freshness is checked during approval.",
      snippet: "group_get_work_state(executionId?) — read task versions and pending work.",
    },
    group_report_progress: {
      label: "Report group task progress",
      description:
        "Update your task stage or blocker using its expectedVersion and a stable operationId. blockedReason=null clears a block. Does not complete work.",
      snippet:
        "group_report_progress(taskId, expectedVersion, stage?, blockedReason?, operationId) — persist progress.",
    },
    group_read_messages: {
      label: "Read group messages",
      description:
        "Read the agent group's room, newest page first (oldest-first within the page). Paginate with before=<message id>. Capped at 50 messages and an estimated 8k tokens.",
      snippet: "group_read_messages(before?, limit?) — read earlier room messages.",
    },
    group_list_tasks: {
      label: "List group tasks",
      description:
        "List task versions, stages, blockers, dependencies and evidence counts; filter by status, owner or executionId.",
      snippet: "group_list_tasks(status?, owner?, executionId?) — list the group's tasks.",
    },
    group_create_task: {
      label: "Create group task",
      description:
        "Create an open, unowned task, optionally from a typed draft with kind, criteria, dependencies, priority and verification policy.",
      snippet:
        "group_create_task(title, description?, reviewer?, draft?, operationId?) — add an open task.",
    },
    group_claim_task: {
      label: "Claim group task",
      description:
        "Claim an open task nobody owns; you become its owner and it moves to in_progress.",
      snippet: "group_claim_task(id, expectedVersion?, operationId?) — take an open task.",
    },
    group_release_task: {
      label: "Release group task",
      description:
        "Give back a task you own that is in_progress; it returns to open with no owner.",
      snippet: "group_release_task(id, expectedVersion?, operationId?) — give back your task.",
    },
    group_request_review: {
      label: "Request task review",
      description:
        "Ask another member to review a task you own that is in_progress; it moves to in_review and the reviewer is woken.",
      snippet:
        "group_request_review(id, reviewer, expectedVersion?, operationId?) — hand your task to a reviewer.",
    },
    group_review_task: {
      label: "Review group task",
      description:
        'Decide a task you were asked to review: "approve" completes it only with current required QA and review criteria; "changes" sends it back to in_progress and wakes the owner (include a note).',
      snippet:
        'group_review_task(id, "approve"|"changes", note?, approvedCriterionIds?, expectedVersion?, operationId?) — review a task.',
    },
    group_start_worktree: {
      label: "Start member worktree",
      description:
        "Get your own Git worktree of the group's Project (branch group/<groupId>/<you>), created once and reused for all your tasks. Call it on its own: in a group turn your turn ends after it and you are woken again, working inside the worktree. Nothing is merged back automatically.",
      snippet: "group_start_worktree() — work in your own branch/worktree.",
    },
    group_record_decision: {
      label: "Record group decision",
      description:
        'Record a decision the group agreed on (1-500 characters) so every member sees it in the group\'s decisions from now on. Posts "Decision: <text>" in the room without waking anyone. A group keeps at most 100 decisions; only the user deletes them.',
      snippet: "group_record_decision(text) — record an agreed decision for the group.",
    },
    group_assign_task: {
      label: "Assign group task",
      description:
        "Coordinator mode, Lead only: give a task to a member (yourself included). An open task moves to in_progress with that owner; an in_progress task owned by someone else is reassigned. Posts the assignment in the room and wakes the new owner (not you). in_review, done and cancelled tasks cannot be assigned.",
      snippet:
        "group_assign_task(taskId, memberId, note?, expectedVersion?, operationId?) — as coordinator, hand a task to a member.",
    },
    group_propose_agreement: {
      label: "Propose agreement",
      description:
        "Record a proposed agreement. With a task ID and confirmer session ID, move your in_progress task to in_review and wake that member explicitly. A summary mentioning a member does not delegate work.",
      snippet:
        "group_propose_agreement(summary, taskId?, confirmer?, expectedVersion?, operationId?) — propose closing the loop.",
    },
    group_agree: {
      label: "Agree",
      description:
        "Record an agreement and a group decision, and optionally mark a task done by its ID. Completion requires current required QA and review; missing evidence records the decision and keeps the task active.",
      snippet:
        "group_agree(note?, taskId?, decision?, expectedVersion?, operationId?) — agree and close the task/decision.",
    },
    group_block: {
      label: "Block agreement",
      description:
        "Persist a concrete blocker on the selected task. Clear it with group_report_progress(blockedReason=null). Set returnTo to a member session ID to request help explicitly; reason text and @mentions do not wake members. Returning to yourself records the blocker without another turn.",
      snippet:
        "group_block(reason, taskId?, returnTo?, expectedVersion?, operationId?) — block with a reason.",
    },
    group_handoff: {
      label: "Handoff to member",
      description:
        "Delegate a concrete objective to a member using their session ID. Assigns an existing taskId or atomically creates and assigns taskTitle before waking; a self handoff only records the status. Public @mentions alone do not delegate work.",
      snippet:
        "group_handoff(memberId, objective, taskTitle?, taskId?, expectedVersion?, operationId?) — hand work to the next owner.",
    },
  };

function toResult(text: string, terminate = false): AgentToolResult<{ text: string }> {
  return {
    content: [{ type: "text", text }],
    details: { text },
    ...(terminate ? { terminate } : {}),
  };
}

function defineGroupTool(name: GroupToolName): ToolDefinition {
  const meta = DESCRIPTIONS[name];
  return defineTool({
    name,
    label: meta.label,
    description: meta.description,
    promptSnippet: meta.snippet,
    parameters: schemas[name],
    execute: async (_toolCallId, params: Static<(typeof schemas)[typeof name]>, _s, _u, ctx) => {
      const context = resolveAgentToolContext(ctx.cwd);
      const caller = {
        sessionId: context.sessionId,
        groupId: context.groupId,
        toolCallId: _toolCallId,
        runId: getActiveAgentRun(context.sessionId)?.id,
      };
      if (name === GROUP_START_WORKTREE_TOOL) {
        // `terminate`: PI stops after this tool batch (when every call in it asks to).
        const result = await startMemberWorktree(caller);
        return toResult(result.text, result.endTurn);
      }
      if (name === GROUP_REVIEW_TASK_TOOL || name === GROUP_AGREE_TOOL)
        return toResult(await runGroupVerifiedTool(name, caller, params as never));
      return toResult(runGroupTool(name, caller, params as never));
    },
  }) as ToolDefinition;
}

const READ_ONLY_TOOLS = new Set<GroupToolName>([
  GROUP_READ_MESSAGES_TOOL,
  GROUP_LIST_TASKS_TOOL,
  GROUP_GET_WORK_STATE_TOOL,
]);

let registered = false;

/** Registers the member tools (idempotent); sessions outside a group never activate them. */
export function registerGroupTools(): void {
  if (registered) return;
  registered = true;
  for (const name of GROUP_TOOL_NAMES) {
    const readOnly = READ_ONLY_TOOLS.has(name);
    const profiles: ToolProfileName[] = readOnly ? ["chat", "plan"] : ["chat"];
    toolRegistry.registerTool({
      entry: {
        name,
        profiles,
        permission: { danger: "safe" },
        capabilities: [readOnly ? "read" : "write"],
        readOnly,
        ui: {
          verb: DESCRIPTIONS[name].label,
          ...(readOnly || name === GROUP_START_WORKTREE_TOOL
            ? {}
            : {
                primaryArgKey:
                  (
                    {
                      [GROUP_RECORD_DECISION_TOOL]: "text",
                      [GROUP_ASSIGN_TASK_TOOL]: "taskId",
                      [GROUP_PROPOSE_AGREEMENT_TOOL]: "summary",
                      [GROUP_AGREE_TOOL]: "note",
                      [GROUP_BLOCK_TOOL]: "reason",
                      [GROUP_HANDOFF_TOOL]: "memberId",
                    } as Partial<Record<GroupToolName, string>>
                  )[name] ?? "id",
              }),
        },
      },
      definition: defineGroupTool(name),
    });
  }
}

/** True for the member tools (filtered out of non-member sessions). */
export function isGroupToolName(name: string): boolean {
  return (GROUP_TOOL_NAMES as readonly string[]).includes(name);
}
