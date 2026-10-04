import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { agentAvatarForId } from "../../shared/agent-templates";
import type {
  AgentAvatarColor,
  AgentAvatarFace,
  AgentAvatarShape,
  AgentGroupInfo,
  AgentGroupMember,
  AgentGroupMode,
  AgentGroupWithMembers,
  GroupDecision,
  GroupMessage,
  GroupMessageAttachment,
  GroupMessageAuthorKind,
  GroupMessageContextItem,
  GroupMessageCursor,
  GroupMessageKind,
  GroupMessageStatus,
  GroupTaskStatus,
} from "../../shared/contracts";
import { allocateUniqueGroupAvatarShapes, CHATS_WORKSPACE_ID } from "../../shared/contracts";
import { groupCreateCountError, groupMemberCountError } from "../../shared/group-blocked";
import type { GroupErrorCode } from "../../shared/group-errors";
import { groupNeedsProject } from "../../shared/group-project";
import { getDatabase, uniqueAgentName } from "../db/database";
import { listGroupTasks, recordGroupTaskLegacyTransition } from "./group-task-store";

export type { GroupTaskReviewVerdict } from "./group-task-store";
export {
  assignGroupTask,
  bindGroupTaskRun,
  cancelGroupTask,
  claimGroupTask,
  completeGroupTaskForAgreement,
  createGroupTask,
  createMemberGroupTask,
  fillMemberTaskBranches,
  getGroupTaskRunBinding,
  listGroupTasks,
  listGroupTaskTransitions,
  recordGroupTaskEvidence,
  releaseGroupTask,
  reportGroupTaskProgress,
  requestGroupTaskReview,
  reviewGroupTask,
  updateGroupTask,
} from "./group-task-store";

/*
 * Agent Groups persistence. Plain function module in the style of
 * agent-store / workspace-store. Business rules that SQLite cannot express
 * (workspace matching, lead must be a member, authors/owners must be members)
 * are enforced here and surfaced as a typed `GroupStoreError`.
 */

/** Error codes (shared with the renderer, which maps them to readable messages). */
export type GroupStoreErrorCode = GroupErrorCode;

export class GroupStoreError extends Error {
  readonly code: GroupStoreErrorCode;

  constructor(code: GroupStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GroupStoreError";
    this.code = code;
  }
}

const GROUP_MODES: readonly AgentGroupMode[] = ["free", "coordinator"];
const AUTHOR_KINDS: readonly GroupMessageAuthorKind[] = ["user", "agent", "system"];
const MESSAGE_KINDS: readonly GroupMessageKind[] = ["message", "status"];
/** Status a task returns to when its owner leaves the group. */
const INITIAL_TASK_STATUS: GroupTaskStatus = "open";
/** Work-in-progress status; an in-review task falls back here when its reviewer leaves. */
const IN_PROGRESS_TASK_STATUS: GroupTaskStatus = "in_progress";
/** Awaiting-review status. */
const IN_REVIEW_TASK_STATUS: GroupTaskStatus = "in_review";
/** Terminal statuses: tasks here keep their owner/reviewer references as history. */
const CLOSED_TASK_STATUSES: readonly GroupTaskStatus[] = ["done", "cancelled"];
const DEFAULT_MESSAGE_PAGE = 50;
const MAX_MESSAGE_PAGE = 500;

type GroupRow = {
  id: string;
  name: string;
  workspace_id: string | null;
  mode: AgentGroupMode;
  lead_session_id: string | null;
  created_at: string;
  updated_at: string;
};

type MemberRow = {
  group_id: string;
  session_id: string;
  role: string | null;
  agent_id: string;
  joined_at: string;
  agent_name: string;
  agent_role: string;
  agent_archived_at: string | null;
  agent_avatar_face: AgentAvatarFace;
  agent_avatar_color: AgentAvatarColor;
  agent_avatar_shape: AgentAvatarShape;
};

type MessageRow = {
  id: string;
  group_id: string;
  author_kind: GroupMessageAuthorKind;
  author_session_id: string | null;
  reply_to_message_id: string | null;
  to_session_id: string | null;
  chain_id: string | null;
  kind: GroupMessageKind;
  body: string;
  mentions_json: string;
  attachments_json: string | null;
  context_items_json: string | null;
  created_at: string;
  turn_id: string | null;
  run_id: string | null;
  sdk_message_id: string | null;
  sequence: number;
  status: GroupMessageStatus | null;
  updated_at: string | null;
  error: string | null;
};

type DecisionRow = {
  id: string;
  group_id: string;
  text: string;
  author_session_id: string | null;
  source_message_id: string | null;
  execution_id: string | null;
  created_at: string;
};

const GROUP_COLUMNS = "id, name, workspace_id, mode, lead_session_id, created_at, updated_at";
/** Member rows joined with their agent (`from agent_group_members m join agents a`). */
const MEMBER_SELECT = `select m.group_id, m.session_id, m.role, m.agent_id, m.joined_at,
    a.name as agent_name, a.role as agent_role, a.archived_at as agent_archived_at,
    a.avatar_face as agent_avatar_face, a.avatar_color as agent_avatar_color,
    a.avatar_shape as agent_avatar_shape
  from agent_group_members m join agents a on a.id = m.agent_id`;
const MESSAGE_COLUMNS = `id, group_id, author_kind, author_session_id, reply_to_message_id,
  to_session_id, chain_id, kind, body, mentions_json, attachments_json, context_items_json, created_at,
  turn_id, run_id, sdk_message_id, sequence, status, updated_at, error`;
const DECISION_COLUMNS =
  "id, group_id, text, author_session_id, source_message_id, execution_id, created_at";

function toGroup(row: GroupRow): AgentGroupInfo {
  return {
    id: row.id,
    name: row.name,
    ...(row.workspace_id !== null ? { workspaceId: row.workspace_id } : {}),
    mode: row.mode,
    ...(row.lead_session_id !== null ? { leadSessionId: row.lead_session_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMember(row: MemberRow): AgentGroupMember {
  return {
    groupId: row.group_id,
    sessionId: row.session_id,
    ...(row.role !== null ? { role: row.role } : {}),
    agentId: row.agent_id,
    name: row.agent_name,
    agentRole: row.agent_role,
    ...(row.agent_archived_at !== null ? { archived: true as const } : {}),
    avatarFace: row.agent_avatar_face,
    avatarColor: row.agent_avatar_color,
    avatarShape: row.agent_avatar_shape,
    joinedAt: row.joined_at,
  };
}

function parseMentions(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseAttachmentsJson(text: string | null): GroupMessageAttachment[] | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const out: GroupMessageAttachment[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (
        row.type !== "image" ||
        typeof row.data !== "string" ||
        typeof row.mimeType !== "string"
      ) {
        continue;
      }
      out.push({
        type: "image",
        data: row.data,
        mimeType: row.mimeType,
        ...(typeof row.name === "string" ? { name: row.name } : {}),
      });
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function parseContextItemsJson(text: string | null): GroupMessageContextItem[] | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const out: GroupMessageContextItem[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if ((row.type === "file" || row.type === "folder") && typeof row.path === "string") {
        if (row.type === "folder") {
          out.push({ type: "folder", path: row.path });
        } else {
          out.push({ type: "file", path: row.path });
        }
      }
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function toMessage(row: MessageRow): GroupMessage {
  const attachments = parseAttachmentsJson(row.attachments_json);
  const contextItems = parseContextItemsJson(row.context_items_json);
  return {
    id: row.id,
    groupId: row.group_id,
    authorKind: row.author_kind,
    ...(row.author_session_id !== null ? { authorSessionId: row.author_session_id } : {}),
    ...(row.reply_to_message_id !== null ? { replyToMessageId: row.reply_to_message_id } : {}),
    ...(row.to_session_id !== null ? { toSessionId: row.to_session_id } : {}),
    ...(row.chain_id !== null ? { chainId: row.chain_id } : {}),
    kind: row.kind,
    body: row.body,
    mentions: parseMentions(row.mentions_json),
    ...(attachments ? { attachments } : {}),
    ...(contextItems ? { contextItems } : {}),
    createdAt: row.created_at,
    sequence: row.sequence,
    ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.sdk_message_id !== null ? { sdkMessageId: row.sdk_message_id } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
  };
}

function toDecision(row: DecisionRow): GroupDecision {
  return {
    id: row.id,
    groupId: row.group_id,
    text: row.text,
    ...(row.author_session_id !== null ? { authorSessionId: row.author_session_id } : {}),
    ...(row.source_message_id !== null ? { sourceMessageId: row.source_message_id } : {}),
    ...(row.execution_id !== null ? { executionId: row.execution_id } : {}),
    createdAt: row.created_at,
  };
}

/*
 * Live membership lines (A3): "X joined as <role>" / "X left the group" reach
 * the renderer through the same `group.message` broadcast as room messages.
 * Lines posted inside a transaction are held until it commits (a rollback
 * drops them), so the renderer never sees a line that was not saved.
 */
let membershipSink: ((message: GroupMessage) => void) | undefined;
let pendingMembershipMessages: GroupMessage[] | undefined;

/** Where committed membership lines go (the app wires the group event broadcast). */
export function setGroupMembershipMessageSink(
  sink: ((message: GroupMessage) => void) | undefined,
): void {
  membershipSink = sink;
}

function publishMembershipMessages(messages: readonly GroupMessage[]): void {
  for (const message of messages) {
    try {
      membershipSink?.(message);
    } catch (error) {
      console.warn("[modus] membership event broadcast failed:", error);
    }
  }
}

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("begin");
  pendingMembershipMessages = [];
  try {
    const result = fn();
    db.exec("commit");
    const committed = pendingMembershipMessages;
    pendingMembershipMessages = undefined;
    publishMembershipMessages(committed);
    return result;
  } catch (error) {
    pendingMembershipMessages = undefined;
    db.exec("rollback");
    throw error;
  }
}

function requireText(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new GroupStoreError("invalid-value", `Group ${field} must not be empty.`);
  }
  return trimmed;
}

function requireOneOf<T extends string>(value: T, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value)) {
    throw new GroupStoreError(
      "invalid-value",
      `Invalid ${field} "${String(value)}". Expected one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function requireGroupRow(groupId: string): GroupRow {
  const row = getDatabase()
    .prepare(`select ${GROUP_COLUMNS} from agent_groups where id = ?`)
    .get(groupId) as GroupRow | undefined;
  if (!row) {
    throw new GroupStoreError("group-not-found", `Agent group not found: ${groupId}`);
  }
  return row;
}

function isMember(groupId: string, sessionId: string): boolean {
  return (
    getDatabase()
      .prepare("select 1 from agent_group_members where group_id = ? and session_id = ?")
      .get(groupId, sessionId) !== undefined
  );
}

function requireMember(groupId: string, sessionId: string, field: string): void {
  if (!isMember(groupId, sessionId)) {
    throw new GroupStoreError(
      "not-a-member",
      `The ${field} session ${sessionId} is not a member of group ${groupId}.`,
    );
  }
}

/** Execution ids are message chain roots that already exist in the group. */
function requireExecutionInGroup(groupId: string, executionId: string): void {
  const row = getDatabase()
    .prepare("select group_id from group_messages where id = ?")
    .get(executionId) as { group_id: string } | undefined;
  if (!row || row.group_id !== groupId) {
    throw new GroupStoreError(
      "message-not-found",
      `Execution ${executionId} is not a message in group ${groupId}.`,
    );
  }
}

/**
 * Latest ask-spanning execution for Complementar: newest user message's chain.
 */
export function latestGroupExecutionId(groupId: string): string | undefined {
  const row = getDatabase()
    .prepare(
      `select coalesce(chain_id, id) as execution_id from group_messages
       where group_id = ? and author_kind = 'user'
       order by sequence desc, created_at desc, id desc
       limit 1`,
    )
    .get(groupId) as { execution_id: string } | undefined;
  return row?.execution_id;
}

function isUniqueMemberViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  // SQLITE_CONSTRAINT_PRIMARYKEY (1555) / SQLITE_CONSTRAINT_UNIQUE (2067).
  const constraint =
    errcode === 1555 || errcode === 2067 || /constraint failed/i.test(error.message);
  return constraint && error.message.includes("agent_group_members");
}

function touchGroup(groupId: string): string {
  const now = new Date().toISOString();
  getDatabase().prepare("update agent_groups set updated_at = ? where id = ?").run(now, groupId);
  return now;
}

/* ── Groups ────────────────────────────────────────────────────────────── */

type NewGroupInput = {
  id?: string;
  name: string;
  /** Owning Project. Omit (or pass the Chats inbox id) for a group with no Project. */
  workspaceId?: string | null;
  mode?: AgentGroupMode;
};

/*
 * Shared, NON-transactional helpers. They validate and write single rows so
 * both the one-step functions (createAgentGroup, addAgentGroupMember) and the
 * all-or-nothing createAgentGroupWithMembers use the exact same rules.
 * `inTransaction` is not nestable, so these helpers never open one.
 */

/** Validates a new group's fields and inserts its row (lead unset). Returns the group id. */
function insertGroupRow(input: NewGroupInput): { id: string; workspaceId: string | null } {
  const name = requireText(input.name, "name");
  const mode = requireOneOf(input.mode ?? "coordinator", GROUP_MODES, "group mode");
  const workspaceId =
    input.workspaceId && input.workspaceId !== CHATS_WORKSPACE_ID ? input.workspaceId : null;
  const db = getDatabase();
  if (
    workspaceId !== null &&
    db.prepare("select 1 from workspaces where id = ?").get(workspaceId) === undefined
  ) {
    throw new GroupStoreError("workspace-not-found", `Workspace not found: ${workspaceId}`);
  }
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `insert into agent_groups (id, name, workspace_id, mode, lead_session_id, created_at, updated_at)
     values (?, ?, ?, ?, null, ?, ?)`,
  ).run(id, name, workspaceId, mode, now, now);
  return { id, workspaceId };
}

/**
 * Throws unless the session may join a group owned by `groupWorkspaceId`
 * (null = no Project): it must exist, be top-level, not archived, and live in
 * the group's workspace (the Chats inbox for a group with no Project).
 */
function assertSessionCanJoin(
  groupId: string,
  groupWorkspaceId: string | null,
  sessionId: string,
): void {
  const session = getDatabase()
    .prepare(
      "select id, workspace_id, parent_session_id, archived_at from agent_sessions where id = ?",
    )
    .get(sessionId) as
    | {
        id: string;
        workspace_id: string;
        parent_session_id: string | null;
        archived_at: string | null;
      }
    | undefined;
  if (!session) {
    throw new GroupStoreError("session-not-found", `Agent session not found: ${sessionId}`);
  }
  if (session.parent_session_id !== null) {
    throw new GroupStoreError(
      "subagent-session",
      `Session ${sessionId} is a subagent session; only top-level sessions can join a group.`,
    );
  }
  if (session.archived_at !== null) {
    throw new GroupStoreError(
      "archived-session",
      `Session ${sessionId} is archived; unarchive it before adding it to a group.`,
    );
  }
  const expectedWorkspaceId = groupWorkspaceId ?? CHATS_WORKSPACE_ID;
  if (session.workspace_id !== expectedWorkspaceId) {
    throw new GroupStoreError(
      "workspace-mismatch",
      groupWorkspaceId === null
        ? `Session ${sessionId} belongs to a Project; a group without a Project only accepts chats without a folder.`
        : `Session ${sessionId} belongs to a different workspace than group ${groupId}.`,
    );
  }
}

/**
 * Inserts a member row, mapping the unique-session constraint to
 * `already-in-group`. Without `agentId` (an EXISTING session joins, the
 * pre-agents path kept for adoption and tests) the session becomes its own
 * agent, named after its title (deduped) like the migration. Either way the
 * session is marked 'group_member': it leaves the chat listings.
 */
function insertMemberRow(
  groupId: string,
  sessionId: string,
  role?: string,
  agentId?: string,
): AgentGroupMember {
  const db = getDatabase();
  const normalizedRole = role?.trim() ? role.trim() : null;
  const joinedAt = new Date().toISOString();
  try {
    db.prepare(
      `insert into agent_group_members (group_id, session_id, role, joined_at, agent_id)
       values (?, ?, ?, ?, ?)`,
    ).run(
      groupId,
      sessionId,
      normalizedRole,
      joinedAt,
      agentId ?? adoptSessionAgent(groupId, sessionId),
    );
  } catch (error) {
    if (isUniqueMemberViolation(error)) {
      throw new GroupStoreError(
        "already-in-group",
        agentId
          ? `Agent ${agentId} is already a member of group ${groupId}.`
          : `Session ${sessionId} is already a member of a group.`,
        { cause: error },
      );
    }
    throw error;
  }
  db.prepare("update agent_sessions set kind = 'group_member' where id = ?").run(sessionId);
  const row = db
    .prepare(`${MEMBER_SELECT} where m.group_id = ? and m.session_id = ?`)
    .get(groupId, sessionId) as MemberRow;
  return toMember(row);
}

/**
 * The agent of an existing session joining `groupId` (legacy/test path): a new
 * agent of that group, named after the session title (deduped in the group).
 */
function adoptSessionAgent(groupId: string, sessionId: string): string {
  const db = getDatabase();
  if (
    db.prepare("select 1 from agent_group_members where session_id = ?").get(sessionId) !==
    undefined
  ) {
    // Let the unique-session constraint report already-in-group (no agent is created).
    return "";
  }
  const title =
    (
      db.prepare("select title from agent_sessions where id = ?").get(sessionId) as
        | { title: string }
        | undefined
    )?.title?.trim() || "Agent";
  const id = randomUUID();
  const { avatarFace, avatarColor, avatarShape: preferredShape } = agentAvatarForId(id);
  const existing = db
    .prepare("select id, avatar_shape from agents where group_id = ? order by id")
    .all(groupId) as Array<{ id: string; avatar_shape: AgentAvatarShape }>;
  const assignments = allocateUniqueGroupAvatarShapes([
    ...existing.map((member) => ({ agentId: member.id, preferredShape: member.avatar_shape })),
    { agentId: id, preferredShape },
  ]);
  const avatarShape = assignments.get(id);
  if (!avatarShape)
    throw new GroupStoreError("invalid-value", "Could not allocate an agent avatar shape.");
  const now = new Date().toISOString();
  db.prepare(
    `insert into agents (id, group_id, name, avatar_face, avatar_color, avatar_shape, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    groupId,
    uniqueAgentName(db, title, groupId),
    avatarFace,
    avatarColor,
    avatarShape,
    now,
    now,
  );
  return id;
}

type AgentRef = {
  id: string;
  group_id: string | null;
  name: string;
  model_id: string | null;
  avatar_shape: AgentAvatarShape;
};

function requireAgentRef(agentId: string): AgentRef {
  const row = getDatabase()
    .prepare("select id, group_id, name, model_id, avatar_shape from agents where id = ?")
    .get(agentId) as AgentRef | undefined;
  if (!row) throw new GroupStoreError("agent-not-found", `Agent not found: ${agentId}`);
  return row;
}

/** Throws `group-project-required` unless `workspaceId` is a real, existing Project. */
function requireGroupProject(workspaceId: string | null | undefined): { id: string; root: string } {
  if (groupNeedsProject({ workspaceId })) {
    throw new GroupStoreError("group-project-required", "A group needs a Project (folder).");
  }
  const row = getDatabase()
    .prepare("select id, root_path from workspaces where id = ?")
    .get(workspaceId ?? "") as { id: string; root_path: string } | undefined;
  if (!row) {
    throw new GroupStoreError("workspace-not-found", `Workspace not found: ${workspaceId}`);
  }
  return { id: row.id, root: row.root_path };
}

/** Room lines for membership changes (a status line: shown and read, never a wake). */
export const GROUP_MEMBERSHIP_TEXT = {
  joined: (member: { name: string; role?: string; agentRole?: string }) =>
    `${member.name} joined as ${member.role?.trim() || member.agentRole?.trim() || "member"}`,
  left: (name: string) => `${name} left the group`,
} as const;

/** Every member row, archived agents included (they count toward 2..10). */
function countGroupMembers(groupId: string): number {
  const row = getDatabase()
    .prepare("select count(*) as count from agent_group_members where group_id = ?")
    .get(groupId) as { count: number };
  return Number(row.count);
}

/** The shared 2..10 rule (groupMemberCountError) as a store error. */
function requireMemberCount(current: number, next: number): void {
  throwCountError(groupMemberCountError(current, next));
}

/** The shared create rule (groupCreateCountError) as a store error. */
function requireCreateCount(count: number): void {
  throwCountError(groupCreateCountError(count));
}

/** A 2..10 rule result (shared/group-blocked) as a store error; null passes. */
export function throwCountError(code: "group-min-members" | "group-max-members" | null): void {
  if (code === "group-min-members") {
    throw new GroupStoreError(code, "A group needs at least 2 agents.");
  }
  if (code === "group-max-members") {
    throw new GroupStoreError(code, "A group can have at most 10 agents.");
  }
}

/**
 * Appends a membership status line (the caller owns the transaction); it is
 * broadcast live once the transaction commits.
 */
export function postMembershipEvent(groupId: string, body: string): void {
  const message = appendGroupMessage({ groupId, authorKind: "system", kind: "status", body });
  if (pendingMembershipMessages) pendingMembershipMessages.push(message);
  else publishMembershipMessages([message]);
}

/** The 1:1 chat session ids of these agents (A3; kind 'chat', linked by agent_id). */
export function agentChatSessionIds(agentIds: readonly string[]): string[] {
  const select = getDatabase().prepare(
    "select id from agent_sessions where agent_id = ? and kind = 'chat'",
  );
  return agentIds.flatMap((agentId) =>
    (select.all(agentId) as Array<{ id: string }>).map((row) => row.id),
  );
}

/**
 * The agent's 1:1 chat (A3): a normal `kind='chat'` session in its group's
 * Project (cwd = the Project root), linked by `agent_id` and made on first
 * open. The existing one is returned as is. A group without a Project cannot
 * make one (`group-project-required`); its agents are still listed.
 */
export function openAgentChatRow(agentId: string): string {
  const db = getDatabase();
  const existing = db
    .prepare("select id from agent_sessions where agent_id = ? and kind = 'chat'")
    .get(agentId) as { id: string } | undefined;
  if (existing) return existing.id;
  const agent = requireAgentRef(agentId);
  if (agent.group_id === null) {
    throw new GroupStoreError("not-a-member", `Agent ${agentId} has no group.`);
  }
  const project = requireGroupProject(requireGroupRow(agent.group_id).workspace_id);
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `insert into agent_sessions
       (id, workspace_id, title, cwd, status, runtime, model, kind, agent_id, created_at, updated_at)
     values (?, ?, ?, ?, 'idle', 'pi-sdk', ?, 'chat', ?, ?, ?)`,
  ).run(sessionId, project.id, agent.name, project.root, agent.model_id, agentId, now, now);
  return sessionId;
}

/**
 * NON-transactional: the agent's hidden room session (kind 'group_member', in
 * the group's Project, cwd = its root, the agent's model) and its member row.
 * The persona is not copied: it enters each turn's prompt from the agent.
 */
function insertAgentMember(
  groupId: string,
  project: { id: string; root: string },
  agentId: string,
  role?: string,
): AgentGroupMember {
  const agent = requireAgentRef(agentId);
  // One group per agent (A2): it joins its own group, or an ungrouped legacy agent adopts this one.
  if (
    (agent.group_id !== null && agent.group_id !== groupId) ||
    getDatabase().prepare("select 1 from agent_group_members where agent_id = ?").get(agentId) !==
      undefined
  ) {
    throw new GroupStoreError("already-in-group", `Agent ${agentId} already belongs to a group.`);
  }
  if (agent.group_id === null) {
    const db = getDatabase();
    const existing = db
      .prepare("select id, avatar_shape from agents where group_id = ? order by id")
      .all(groupId) as Array<{ id: string; avatar_shape: AgentAvatarShape }>;
    const assignments = allocateUniqueGroupAvatarShapes([
      ...existing.map((member) => ({ agentId: member.id, preferredShape: member.avatar_shape })),
      { agentId, preferredShape: agent.avatar_shape },
    ]);
    const avatarShape = assignments.get(agentId);
    if (!avatarShape)
      throw new GroupStoreError("invalid-value", "Could not allocate an agent avatar shape.");
    db.prepare("update agents set group_id = ?, avatar_shape = ? where id = ?").run(
      groupId,
      avatarShape,
      agentId,
    );
  }
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into agent_sessions
         (id, workspace_id, title, cwd, status, runtime, model, kind, created_at, updated_at)
       values (?, ?, ?, ?, 'idle', 'pi-sdk', ?, 'group_member', ?, ?)`,
    )
    .run(sessionId, project.id, agent.name, project.root, agent.model_id, now, now);
  return insertMemberRow(groupId, sessionId, role, agentId);
}

function normalizeGroupAvatarShapes(groupId: string): void {
  const db = getDatabase();
  const rows = db
    .prepare(
      `select a.id, a.avatar_shape from agents a
       left join agent_group_members m on m.agent_id = a.id
       where a.group_id = ?
       order by case when m.agent_id is null then 1 else 0 end, m.joined_at, m.rowid, a.id`,
    )
    .all(groupId) as Array<{ id: string; avatar_shape: AgentAvatarShape }>;
  if (rows.length > 10) return;
  const assignments = allocateUniqueGroupAvatarShapes(
    rows.map(({ id, avatar_shape }) => ({ agentId: id, preferredShape: avatar_shape })),
  );
  const update = db.prepare("update agents set avatar_shape = ? where id = ?");
  for (const row of rows) {
    const shape = assignments.get(row.id);
    if (shape && shape !== row.avatar_shape) update.run(shape, row.id);
  }
}

export function createAgentGroup(input: NewGroupInput): AgentGroupInfo {
  return toGroup(requireGroupRow(insertGroupRow(input).id));
}

/**
 * Creates a group, its members and (optionally) its lead in ONE transaction:
 * all or nothing. Any refused member (wrong workspace, already in a group,
 * subagent, archived, missing) or a lead that is not among `members` rolls
 * everything back, so no group, member or lead row is left behind. The same
 * 2..10 rule as `group:create` (groupCreateCountError) applies.
 */
export function createAgentGroupWithMembers(
  input: NewGroupInput & {
    members: Array<{ sessionId: string; role?: string }>;
    leadSessionId?: string | null;
  },
): AgentGroupWithMembers {
  const sessionIds = input.members.map((member) => member.sessionId);
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new GroupStoreError("invalid-value", "Each session can be listed only once.");
  }
  const leadSessionId = input.leadSessionId ?? null;
  if (leadSessionId !== null && !sessionIds.includes(leadSessionId)) {
    throw new GroupStoreError(
      "not-a-member",
      `The lead session ${leadSessionId} must be one of the group's members.`,
    );
  }
  requireCreateCount(sessionIds.length);
  const db = getDatabase();
  const groupId = inTransaction(db, () => {
    const { id, workspaceId } = insertGroupRow(input);
    for (const member of input.members) {
      assertSessionCanJoin(id, workspaceId, member.sessionId);
      insertMemberRow(id, member.sessionId, member.role);
    }
    if (leadSessionId !== null) {
      db.prepare("update agent_groups set lead_session_id = ? where id = ?").run(leadSessionId, id);
    }
    return id;
  });
  return {
    ...toGroup(requireGroupRow(groupId)),
    members: listAgentGroupMembers(groupId),
  };
}

/** The store's transaction for callers composing several row helpers (agents-store). */
export function withGroupTransaction<T>(fn: () => T): T {
  return inTransaction(getDatabase(), fn);
}

/** The group with its members; `group-not-found` when missing. */
export function getAgentGroupWithMembers(groupId: string): AgentGroupWithMembers {
  return { ...toGroup(requireGroupRow(groupId)), members: listAgentGroupMembers(groupId) };
}

/**
 * NON-transactional: the 2..10 rule for `memberCount` new members, the
 * Project (required), then the group row. Returns the group id.
 */
export function insertGroupWithProject(
  input: { name: string; workspaceId: string | null | undefined; mode?: AgentGroupMode },
  memberCount: number,
): string {
  requireCreateCount(memberCount);
  const project = requireGroupProject(input.workspaceId);
  return insertGroupRow({
    name: input.name,
    workspaceId: project.id,
    ...(input.mode ? { mode: input.mode } : {}),
  }).id;
}

/** NON-transactional: sets the lead session. */
export function setGroupLeadRow(groupId: string, sessionId: string | null): void {
  getDatabase()
    .prepare("update agent_groups set lead_session_id = ? where id = ?")
    .run(sessionId, groupId);
}

/**
 * Creates a group in a Project (required) with EXISTING ungrouped agents
 * (legacy / tests; the app creates new agents with createGroupWithNewAgents),
 * one hidden room session each, in ONE transaction.
 */
export function createAgentGroupWithAgents(input: {
  name: string;
  workspaceId: string | null | undefined;
  mode?: AgentGroupMode;
  members: Array<{ agentId: string; role?: string }>;
  leadAgentId?: string | null;
}): AgentGroupWithMembers {
  const agentIds = input.members.map((member) => member.agentId);
  if (new Set(agentIds).size !== agentIds.length) {
    throw new GroupStoreError("invalid-value", "Each agent can be listed only once.");
  }
  const leadAgentId = input.leadAgentId ?? null;
  if (leadAgentId !== null && !agentIds.includes(leadAgentId)) {
    throw new GroupStoreError("not-a-member", `The lead agent ${leadAgentId} must be a member.`);
  }
  return withGroupTransaction(() => {
    const id = insertGroupWithProject(input, agentIds.length);
    for (const member of input.members) {
      const row = joinGroupRows(id, member.agentId, member.role, { event: false, cap: false });
      if (member.agentId === leadAgentId) setGroupLeadRow(id, row.sessionId);
    }
    return getAgentGroupWithMembers(id);
  });
}

/**
 * NON-transactional core of joining: the 10-member cap (archived agents count),
 * the group's Project, the agent's room session and member row, and a
 * "X joined as <role>" line. A group blocked with 1 member may be joined.
 */
export function joinGroupRows(
  groupId: string,
  agentId: string,
  role?: string,
  options: { event?: boolean; cap?: boolean } = {},
): AgentGroupMember {
  const group = requireGroupRow(groupId);
  if (options.cap !== false) {
    const count = countGroupMembers(groupId);
    requireMemberCount(count, count + 1);
  }
  const member = insertAgentMember(groupId, requireGroupProject(group.workspace_id), agentId, role);
  if (options.event !== false) postMembershipEvent(groupId, GROUP_MEMBERSHIP_TEXT.joined(member));
  touchGroup(groupId);
  return member;
}

/** Adds an ungrouped agent (legacy) to a group; the app adds agents with createAgentInGroup. */
export function addAgentToGroup(input: {
  groupId: string;
  agentId: string;
  role?: string;
}): AgentGroupMember {
  return withGroupTransaction(() => joinGroupRows(input.groupId, input.agentId, input.role));
}

/**
 * NON-transactional: removing a member IS deleting its agent (one group per
 * agent). Refused with `group-min-members` when only 2 are left (unless
 * `checkMinimum` is false: update-members checks the target count once);
 * then the member-removal rules, the agent row and "X left the group". The
 * room session and the agent's 1:1 chat (A3) are NOT deleted here: they stay
 * (hidden / unlinked) so that, after the commit, the caller tears each tree
 * down with its subagents, runtimes and checkpoints (deleteAgentSessionTree,
 * see agents/agent-teardown). Returns those session ids (room session first,
 * then the 1:1 chat; [] when the session was not a member).
 */
export function removeAgentFromGroupRows(
  groupId: string,
  sessionId: string,
  checkMinimum = true,
): string[] {
  const member = listAgentGroupMembers(groupId).find((row) => row.sessionId === sessionId);
  if (!member) return [];
  if (checkMinimum) {
    const count = countGroupMembers(groupId);
    requireMemberCount(count, count - 1);
  }
  const chatIds = agentChatSessionIds([member.agentId]);
  detachMemberRows(groupId, sessionId);
  // agent_sessions.agent_id is ON DELETE SET NULL: the 1:1 chat is unlinked.
  getDatabase().prepare("delete from agents where id = ?").run(member.agentId);
  normalizeGroupAvatarShapes(groupId);
  postMembershipEvent(groupId, GROUP_MEMBERSHIP_TEXT.left(member.name));
  touchGroup(groupId);
  return [sessionId, ...chatIds];
}

/**
 * removeAgentFromGroupRows in its own transaction (IPC `group:remove-member`).
 * Returns the removed session ids (room session and 1:1 chat).
 */
export function removeAgentFromGroup(groupId: string, sessionId: string): string[] {
  requireGroupRow(groupId);
  return withGroupTransaction(() => removeAgentFromGroupRows(groupId, sessionId));
}

/**
 * Moves a group to another Project (never to none: `group-project-required`),
 * in ONE transaction with its hidden room sessions: they follow it (workspace
 * and cwd = the new root). Member worktrees belong to the old Project, so the
 * sessions forget them first (the branches stay on disk).
 */
export function setAgentGroupWorkspace(
  groupId: string,
  workspaceId: string | null,
): AgentGroupInfo {
  requireGroupRow(groupId);
  const db = getDatabase();
  inTransaction(db, () => {
    const project = requireGroupProject(workspaceId);
    restoreMemberWorktreeCwdRows(groupId);
    db.prepare(
      `update agent_sessions set workspace_id = ?, cwd = ?
       where kind = 'group_member'
         and id in (select session_id from agent_group_members where group_id = ?)`,
    ).run(project.id, project.root, groupId);
    // The agents' 1:1 chats (A3) live in the group's Project too.
    db.prepare(
      `update agent_sessions set workspace_id = ?, cwd = ?
       where kind = 'chat' and agent_id in (select id from agents where group_id = ?)`,
    ).run(project.id, project.root, groupId);
    db.prepare("update agent_groups set workspace_id = ?, updated_at = ? where id = ?").run(
      project.id,
      new Date().toISOString(),
      groupId,
    );
  });
  return toGroup(requireGroupRow(groupId));
}

/** Hidden room sessions of the groups in a Project ("Remove project" tears them down). */
export function listWorkspaceGroupMemberSessionIds(workspaceId: string): string[] {
  const rows = getDatabase()
    .prepare(
      `select m.session_id from agent_group_members m
       join agent_groups g on g.id = m.group_id
       where g.workspace_id = ? order by m.rowid`,
    )
    .all(workspaceId) as Array<{ session_id: string }>;
  return rows.map((row) => row.session_id);
}

export function getAgentGroup(groupId: string): AgentGroupInfo | undefined {
  const row = getDatabase()
    .prepare(`select ${GROUP_COLUMNS} from agent_groups where id = ?`)
    .get(groupId) as GroupRow | undefined;
  return row ? toGroup(row) : undefined;
}

/**
 * Lists groups, most recently updated first. `workspaceId: null` (or the Chats
 * inbox id) returns only groups without a Project; omit it to list all groups.
 */
export function listAgentGroups(options: { workspaceId?: string | null } = {}): AgentGroupInfo[] {
  const db = getDatabase();
  let rows: GroupRow[];
  if (options.workspaceId === undefined) {
    rows = db
      .prepare(`select ${GROUP_COLUMNS} from agent_groups order by updated_at desc, rowid desc`)
      .all() as GroupRow[];
  } else if (options.workspaceId === null || options.workspaceId === CHATS_WORKSPACE_ID) {
    rows = db
      .prepare(
        `select ${GROUP_COLUMNS} from agent_groups where workspace_id is null
         order by updated_at desc, rowid desc`,
      )
      .all() as GroupRow[];
  } else {
    rows = db
      .prepare(
        `select ${GROUP_COLUMNS} from agent_groups where workspace_id = ?
         order by updated_at desc, rowid desc`,
      )
      .all(options.workspaceId) as GroupRow[];
  }
  return rows.map(toGroup);
}

export function renameAgentGroup(groupId: string, name: string): AgentGroupInfo {
  const trimmed = requireText(name, "name");
  requireGroupRow(groupId);
  getDatabase()
    .prepare("update agent_groups set name = ?, updated_at = ? where id = ?")
    .run(trimmed, new Date().toISOString(), groupId);
  return toGroup(requireGroupRow(groupId));
}

export function setAgentGroupMode(groupId: string, mode: AgentGroupMode): AgentGroupInfo {
  requireOneOf(mode, GROUP_MODES, "group mode");
  requireGroupRow(groupId);
  getDatabase()
    .prepare("update agent_groups set mode = ?, updated_at = ? where id = ?")
    .run(mode, new Date().toISOString(), groupId);
  return toGroup(requireGroupRow(groupId));
}

/** Sets (or clears, with null) the group lead. The lead must be a member. */
export function setAgentGroupLead(groupId: string, sessionId: string | null): AgentGroupInfo {
  requireGroupRow(groupId);
  if (sessionId !== null) {
    requireMember(groupId, sessionId, "lead");
  }
  getDatabase()
    .prepare("update agent_groups set lead_session_id = ?, updated_at = ? where id = ?")
    .run(sessionId, new Date().toISOString(), groupId);
  return toGroup(requireGroupRow(groupId));
}

/**
 * Deletes the group and (via cascade) its agents (one group per agent),
 * members, messages, tasks and decisions, in one transaction. The members'
 * hidden room sessions and the agents' 1:1 chats (A3) stay until the caller
 * tears each tree down after the commit (agents/agent-teardown), with the
 * records still there for subagents and checkpoints. Returns those ids.
 */
export function deleteAgentGroup(groupId: string): string[] {
  const db = getDatabase();
  return inTransaction(db, () => {
    const members = listAgentGroupMembers(groupId);
    const sessionIds = members.map((member) => member.sessionId);
    const chatIds = agentChatSessionIds(members.map((member) => member.agentId));
    restoreMemberWorktreeCwdRows(groupId);
    // Cascades: its agents (agents.group_id), members, messages, tasks, decisions;
    // the 1:1 chats are unlinked (agent_id set null), not deleted.
    db.prepare("delete from agent_groups where id = ?").run(groupId);
    return [...sessionIds, ...chatIds];
  });
}

/** Branch prefix of every member worktree of `groupId` (`group/<groupId>/<memberSlug>`). */
export function memberWorktreeBranchPrefix(groupId: string): string {
  return `group/${groupId}/`;
}

/**
 * NON-transactional: a member leaving (or the group going away) keeps its
 * worktree and branch on disk; only the session forgets it and its `cwd`
 * goes back to the Project root. Scoped to `sessionId` when given, else to
 * every member of the group. Sessions whose worktree is not this group's
 * (e.g. subagent worktrees) are untouched.
 */
function restoreMemberWorktreeCwdRows(groupId: string, sessionId?: string): void {
  const prefix = memberWorktreeBranchPrefix(groupId);
  const scope =
    sessionId === undefined
      ? "id in (select session_id from agent_group_members where group_id = :groupId)"
      : "id = :sessionId";
  getDatabase()
    .prepare(
      `update agent_sessions
       set cwd = coalesce(
             (select w.root_path from workspaces w where w.id = agent_sessions.workspace_id),
             cwd
           ),
           subagent_worktree_path = null,
           subagent_worktree_branch = null,
           subagent_worktree_base_sha = null,
           subagent_integration_status = null,
           subagent_changed_files_json = null,
           subagent_conflict_files_json = null
       where substr(subagent_worktree_branch, 1, length(:prefix)) = :prefix and ${scope}`,
    )
    .run({ prefix, ...(sessionId === undefined ? { groupId } : { sessionId }) });
}

/* ── Members ───────────────────────────────────────────────────────────── */

export function addAgentGroupMember(input: {
  groupId: string;
  sessionId: string;
  role?: string;
}): AgentGroupMember {
  const group = requireGroupRow(input.groupId);
  assertSessionCanJoin(group.id, group.workspace_id, input.sessionId);
  const member = insertMemberRow(group.id, input.sessionId, input.role);
  touchGroup(group.id);
  return member;
}

/**
 * Removes a member, atomically (one transaction):
 * - clears the group lead when the removed member was the lead;
 * - detaches them from the group's non-closed tasks (closed = done/cancelled,
 *   which keep their references as history), in ONE update so nothing
 *   applies twice:
 *   - OWNER (whether or not also reviewer) — takes precedence: owner cleared,
 *     reviewer cleared too if it is the same session, status -> 'open'.
 *   - ONLY reviewer (owner is someone else or NULL): reviewer cleared; status
 *     unchanged, except 'in_review' falls back to 'in_progress'.
 *
 * Reading convention: a non-closed task whose owner is NULL counts as 'open',
 * whatever its stored status (this is how PR 3 will read tasks). Deleting a
 * session sets owner/reviewer to NULL through the foreign keys WITHOUT
 * resetting the status; that is intentional and there is deliberately no
 * trigger for it.
 */
export function removeAgentGroupMember(groupId: string, sessionId: string): void {
  const db = getDatabase();
  inTransaction(db, () => {
    detachMemberRows(groupId, sessionId);
  });
}

/**
 * NON-transactional core of member removal (the caller owns the transaction):
 * deletes the member row, clears the lead if it was them, and releases their
 * non-closed tasks with the owner-first rules documented on
 * removeAgentGroupMember. Returns false when the session was not a member.
 */
function detachMemberRows(groupId: string, sessionId: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare("delete from agent_group_members where group_id = ? and session_id = ?")
    .run(groupId, sessionId);
  if (Number(result.changes) === 0) {
    return false;
  }
  restoreMemberWorktreeCwdRows(groupId, sessionId);
  db.prepare(
    `update agent_groups set lead_session_id = null
     where id = ? and lead_session_id = ?`,
  ).run(groupId, sessionId);
  const closedParams = Object.fromEntries(
    CLOSED_TASK_STATUSES.map((status, index) => [`closed${index}`, status]),
  );
  const closed = Object.keys(closedParams)
    .map((name) => `:${name}`)
    .join(", ");
  const affectedTasks = listGroupTasks(groupId).filter(
    (task) =>
      !CLOSED_TASK_STATUSES.includes(task.status) &&
      (task.ownerSessionId === sessionId || task.reviewerSessionId === sessionId),
  );
  // SQLite evaluates every SET expression against the OLD row, so the
  // owner check in the status CASE sees the owner before it is cleared.
  db.prepare(
    `update group_tasks
     set status = case
           when owner_session_id = :session then :initialStatus
           when reviewer_session_id = :session and status = :inReview then :inProgress
           else status
         end,
         owner_session_id = case
           when owner_session_id = :session then null
           else owner_session_id
         end,
         reviewer_session_id = case
           when reviewer_session_id = :session then null
           else reviewer_session_id
         end,
         updated_at = :now
     where group_id = :groupId
       and status not in (${closed})
       and (owner_session_id = :session or reviewer_session_id = :session)`,
  ).run({
    session: sessionId,
    initialStatus: INITIAL_TASK_STATUS,
    inReview: IN_REVIEW_TASK_STATUS,
    inProgress: IN_PROGRESS_TASK_STATUS,
    now: new Date().toISOString(),
    groupId,
    ...closedParams,
  });
  for (const task of affectedTasks)
    recordGroupTaskLegacyTransition(task, "member_removed", sessionId);
  touchGroup(groupId);
  return true;
}

/**
 * Removes `sessionId` from whatever group it belongs to, via the same path as
 * removeAgentGroupMember (lead cleared, open tasks released owner-first).
 * NON-transactional: meant to run inside the caller's transaction (e.g. the
 * archive update in agent-store) so both commit or roll back together.
 * Returns the group id it left, if any.
 */
export function detachSessionFromGroupRows(sessionId: string): string | undefined {
  const row = getDatabase()
    .prepare("select group_id from agent_group_members where session_id = ?")
    .get(sessionId) as { group_id: string } | undefined;
  if (!row) return undefined;
  detachMemberRows(row.group_id, sessionId);
  return row.group_id;
}

/**
 * Replaces a group's membership and lead in ONE transaction (all or nothing),
 * given the target member list: sessions no longer listed are removed exactly
 * like removeAgentGroupMember; new ones must pass the same join rules as
 * addAgentGroupMember; existing members keep their role and joined_at. The
 * lead must be one of the target members (or null). Zero members is allowed.
 */
export function updateAgentGroupMembers(
  groupId: string,
  input: { members: Array<{ sessionId: string; role?: string }>; leadSessionId: string | null },
): AgentGroupWithMembers {
  const group = requireGroupRow(groupId);
  const targetIds = input.members.map((member) => member.sessionId);
  if (new Set(targetIds).size !== targetIds.length) {
    throw new GroupStoreError("invalid-value", "Each session can be listed only once.");
  }
  if (input.leadSessionId !== null && !targetIds.includes(input.leadSessionId)) {
    throw new GroupStoreError(
      "not-a-member",
      `The lead session ${input.leadSessionId} must be one of the group's members.`,
    );
  }
  const db = getDatabase();
  inTransaction(db, () => {
    const currentIds = new Set(listAgentGroupMembers(groupId).map((member) => member.sessionId));
    for (const sessionId of currentIds) {
      if (!targetIds.includes(sessionId)) detachMemberRows(groupId, sessionId);
    }
    for (const member of input.members) {
      if (currentIds.has(member.sessionId)) continue;
      assertSessionCanJoin(groupId, group.workspace_id, member.sessionId);
      insertMemberRow(groupId, member.sessionId, member.role);
    }
    db.prepare("update agent_groups set lead_session_id = ? where id = ?").run(
      input.leadSessionId,
      groupId,
    );
    touchGroup(groupId);
  });
  return { ...toGroup(requireGroupRow(groupId)), members: listAgentGroupMembers(groupId) };
}

export function listAgentGroupMembers(groupId: string): AgentGroupMember[] {
  const rows = getDatabase()
    .prepare(
      `${MEMBER_SELECT} where m.group_id = ?
       order by m.joined_at, m.rowid`,
    )
    .all(groupId) as MemberRow[];
  return rows.map(toMember);
}

/** Groups (same filter/order as listAgentGroups) with their members, for the sidebar. */
export function listAgentGroupsWithMembers(
  options: { workspaceId?: string | null } = {},
): AgentGroupWithMembers[] {
  const groups = listAgentGroups(options);
  if (groups.length === 0) return [];
  const rows = getDatabase()
    .prepare(`${MEMBER_SELECT} order by m.joined_at, m.rowid`)
    .all() as MemberRow[];
  const byGroup = new Map<string, AgentGroupMember[]>();
  for (const row of rows) {
    const members = byGroup.get(row.group_id) ?? [];
    members.push(toMember(row));
    byGroup.set(row.group_id, members);
  }
  return groups.map((group) => ({ ...group, members: byGroup.get(group.id) ?? [] }));
}

export function getAgentGroupForSession(sessionId: string): AgentGroupInfo | undefined {
  const row = getDatabase()
    .prepare(
      `select g.id, g.name, g.workspace_id, g.mode, g.lead_session_id, g.created_at, g.updated_at
       from agent_groups g
       join agent_group_members m on m.group_id = g.id
       where m.session_id = ?`,
    )
    .get(sessionId) as GroupRow | undefined;
  return row ? toGroup(row) : undefined;
}

/** Every session id that belongs to any group (the sidebar hides these from other sections). */
export function listAgentGroupMemberSessionIds(): string[] {
  const rows = getDatabase()
    .prepare("select session_id from agent_group_members order by rowid")
    .all() as Array<{ session_id: string }>;
  return rows.map((row) => row.session_id);
}

/* ── Messages ──────────────────────────────────────────────────────────── */

export function appendGroupMessage(input: {
  id?: string;
  groupId: string;
  authorKind: GroupMessageAuthorKind;
  /** Required for agent authors; must be omitted for user/system authors. */
  authorSessionId?: string;
  replyToMessageId?: string;
  toSessionId?: string;
  /**
   * The user message that opened the chain. Defaults to the reply target's
   * chain, or to the message itself for a new user message.
   */
  chainId?: string;
  /** Open a new chain rooted at this message (chainId = its own id); excludes `chainId`. */
  startsChain?: boolean;
  kind?: GroupMessageKind;
  body: string;
  mentions?: string[];
  attachments?: GroupMessageAttachment[];
  contextItems?: GroupMessageContextItem[];
  createdAt?: string;
  turnId?: string;
  runId?: string;
  sdkMessageId?: string;
  status?: GroupMessageStatus;
  error?: string;
}): GroupMessage {
  const db = getDatabase();
  requireGroupRow(input.groupId);
  const authorKind = requireOneOf(input.authorKind, AUTHOR_KINDS, "message author kind");
  const kind = requireOneOf(input.kind ?? "message", MESSAGE_KINDS, "message kind");
  const attachments = input.attachments?.slice(0, 6) ?? [];
  const contextItems = input.contextItems?.slice(0, 20) ?? [];
  const hasPayload = attachments.length > 0 || contextItems.length > 0;
  const executionCard = authorKind === "agent" && input.turnId && input.status;
  if (
    typeof input.body !== "string" ||
    (input.body.trim() === "" && !hasPayload && !executionCard)
  ) {
    throw new GroupStoreError("invalid-value", "Group message body must not be empty.");
  }
  if (authorKind === "agent") {
    if (!input.authorSessionId) {
      throw new GroupStoreError("invalid-value", "Agent messages need an author session id.");
    }
    requireMember(input.groupId, input.authorSessionId, "author");
  } else if (input.authorSessionId) {
    throw new GroupStoreError(
      "invalid-value",
      `A ${authorKind} message cannot have an author session id.`,
    );
  }
  if (input.toSessionId) {
    requireMember(input.groupId, input.toSessionId, "recipient");
  }
  const mentions = [...new Set(input.mentions ?? [])];
  for (const mention of mentions) {
    requireMember(input.groupId, mention, "mentioned");
  }

  let replyChainId: string | null = null;
  if (input.replyToMessageId) {
    const parent = db
      .prepare("select group_id, chain_id from group_messages where id = ?")
      .get(input.replyToMessageId) as { group_id: string; chain_id: string | null } | undefined;
    if (!parent || parent.group_id !== input.groupId) {
      throw new GroupStoreError(
        "message-not-found",
        `Reply target ${input.replyToMessageId} is not a message in group ${input.groupId}.`,
      );
    }
    replyChainId = parent.chain_id;
  }
  if (input.chainId) {
    const chain = db
      .prepare("select group_id from group_messages where id = ?")
      .get(input.chainId) as { group_id: string } | undefined;
    if (!chain || chain.group_id !== input.groupId) {
      throw new GroupStoreError(
        "message-not-found",
        `Chain ${input.chainId} is not a message in group ${input.groupId}.`,
      );
    }
  }

  if (input.startsChain && input.chainId) {
    throw new GroupStoreError("invalid-value", "A message cannot both start and join a chain.");
  }
  const id = input.id ?? randomUUID();
  const chainId = input.startsChain
    ? id
    : (input.chainId ??
      replyChainId ??
      (authorKind === "user" && !input.replyToMessageId ? id : null));
  const createdAt = input.createdAt ?? new Date().toISOString();
  const { sequence } = db
    .prepare(
      "select coalesce(max(sequence), 0) + 1 as sequence from group_messages where group_id = ?",
    )
    .get(input.groupId) as { sequence: number };
  db.prepare(
    `insert into group_messages (${MESSAGE_COLUMNS})
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.groupId,
    authorKind,
    input.authorSessionId ?? null,
    input.replyToMessageId ?? null,
    input.toSessionId ?? null,
    chainId,
    kind,
    input.body,
    JSON.stringify(mentions),
    attachments.length > 0 ? JSON.stringify(attachments) : null,
    contextItems.length > 0 ? JSON.stringify(contextItems) : null,
    createdAt,
    input.turnId ?? null,
    input.runId ?? null,
    input.sdkMessageId ?? null,
    sequence,
    input.status ?? null,
    createdAt,
    input.error ?? null,
  );
  const row = db
    .prepare(`select ${MESSAGE_COLUMNS} from group_messages where id = ?`)
    .get(id) as MessageRow;
  return toMessage(row);
}

/** Update a trusted runtime-owned public card; identity and posting order stay fixed. */
export function updateGroupMessage(
  messageId: string,
  patch: {
    body?: string;
    runId?: string;
    sdkMessageId?: string;
    status?: GroupMessageStatus;
    error?: string;
  },
): GroupMessage | undefined {
  const current = getGroupMessage(messageId);
  if (!current?.turnId || current.authorKind !== "agent") return undefined;
  const revision = new Date(
    Math.max(Date.now(), Date.parse(current.updatedAt ?? current.createdAt) + 1),
  ).toISOString();
  getDatabase()
    .prepare(`update group_messages set body = ?, run_id = ?, sdk_message_id = ?,
    status = ?, error = ?, updated_at = ? where id = ?`)
    .run(
      patch.body ?? current.body,
      patch.runId ?? current.runId ?? null,
      patch.sdkMessageId ?? current.sdkMessageId ?? null,
      patch.status ?? current.status ?? null,
      patch.error ?? current.error ?? null,
      revision,
      messageId,
    );
  return getGroupMessage(messageId);
}

export function listGroupTurnMessages(turnId: string): GroupMessage[] {
  return (
    getDatabase()
      .prepare(`select ${MESSAGE_COLUMNS} from group_messages where turn_id = ? order by sequence`)
      .all(turnId) as MessageRow[]
  ).map(toMessage);
}

export function getGroupMessage(messageId: string): GroupMessage | undefined {
  const row = getDatabase()
    .prepare(`select ${MESSAGE_COLUMNS} from group_messages where id = ?`)
    .get(messageId) as MessageRow | undefined;
  return row ? toMessage(row) : undefined;
}

/**
 * Returns one page in persisted conversation order, oldest first.
 * Existing `{ createdAt, id }` cursors resolve the message ID to its stable sequence.
 * Unknown and cross-group cursor IDs use the timestamp fallback for compatibility.
 */
export function listGroupMessages(
  groupId: string,
  options: { before?: GroupMessageCursor; after?: GroupMessageCursor; limit?: number } = {},
): GroupMessage[] {
  const limit = Math.max(
    1,
    Math.min(MAX_MESSAGE_PAGE, Math.floor(options.limit ?? DEFAULT_MESSAGE_PAGE)),
  );
  const db = getDatabase();
  const conditions = ["group_id = ?"];
  const params: Array<string | number> = [groupId];
  if (options.before !== undefined) {
    const boundary = getGroupMessage(options.before.id);
    if (boundary?.groupId === groupId && boundary.sequence !== undefined) {
      conditions.push("sequence < ?");
      params.push(boundary.sequence);
    } else {
      conditions.push("(created_at, id) < (?, ?)");
      params.push(options.before.createdAt, options.before.id);
    }
  }
  if (options.after !== undefined) {
    const boundary = getGroupMessage(options.after.id);
    if (boundary?.groupId === groupId && boundary.sequence !== undefined) {
      conditions.push("sequence > ?");
      params.push(boundary.sequence);
    } else {
      conditions.push("(created_at, id) > (?, ?)");
      params.push(options.after.createdAt, options.after.id);
    }
  }
  const where = conditions.join(" and ");
  if (options.after !== undefined && options.before === undefined) {
    const rows = db
      .prepare(
        `select ${MESSAGE_COLUMNS} from group_messages where ${where}
         order by sequence asc limit ?`,
      )
      .all(...params, limit) as MessageRow[];
    return rows.map(toMessage);
  }
  const rows = db
    .prepare(
      `select ${MESSAGE_COLUMNS} from group_messages where ${where}
       order by sequence desc limit ?`,
    )
    .all(...params, limit) as MessageRow[];
  return rows.reverse().map(toMessage);
}

/* ── Decisions (PR 6: shared context) ─────────────────────────────────── */

/** Most decisions a group keeps; the next record fails with limit-reached. */
export const GROUP_DECISION_LIMIT = 100;
/** Longest decision text (after trim). */
export const GROUP_DECISION_MAX_CHARS = 500;

function requireDecision(decisionId: string): GroupDecision {
  const row = getDatabase()
    .prepare(`select ${DECISION_COLUMNS} from group_decisions where id = ?`)
    .get(decisionId) as DecisionRow | undefined;
  if (!row) {
    throw new GroupStoreError("decision-not-found", `Group decision not found: ${decisionId}`);
  }
  return toDecision(row);
}

/**
 * Records a decision (a member's group_record_decision; no authorSessionId = the
 * user). Text is trimmed and must be 1-500 characters (invalid-text); a group
 * holds at most 100 (limit-reached).
 */
export function recordGroupDecision(input: {
  groupId: string;
  text: string;
  authorSessionId?: string;
  sourceMessageId?: string;
  executionId?: string;
}): GroupDecision {
  const db = getDatabase();
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length === 0 || text.length > GROUP_DECISION_MAX_CHARS) {
    throw new GroupStoreError(
      "invalid-text",
      `Decision text must be 1-${GROUP_DECISION_MAX_CHARS} characters after trimming (got ${text.length}).`,
    );
  }
  const id = inTransaction(db, () => {
    requireGroupRow(input.groupId);
    if (input.authorSessionId) {
      requireMember(input.groupId, input.authorSessionId, "decision author");
    }
    if (input.sourceMessageId) {
      const source = db
        .prepare("select group_id from group_messages where id = ?")
        .get(input.sourceMessageId) as { group_id: string } | undefined;
      if (!source || source.group_id !== input.groupId) {
        throw new GroupStoreError(
          "message-not-found",
          `Source message ${input.sourceMessageId} is not a message in group ${input.groupId}.`,
        );
      }
    }
    if (input.executionId) requireExecutionInGroup(input.groupId, input.executionId);
    const count = db
      .prepare("select count(*) as n from group_decisions where group_id = ?")
      .get(input.groupId) as { n: number };
    if (Number(count.n) >= GROUP_DECISION_LIMIT) {
      throw new GroupStoreError(
        "limit-reached",
        `Group ${input.groupId} already has ${GROUP_DECISION_LIMIT} decisions; the user must delete one first.`,
      );
    }
    const decisionId = randomUUID();
    db.prepare(
      `insert into group_decisions (${DECISION_COLUMNS})
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      decisionId,
      input.groupId,
      text,
      input.authorSessionId ?? null,
      input.sourceMessageId ?? null,
      input.executionId ?? null,
      new Date().toISOString(),
    );
    return decisionId;
  });
  return requireDecision(id);
}

/** A group's decisions, newest first. */
export function listGroupDecisions(groupId: string): GroupDecision[] {
  const rows = getDatabase()
    .prepare(
      `select ${DECISION_COLUMNS} from group_decisions
       where group_id = ?
       order by created_at desc, rowid desc`,
    )
    .all(groupId) as DecisionRow[];
  return rows.map(toDecision);
}

/** The user's "Delete" (physical); returns the removed decision. */
export function deleteGroupDecision(decisionId: string): GroupDecision {
  const decision = requireDecision(decisionId);
  getDatabase().prepare("delete from group_decisions where id = ?").run(decisionId);
  return decision;
}
