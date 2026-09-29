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
import { encodeGroupErrorMessage, isGroupErrorCode } from "../../../shared/group-errors";
import type { ToolProfileName } from "../../../shared/tools";
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
  reviewGroupTask,
} from "../../groups/group-store";
import { getWorkspace } from "../../workspace/workspace-store";
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

export const GROUP_TOOL_NAMES = [
  GROUP_READ_MESSAGES_TOOL,
  GROUP_LIST_TASKS_TOOL,
  GROUP_CREATE_TASK_TOOL,
  GROUP_CLAIM_TASK_TOOL,
  GROUP_RELEASE_TASK_TOOL,
  GROUP_REQUEST_REVIEW_TOOL,
  GROUP_REVIEW_TASK_TOOL,
  GROUP_START_WORKTREE_TOOL,
  GROUP_RECORD_DECISION_TOOL,
  GROUP_ASSIGN_TASK_TOOL,
] as const;

export type GroupToolName = (typeof GROUP_TOOL_NAMES)[number];
/** The tools runGroupTool runs synchronously (group_start_worktree runs git: startMemberWorktree). */
export type SyncGroupToolName = Exclude<GroupToolName, typeof GROUP_START_WORKTREE_TOOL>;

/** Page size cap for group_read_messages. */
export const GROUP_READ_MESSAGES_MAX_LIMIT = 50;
const GROUP_READ_MESSAGES_DEFAULT_LIMIT = 20;
/** Same estimated cap as one wake's group context (chars / 4, estimateGroupTokens). */
export const GROUP_READ_MESSAGES_MAX_TOKENS = ESTIMATED_CONTEXT_TOKENS_PER_WAKE;
const MAX_NOTE_CHARS = 500;

/* ── wake sink (set by the app wiring; the GroupRuntime routes the wake) ── */

let taskWakeSink: ((wake: GroupTaskWake) => void) | undefined;

/** Where review / changes wakes go (GroupRuntime.handleTaskWake in the app). */
export function setGroupTaskWakeSink(sink: ((wake: GroupTaskWake) => void) | undefined): void {
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

export type GroupToolCaller = { sessionId: string; groupId?: string | undefined };

type TaskStatusParam = GroupTaskStatus;

export type GroupToolParams = {
  group_read_messages: { before?: string; limit?: number };
  group_list_tasks: { status?: TaskStatusParam };
  group_create_task: { title: string; description?: string; reviewer?: string };
  group_claim_task: { id: string };
  group_release_task: { id: string };
  group_request_review: { id: string; reviewer: string };
  group_review_task: { id: string; verdict: "approve" | "changes"; note?: string };
  group_start_worktree: Record<string, never>;
  group_record_decision: { text: string };
  group_assign_task: { taskId: string; memberId: string; note?: string };
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

function formatTask(members: Roster, task: GroupTask): string {
  const parts = [
    `task ${task.id} [${task.status}] "${task.title}"`,
    `owner=${label(members, task.ownerSessionId)}`,
    `reviewer=${label(members, task.reviewerSessionId)}`,
  ];
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
    switch (name) {
      case "group_read_messages":
        return readMessages(groupId, members, params as GroupToolParams["group_read_messages"]);
      case "group_list_tasks": {
        const { status } = params as GroupToolParams["group_list_tasks"];
        const tasks = listGroupTasks(groupId, status ? { status } : {});
        return tasks.length > 0 ? tasks.map((t) => formatTask(members, t)).join("\n") : "No tasks.";
      }
      case "group_create_task": {
        const input = params as GroupToolParams["group_create_task"];
        const task = createMemberGroupTask({
          groupId,
          actorSessionId: actor,
          title: input.title,
          ...(input.description ? { description: input.description } : {}),
          ...(input.reviewer ? { reviewerSessionId: resolveMember(members, input.reviewer) } : {}),
        });
        return `Created ${formatTask(members, task)}`;
      }
      case "group_claim_task": {
        const { id } = params as GroupToolParams["group_claim_task"];
        const branch = memberWorktreeBranch(groupId, actor);
        const task = claimGroupTask(groupId, id, actor, branch ? { branch } : {});
        return `Claimed ${formatTask(members, task)}`;
      }
      case "group_release_task": {
        const { id } = params as GroupToolParams["group_release_task"];
        return `Released ${formatTask(members, releaseGroupTask(groupId, id, actor))}`;
      }
      case "group_request_review": {
        const input = params as GroupToolParams["group_request_review"];
        const reviewer = resolveMember(members, input.reviewer);
        const task = requestGroupTaskReview(groupId, input.id, actor, reviewer);
        taskWakeSink?.({
          groupId,
          actorSessionId: actor,
          targetSessionId: reviewer,
          body: `Review requested: "${task.title}" (task ${task.id}) ${label(members, reviewer)}`,
        });
        return `Review requested from ${label(members, reviewer)}: ${formatTask(members, task)}`;
      }
      case "group_review_task": {
        const input = params as GroupToolParams["group_review_task"];
        if (input.verdict !== "approve" && input.verdict !== "changes") {
          throw new ToolInputError("invalid-value", 'verdict must be "approve" or "changes".');
        }
        const task = reviewGroupTask(groupId, input.id, actor, input.verdict);
        const note = input.note?.trim().slice(0, MAX_NOTE_CHARS);
        if (input.verdict === "approve" && task.ownerSessionId) {
          // Recorded in the room for the owner, but wakes nobody.
          taskWakeSink?.({
            groupId,
            actorSessionId: actor,
            targetSessionId: task.ownerSessionId,
            body: note ? `Approved: ${note}` : "Approved",
            wake: false,
          });
        }
        if (input.verdict === "changes" && task.ownerSessionId) {
          taskWakeSink?.({
            groupId,
            actorSessionId: actor,
            targetSessionId: task.ownerSessionId,
            body: `Changes requested on "${task.title}" (task ${task.id}) ${label(
              members,
              task.ownerSessionId,
            )}${note ? `: ${note}` : ""}`,
          });
        }
        return `${input.verdict === "approve" ? "Approved" : "Changes requested"}: ${formatTask(
          members,
          task,
        )}`;
      }
      case "group_record_decision": {
        const { text } = params as GroupToolParams["group_record_decision"];
        const decision = recordGroupDecision({ groupId, text, authorSessionId: actor });
        // Recorded in the room as the member, but wakes nobody.
        taskWakeSink?.({
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
        const { task, previousOwnerSessionId } = assignGroupTask(
          groupId,
          input.taskId,
          actor,
          assignee,
          branch ? { branch } : {},
        );
        const note = input.note?.trim().slice(0, MAX_NOTE_CHARS);
        const subject = `"${task.title}" (task ${task.id})`;
        // A reassigned task keeps the old owner's branch (where the earlier work is).
        const body = previousOwnerSessionId
          ? `Reassigned: ${subject}: ${label(members, previousOwnerSessionId)} → ${label(members, assignee)}${
              task.branch ? ` (branch: \`${task.branch}\`)` : ""
            }`
          : `Assigned: ${subject} → ${label(members, assignee)}`;
        // Wakes the new owner (a hop); the Lead assigning itself only posts the line.
        taskWakeSink?.({
          groupId,
          actorSessionId: actor,
          targetSessionId: assignee,
          body: note ? `${body}: ${note}` : body,
          ...(assignee === actor ? { wake: false } : {}),
        });
        return `${previousOwnerSessionId ? "Reassigned" : "Assigned"} ${formatTask(members, task)}`;
      }
      default:
        throw new ToolInputError("invalid-value", `Unknown group tool ${String(name)}.`);
    }
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
  Type.Literal("in_review"),
  Type.Literal("done"),
  Type.Literal("cancelled"),
]);

const schemas = {
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
    { status: Type.Optional(statusParam) },
    { additionalProperties: false },
  ),
  group_create_task: Type.Object(
    {
      title: Type.String({ minLength: 1, maxLength: 200 }),
      description: Type.Optional(Type.String({ maxLength: 2_000 })),
      reviewer: Type.Optional(Type.String({ description: "Member title or session id." })),
    },
    { additionalProperties: false },
  ),
  group_claim_task: Type.Object({ id: idParam }, { additionalProperties: false }),
  group_release_task: Type.Object({ id: idParam }, { additionalProperties: false }),
  group_request_review: Type.Object(
    {
      id: idParam,
      reviewer: Type.String({ minLength: 1, description: "Another member's title or session id." }),
    },
    { additionalProperties: false },
  ),
  group_review_task: Type.Object(
    {
      id: idParam,
      verdict: Type.Union([Type.Literal("approve"), Type.Literal("changes")]),
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
      taskId: idParam,
      memberId: Type.String({ minLength: 1, description: "Member title or session id." }),
      note: Type.Optional(Type.String({ maxLength: MAX_NOTE_CHARS })),
    },
    { additionalProperties: false },
  ),
} satisfies Record<GroupToolName, unknown>;

const DESCRIPTIONS: Record<GroupToolName, { label: string; description: string; snippet: string }> =
  {
    group_read_messages: {
      label: "Read group messages",
      description:
        "Read the agent group's room, newest page first (oldest-first within the page). Paginate with before=<message id>. Capped at 50 messages and an estimated 8k tokens.",
      snippet: "group_read_messages(before?, limit?) — read earlier room messages.",
    },
    group_list_tasks: {
      label: "List group tasks",
      description: "List the group's tasks, optionally filtered by status.",
      snippet: "group_list_tasks(status?) — list the group's tasks.",
    },
    group_create_task: {
      label: "Create group task",
      description: "Create an open, unowned task for the group (optionally suggesting a reviewer).",
      snippet: "group_create_task(title, description?, reviewer?) — add an open task.",
    },
    group_claim_task: {
      label: "Claim group task",
      description:
        "Claim an open task nobody owns; you become its owner and it moves to in_progress.",
      snippet: "group_claim_task(id) — take an open task.",
    },
    group_release_task: {
      label: "Release group task",
      description:
        "Give back a task you own that is in_progress; it returns to open with no owner.",
      snippet: "group_release_task(id) — give back your task.",
    },
    group_request_review: {
      label: "Request task review",
      description:
        "Ask another member to review a task you own that is in_progress; it moves to in_review and the reviewer is woken.",
      snippet: "group_request_review(id, reviewer) — hand your task to a reviewer.",
    },
    group_review_task: {
      label: "Review group task",
      description:
        'Decide a task you were asked to review: "approve" marks it done; "changes" sends it back to in_progress and wakes the owner (include a note).',
      snippet: 'group_review_task(id, "approve"|"changes", note?) — review a task.',
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
        "group_assign_task(taskId, memberId, note?) — as coordinator, hand a task to a member.",
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
      const caller = { sessionId: context.sessionId, groupId: context.groupId };
      if (name === GROUP_START_WORKTREE_TOOL) {
        // `terminate`: PI stops after this tool batch (when every call in it asks to).
        const result = await startMemberWorktree(caller);
        return toResult(result.text, result.endTurn);
      }
      return toResult(runGroupTool(name, caller, params as never));
    },
  }) as ToolDefinition;
}

const READ_ONLY_TOOLS = new Set<GroupToolName>([GROUP_READ_MESSAGES_TOOL, GROUP_LIST_TASKS_TOOL]);

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
                  name === GROUP_RECORD_DECISION_TOOL
                    ? "text"
                    : name === GROUP_ASSIGN_TASK_TOOL
                      ? "taskId"
                      : "id",
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
