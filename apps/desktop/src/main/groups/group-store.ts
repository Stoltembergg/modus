import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentGroupInfo,
  AgentGroupMember,
  AgentGroupMode,
  GroupDecision,
  GroupMessage,
  GroupMessageAuthorKind,
  GroupMessageKind,
  GroupTask,
  GroupTaskStatus,
} from "../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";
import { getDatabase } from "../db/database";

/*
 * Agent Groups persistence. Plain function module in the style of
 * agent-store / workspace-store. Business rules that SQLite cannot express
 * (workspace matching, lead must be a member, authors/owners must be members)
 * are enforced here and surfaced as a typed `GroupStoreError`.
 */

export type GroupStoreErrorCode =
  | "group-not-found"
  | "session-not-found"
  | "message-not-found"
  | "task-not-found"
  | "decision-not-found"
  | "workspace-mismatch"
  | "already-in-group"
  | "not-a-member"
  | "invalid-value";

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
const TASK_STATUSES: readonly GroupTaskStatus[] = [
  "open",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
];
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
  joined_at: string;
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
  created_at: string;
};

type TaskRow = {
  id: string;
  group_id: string;
  title: string;
  description: string | null;
  status: GroupTaskStatus;
  owner_session_id: string | null;
  created_by_session_id: string | null;
  reviewer_session_id: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
};

type DecisionRow = {
  id: string;
  group_id: string;
  text: string;
  source_message_id: string | null;
  created_by_session_id: string | null;
  superseded_by_id: string | null;
  created_at: string;
};

const GROUP_COLUMNS = "id, name, workspace_id, mode, lead_session_id, created_at, updated_at";
const MEMBER_COLUMNS = "group_id, session_id, role, joined_at";
const MESSAGE_COLUMNS = `id, group_id, author_kind, author_session_id, reply_to_message_id,
  to_session_id, chain_id, kind, body, mentions_json, created_at`;
const TASK_COLUMNS = `id, group_id, title, description, status, owner_session_id,
  created_by_session_id, reviewer_session_id, branch, created_at, updated_at`;
const DECISION_COLUMNS =
  "id, group_id, text, source_message_id, created_by_session_id, superseded_by_id, created_at";

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

function toMessage(row: MessageRow): GroupMessage {
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
    createdAt: row.created_at,
  };
}

function toTask(row: TaskRow): GroupTask {
  return {
    id: row.id,
    groupId: row.group_id,
    title: row.title,
    ...(row.description !== null ? { description: row.description } : {}),
    status: row.status,
    ...(row.owner_session_id !== null ? { ownerSessionId: row.owner_session_id } : {}),
    ...(row.created_by_session_id !== null
      ? { createdBySessionId: row.created_by_session_id }
      : {}),
    ...(row.reviewer_session_id !== null ? { reviewerSessionId: row.reviewer_session_id } : {}),
    ...(row.branch !== null ? { branch: row.branch } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDecision(row: DecisionRow): GroupDecision {
  return {
    id: row.id,
    groupId: row.group_id,
    text: row.text,
    ...(row.source_message_id !== null ? { sourceMessageId: row.source_message_id } : {}),
    ...(row.created_by_session_id !== null
      ? { createdBySessionId: row.created_by_session_id }
      : {}),
    ...(row.superseded_by_id !== null ? { supersededById: row.superseded_by_id } : {}),
    createdAt: row.created_at,
  };
}

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("begin");
  try {
    const result = fn();
    db.exec("commit");
    return result;
  } catch (error) {
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

export function createAgentGroup(input: {
  id?: string;
  name: string;
  /** Owning Project. Omit (or pass the Chats inbox id) for a group with no Project. */
  workspaceId?: string | null;
  mode?: AgentGroupMode;
}): AgentGroupInfo {
  const name = requireText(input.name, "name");
  const mode = requireOneOf(input.mode ?? "free", GROUP_MODES, "group mode");
  const workspaceId =
    input.workspaceId && input.workspaceId !== CHATS_WORKSPACE_ID ? input.workspaceId : null;
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into agent_groups (id, name, workspace_id, mode, lead_session_id, created_at, updated_at)
       values (?, ?, ?, ?, null, ?, ?)`,
    )
    .run(id, name, workspaceId, mode, now, now);
  return toGroup(requireGroupRow(id));
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
 * Deletes the group and (via cascade) its members, messages, tasks and
 * decisions. Member agent_sessions are NOT deleted; they return to their
 * normal workspace listing.
 */
export function deleteAgentGroup(groupId: string): void {
  getDatabase().prepare("delete from agent_groups where id = ?").run(groupId);
}

/* ── Members ───────────────────────────────────────────────────────────── */

export function addAgentGroupMember(input: {
  groupId: string;
  sessionId: string;
  role?: string;
}): AgentGroupMember {
  const db = getDatabase();
  const group = requireGroupRow(input.groupId);
  const session = db
    .prepare("select id, workspace_id from agent_sessions where id = ?")
    .get(input.sessionId) as { id: string; workspace_id: string } | undefined;
  if (!session) {
    throw new GroupStoreError("session-not-found", `Agent session not found: ${input.sessionId}`);
  }
  const expectedWorkspaceId = group.workspace_id ?? CHATS_WORKSPACE_ID;
  if (session.workspace_id !== expectedWorkspaceId) {
    throw new GroupStoreError(
      "workspace-mismatch",
      group.workspace_id === null
        ? `Session ${input.sessionId} belongs to a Project; a group without a Project only accepts chats without a folder.`
        : `Session ${input.sessionId} belongs to a different workspace than group ${input.groupId}.`,
    );
  }
  const role = input.role?.trim() ? input.role.trim() : null;
  const joinedAt = new Date().toISOString();
  try {
    db.prepare(
      `insert into agent_group_members (group_id, session_id, role, joined_at)
       values (?, ?, ?, ?)`,
    ).run(input.groupId, input.sessionId, role, joinedAt);
  } catch (error) {
    if (isUniqueMemberViolation(error)) {
      throw new GroupStoreError(
        "already-in-group",
        `Session ${input.sessionId} is already a member of a group.`,
        { cause: error },
      );
    }
    throw error;
  }
  touchGroup(input.groupId);
  return {
    groupId: input.groupId,
    sessionId: input.sessionId,
    ...(role !== null ? { role } : {}),
    joinedAt,
  };
}

/** Removes a member; clears the group lead when the removed member was the lead. */
export function removeAgentGroupMember(groupId: string, sessionId: string): void {
  const db = getDatabase();
  inTransaction(db, () => {
    db.prepare(
      `update agent_groups set lead_session_id = null
       where id = ? and lead_session_id = ?`,
    ).run(groupId, sessionId);
    const result = db
      .prepare("delete from agent_group_members where group_id = ? and session_id = ?")
      .run(groupId, sessionId);
    if (Number(result.changes) > 0) {
      touchGroup(groupId);
    }
  });
}

export function listAgentGroupMembers(groupId: string): AgentGroupMember[] {
  const rows = getDatabase()
    .prepare(
      `select ${MEMBER_COLUMNS} from agent_group_members where group_id = ?
       order by joined_at, rowid`,
    )
    .all(groupId) as MemberRow[];
  return rows.map(toMember);
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
  kind?: GroupMessageKind;
  body: string;
  mentions?: string[];
  createdAt?: string;
}): GroupMessage {
  const db = getDatabase();
  requireGroupRow(input.groupId);
  const authorKind = requireOneOf(input.authorKind, AUTHOR_KINDS, "message author kind");
  const kind = requireOneOf(input.kind ?? "message", MESSAGE_KINDS, "message kind");
  if (typeof input.body !== "string" || input.body.trim() === "") {
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

  const id = input.id ?? randomUUID();
  const chainId =
    input.chainId ?? replyChainId ?? (authorKind === "user" && !input.replyToMessageId ? id : null);
  const createdAt = input.createdAt ?? new Date().toISOString();
  db.prepare(
    `insert into group_messages (${MESSAGE_COLUMNS})
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    createdAt,
  );
  const row = db
    .prepare(`select ${MESSAGE_COLUMNS} from group_messages where id = ?`)
    .get(id) as MessageRow;
  return toMessage(row);
}

/**
 * Returns one page of messages in chronological order (oldest first).
 * - `before`: the newest `limit` messages strictly older than this ISO timestamp.
 * - `after`: the oldest `limit` messages strictly newer than this ISO timestamp.
 * - neither: the newest `limit` messages.
 * Ties on created_at are ordered by insertion.
 */
export function listGroupMessages(
  groupId: string,
  options: { before?: string; after?: string; limit?: number } = {},
): GroupMessage[] {
  const limit = Math.max(
    1,
    Math.min(MAX_MESSAGE_PAGE, Math.floor(options.limit ?? DEFAULT_MESSAGE_PAGE)),
  );
  const db = getDatabase();
  const conditions = ["group_id = ?"];
  const params: string[] = [groupId];
  if (options.before !== undefined) {
    conditions.push("created_at < ?");
    params.push(options.before);
  }
  if (options.after !== undefined) {
    conditions.push("created_at > ?");
    params.push(options.after);
  }
  const where = conditions.join(" and ");
  if (options.after !== undefined && options.before === undefined) {
    const rows = db
      .prepare(
        `select ${MESSAGE_COLUMNS} from group_messages where ${where}
         order by created_at asc, rowid asc limit ?`,
      )
      .all(...params, limit) as MessageRow[];
    return rows.map(toMessage);
  }
  const rows = db
    .prepare(
      `select ${MESSAGE_COLUMNS} from group_messages where ${where}
       order by created_at desc, rowid desc limit ?`,
    )
    .all(...params, limit) as MessageRow[];
  return rows.reverse().map(toMessage);
}

/* ── Tasks ─────────────────────────────────────────────────────────────── */

export function createGroupTask(input: {
  id?: string;
  groupId: string;
  title: string;
  description?: string;
  status?: GroupTaskStatus;
  ownerSessionId?: string;
  createdBySessionId?: string;
  reviewerSessionId?: string;
  branch?: string;
}): GroupTask {
  const db = getDatabase();
  requireGroupRow(input.groupId);
  const title = requireText(input.title, "task title");
  const status = requireOneOf(input.status ?? "open", TASK_STATUSES, "task status");
  if (input.ownerSessionId) requireMember(input.groupId, input.ownerSessionId, "owner");
  if (input.createdBySessionId) {
    requireMember(input.groupId, input.createdBySessionId, "task creator");
  }
  if (input.reviewerSessionId) requireMember(input.groupId, input.reviewerSessionId, "reviewer");
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `insert into group_tasks (${TASK_COLUMNS})
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.groupId,
    title,
    input.description ?? null,
    status,
    input.ownerSessionId ?? null,
    input.createdBySessionId ?? null,
    input.reviewerSessionId ?? null,
    input.branch ?? null,
    now,
    now,
  );
  return requireTask(id);
}

function requireTask(taskId: string): GroupTask {
  const row = getDatabase()
    .prepare(`select ${TASK_COLUMNS} from group_tasks where id = ?`)
    .get(taskId) as TaskRow | undefined;
  if (!row) {
    throw new GroupStoreError("task-not-found", `Group task not found: ${taskId}`);
  }
  return toTask(row);
}

/**
 * Patches a task. `null` clears owner / reviewer / branch; omitted fields are
 * left unchanged. New owners and reviewers must be group members.
 */
export function updateGroupTask(
  taskId: string,
  patch: {
    status?: GroupTaskStatus;
    ownerSessionId?: string | null;
    reviewerSessionId?: string | null;
    branch?: string | null;
  },
): GroupTask {
  const current = requireTask(taskId);
  const sets: string[] = [];
  const params: Array<string | null> = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(requireOneOf(patch.status, TASK_STATUSES, "task status"));
  }
  if (patch.ownerSessionId !== undefined) {
    if (patch.ownerSessionId !== null) {
      requireMember(current.groupId, patch.ownerSessionId, "owner");
    }
    sets.push("owner_session_id = ?");
    params.push(patch.ownerSessionId);
  }
  if (patch.reviewerSessionId !== undefined) {
    if (patch.reviewerSessionId !== null) {
      requireMember(current.groupId, patch.reviewerSessionId, "reviewer");
    }
    sets.push("reviewer_session_id = ?");
    params.push(patch.reviewerSessionId);
  }
  if (patch.branch !== undefined) {
    sets.push("branch = ?");
    params.push(patch.branch);
  }
  if (sets.length === 0) {
    return current;
  }
  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  getDatabase()
    .prepare(`update group_tasks set ${sets.join(", ")} where id = ?`)
    .run(...params, taskId);
  return requireTask(taskId);
}

export function listGroupTasks(
  groupId: string,
  options: { status?: GroupTaskStatus } = {},
): GroupTask[] {
  const db = getDatabase();
  const rows =
    options.status === undefined
      ? (db
          .prepare(
            `select ${TASK_COLUMNS} from group_tasks where group_id = ?
             order by created_at, rowid`,
          )
          .all(groupId) as TaskRow[])
      : (db
          .prepare(
            `select ${TASK_COLUMNS} from group_tasks where group_id = ? and status = ?
             order by created_at, rowid`,
          )
          .all(groupId, requireOneOf(options.status, TASK_STATUSES, "task status")) as TaskRow[]);
  return rows.map(toTask);
}

/* ── Decisions ─────────────────────────────────────────────────────────── */

function insertDecision(input: {
  groupId: string;
  text: string;
  sourceMessageId?: string;
  createdBySessionId?: string;
}): string {
  const db = getDatabase();
  const text = requireText(input.text, "decision text");
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
  if (input.createdBySessionId) {
    requireMember(input.groupId, input.createdBySessionId, "decision author");
  }
  const id = randomUUID();
  db.prepare(
    `insert into group_decisions (${DECISION_COLUMNS})
     values (?, ?, ?, ?, ?, null, ?)`,
  ).run(
    id,
    input.groupId,
    text,
    input.sourceMessageId ?? null,
    input.createdBySessionId ?? null,
    new Date().toISOString(),
  );
  return id;
}

function requireDecision(decisionId: string): GroupDecision {
  const row = getDatabase()
    .prepare(`select ${DECISION_COLUMNS} from group_decisions where id = ?`)
    .get(decisionId) as DecisionRow | undefined;
  if (!row) {
    throw new GroupStoreError("decision-not-found", `Group decision not found: ${decisionId}`);
  }
  return toDecision(row);
}

export function addGroupDecision(input: {
  groupId: string;
  text: string;
  sourceMessageId?: string;
  createdBySessionId?: string;
}): GroupDecision {
  requireGroupRow(input.groupId);
  return requireDecision(insertDecision(input));
}

/**
 * Records a replacement decision and marks the old one as superseded by it,
 * atomically. Returns the new (active) decision.
 */
export function supersedeGroupDecision(
  decisionId: string,
  replacement: { text: string; sourceMessageId?: string; createdBySessionId?: string },
): GroupDecision {
  const db = getDatabase();
  const previous = requireDecision(decisionId);
  if (previous.supersededById) {
    throw new GroupStoreError(
      "invalid-value",
      `Decision ${decisionId} is already superseded by ${previous.supersededById}.`,
    );
  }
  const newId = inTransaction(db, () => {
    const id = insertDecision({ groupId: previous.groupId, ...replacement });
    db.prepare("update group_decisions set superseded_by_id = ? where id = ?").run(id, decisionId);
    return id;
  });
  return requireDecision(newId);
}

export function listActiveGroupDecisions(groupId: string): GroupDecision[] {
  const rows = getDatabase()
    .prepare(
      `select ${DECISION_COLUMNS} from group_decisions
       where group_id = ? and superseded_by_id is null
       order by created_at, rowid`,
    )
    .all(groupId) as DecisionRow[];
  return rows.map(toDecision);
}
