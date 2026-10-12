import { randomUUID } from "node:crypto";
import {
  capabilitiesForRole,
  effectiveCapabilities,
  roleIdForLabel,
} from "../../shared/agent-roles";
import { agentAvatarForId, getAgentTemplate } from "../../shared/agent-templates";
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_FACES,
  AGENT_AVATAR_SHAPES,
  type AgentAvatarColor,
  type AgentAvatarFace,
  type AgentAvatarShape,
  type AgentGroupMember,
  type AgentGroupMode,
  type AgentGroupWithMembers,
  type AgentInfo,
  type AgentSessionInfo,
  allocateUniqueGroupAvatarShapes,
  CHATS_WORKSPACE_ID,
  type CreateAgentInput,
  type CreateGroupAgentInput,
  type NewGroupAgentInput,
  type UpdateAgentGroupMembersInput,
  type UpdateAgentInput,
} from "../../shared/contracts";
import {
  GROUP_BLOCKED_TEXT,
  type GroupBlockedReason,
  groupBlockedErrorCode,
  groupBlockedReason,
  groupMembersUpdateCountError,
} from "../../shared/group-blocked";
import {
  type GroupMemberCapabilities,
  normalizeGroupMemberCapabilities,
} from "../../shared/group-capabilities";
import { getAgentSession } from "../agent/agent-store";
import { getDatabase, uniqueAgentName } from "../db/database";
import {
  agentChatSessionIds,
  GroupStoreError,
  getAgentGroup,
  getAgentGroupWithMembers,
  insertGroupWithProject,
  joinGroupRows,
  removeAgentFromGroupRows,
  requireGroupProject,
  requireGroupRow,
  setGroupLeadRow,
  throwCountError,
  withGroupTransaction,
} from "../groups/group-store";
import { ensureChatsWorkspace } from "../workspace/workspace-store";

/*
 * Agents (agents model): each belongs to ONE group (A2, `group_id`), with a
 * name unique in that group (case-insensitive), a persona and defaults. Plain function module like
 * group-store; errors are GroupStoreError so the group IPC error wire format
 * (and the renderer's messages) apply unchanged.
 */

type AgentRow = {
  id: string;
  group_id: string | null;
  name: string;
  role: string;
  instructions: string;
  model_id: string | null;
  default_workspace_id: string | null;
  avatar_face: AgentAvatarFace;
  avatar_color: AgentAvatarColor;
  avatar_shape: AgentAvatarShape;
  template_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  capability_ids_json: string;
  supported_task_kinds_json: string;
};

const AGENT_COLUMNS = `id, group_id, name, role, instructions, model_id, default_workspace_id,
  avatar_face, avatar_color, avatar_shape, template_id, created_at, updated_at, archived_at, capability_ids_json, supported_task_kinds_json`;

/** The lists exactly as saved (empty for agents saved before they existed). */
function savedCapabilities(
  row: Pick<AgentRow, "capability_ids_json" | "supported_task_kinds_json">,
) {
  return normalizeGroupMemberCapabilities({
    capabilityIds: JSON.parse(row.capability_ids_json ?? "[]"),
    supportedTaskKinds: JSON.parse(row.supported_task_kinds_json ?? "[]"),
  });
}

/** What an agent handles: its saved lists, or (when empty) its derived role's. Copies take this too. */
function handledCapabilities(row: AgentRow): GroupMemberCapabilities {
  return effectiveCapabilities({
    ...savedCapabilities(row),
    role: row.role,
    ...(row.template_id !== null ? { templateId: row.template_id } : {}),
  });
}

function toAgent(row: AgentRow): AgentInfo {
  return {
    // Saved lists as they are; empty ones read as the agent's derived role.
    ...handledCapabilities(row),
    id: row.id,
    ...(row.group_id !== null ? { groupId: row.group_id } : {}),
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    ...(row.model_id !== null ? { modelId: row.model_id } : {}),
    ...(row.default_workspace_id !== null ? { defaultWorkspaceId: row.default_workspace_id } : {}),
    avatarFace: row.avatar_face,
    avatarColor: row.avatar_color,
    avatarShape: row.avatar_shape,
    ...(row.template_id !== null ? { templateId: row.template_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
  };
}

function requireAgentRow(agentId: string): AgentRow {
  const row = getDatabase()
    .prepare(`select ${AGENT_COLUMNS} from agents where id = ?`)
    .get(agentId) as AgentRow | undefined;
  if (!row) {
    throw new GroupStoreError("agent-not-found", `Agent not found: ${agentId}`);
  }
  return row;
}

/** Another agent holding `name` in the same scope (group, or the active groupless profiles). */
function nameOwner(name: string, groupId: string | null): { id: string } | undefined {
  // Groupless profiles: unique among the ACTIVE ones (archived names are free, as the
  // PR 4 partial index `where group_id is null and archived_at is null` will be).
  const sql =
    groupId === null
      ? "select id from agents where name = ? and group_id is null and archived_at is null"
      : "select id from agents where name = ? and group_id = ?";
  const db = getDatabase().prepare(sql);
  return (groupId === null ? db.get(name) : db.get(name, groupId)) as { id: string } | undefined;
}

/** Max agent name length (the IPC schema's `agentFields.name`). */
export const AGENT_NAME_MAX_LENGTH = 80;

/** "Name n" within AGENT_NAME_MAX_LENGTH: the base is shortened, never the suffix. */
export function suffixedAgentName(base: string, n: number): string {
  const suffix = ` ${n}`;
  return `${base.slice(0, AGENT_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

/** Trimmed, non-empty name that no OTHER agent of the same group has (case-insensitive). */
function requireFreeName(name: string, groupId: string | null, selfId?: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) {
    throw new GroupStoreError("invalid-value", "Agent name must not be empty.");
  }
  const owner = nameOwner(trimmed, groupId);
  if (owner && owner.id !== selfId) {
    throw new GroupStoreError("agent-name-taken", `Another agent is already named "${trimmed}".`);
  }
  return trimmed;
}

function requireWorkspace(workspaceId: string | null): string | null {
  if (
    workspaceId !== null &&
    getDatabase().prepare("select 1 from workspaces where id = ?").get(workspaceId) === undefined
  ) {
    throw new GroupStoreError("workspace-not-found", `Workspace not found: ${workspaceId}`);
  }
  return workspaceId;
}

function requireAvatar<T extends string>(value: T, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value)) {
    throw new GroupStoreError("invalid-value", `Invalid ${field} "${String(value)}".`);
  }
  return value;
}

function requireCapabilities(input: Partial<GroupMemberCapabilities>) {
  try {
    return normalizeGroupMemberCapabilities(input);
  } catch {
    throw new GroupStoreError("invalid-value", "Invalid group member capabilities.");
  }
}

type AgentCreateFields = CreateAgentInput &
  Partial<GroupMemberCapabilities> & {
    templateId?: string;
    groupId?: string;
    /** A template's default shape can move to the next free silhouette in a group. */
    preferredAvatarShape?: AgentAvatarShape;
  };

function allocateNewGroupShape(
  groupId: string,
  agentId: string,
  preferredShape: AgentAvatarShape,
  explicit: boolean,
): AgentAvatarShape {
  const rows = getDatabase()
    .prepare("select id, avatar_shape from agents where group_id = ? order by id")
    .all(groupId) as Array<{ id: string; avatar_shape: AgentAvatarShape }>;
  const owner = rows.find((row) => row.avatar_shape === preferredShape);
  if (explicit && owner) {
    throw new GroupStoreError(
      "agent-avatar-shape-taken",
      `The ${preferredShape} avatar shape is already used in this group.`,
    );
  }
  if (rows.length >= AGENT_AVATAR_SHAPES.length) {
    throw new GroupStoreError("group-max-members", "A group can contain at most 10 agents.");
  }
  const assignments = allocateUniqueGroupAvatarShapes([
    ...rows.map((row) => ({ agentId: row.id, preferredShape: row.avatar_shape })),
    { agentId, preferredShape },
  ]);
  const shape = assignments.get(agentId);
  if (!shape)
    throw new GroupStoreError("invalid-value", "Could not allocate an agent avatar shape.");
  return shape;
}

function requireFreeGroupShape(groupId: string, agentId: string, shape: AgentAvatarShape): void {
  const owner = getDatabase()
    .prepare("select id from agents where group_id = ? and avatar_shape = ? and id <> ?")
    .get(groupId, shape, agentId) as { id: string } | undefined;
  if (owner) {
    throw new GroupStoreError(
      "agent-avatar-shape-taken",
      `The ${shape} avatar shape is already used in this group.`,
    );
  }
}

/** Every agent (archived included, with `archivedAt`), by name. */
export function listAgents(): AgentInfo[] {
  const rows = getDatabase()
    .prepare(`select ${AGENT_COLUMNS} from agents order by name collate nocase, id`)
    .all() as AgentRow[];
  return rows.map(toAgent);
}

export function getAgent(agentId: string): AgentInfo | undefined {
  const row = getDatabase()
    .prepare(`select ${AGENT_COLUMNS} from agents where id = ?`)
    .get(agentId) as AgentRow | undefined;
  return row ? toAgent(row) : undefined;
}

/**
 * Inserts an agent row. `groupId` is only the column: joining the group (the
 * membership and its room session) is createAgentInGroup. Without a group the
 * row is a legacy-style ungrouped agent (store level only; IPC requires one).
 */
export function createAgent(input: AgentCreateFields): AgentInfo {
  const capabilities = requireCapabilities(input);
  const id = randomUUID();
  const now = new Date().toISOString();
  const avatar = agentAvatarForId(id);
  const groupId = input.groupId ?? null;
  const preferredShape = requireAvatar(
    input.avatarShape ?? input.preferredAvatarShape ?? avatar.avatarShape,
    AGENT_AVATAR_SHAPES,
    "avatar shape",
  );
  const avatarShape =
    groupId === null
      ? preferredShape
      : allocateNewGroupShape(groupId, id, preferredShape, input.avatarShape !== undefined);
  getDatabase()
    .prepare(
      `insert into agents (${AGENT_COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)`,
    )
    .run(
      id,
      groupId,
      requireFreeName(input.name, groupId),
      (input.role ?? "").trim(),
      input.instructions ?? "",
      input.modelId || null,
      requireWorkspace(input.defaultWorkspaceId ?? null),
      requireAvatar(input.avatarFace ?? avatar.avatarFace, AGENT_AVATAR_FACES, "avatar face"),
      requireAvatar(input.avatarColor ?? avatar.avatarColor, AGENT_AVATAR_COLORS, "avatar color"),
      avatarShape,
      input.templateId ?? null,
      now,
      now,
      JSON.stringify(capabilities.capabilityIds),
      JSON.stringify(capabilities.supportedTaskKinds),
    );
  return toAgent(requireAgentRow(id));
}

/**
 * The fields of a new agent: a template fills name (next free in the group),
 * role, instructions and avatar; explicit fields win.
 */
function newAgentFields(input: NewGroupAgentInput, groupId: string | undefined): AgentCreateFields {
  const { templateId, copiedFromAgentId, ...fields } = input;
  const base = { ...fields, ...(groupId !== undefined ? { groupId } : {}) };
  if (templateId === undefined) {
    // A copy handles what its source handles (empty lists derived, as shown) unless its
    // role was changed in the modal: then it follows the new role, like an edit would.
    // Any other new agent follows its role.
    const source = copiedFromAgentId !== undefined ? requireAgentRow(copiedFromAgentId) : undefined;
    const capabilities =
      source !== undefined &&
      (fields.role === undefined || roleIdForLabel(fields.role) === roleIdForLabel(source.role))
        ? handledCapabilities(source)
        : capabilitiesForRole(roleIdForLabel(fields.role));
    return { ...base, ...capabilities };
  }
  const template = getAgentTemplate(templateId);
  if (!template) {
    throw new GroupStoreError("invalid-value", `Unknown agent template: ${templateId}`);
  }
  // Template agents handle their template's work, unless the role picked names another role.
  const capabilities =
    fields.role !== undefined && roleIdForLabel(fields.role) !== roleIdForLabel(template.role)
      ? capabilitiesForRole(roleIdForLabel(fields.role))
      : { capabilityIds: template.capabilityIds, supportedTaskKinds: template.supportedTaskKinds };
  return {
    ...capabilities,
    role: template.role,
    instructions: template.instructions,
    avatarFace: template.avatarFace,
    avatarColor: template.avatarColor,
    ...base,
    preferredAvatarShape:
      fields.avatarShape ??
      agentAvatarForId(`${template.id}:${fields.name ?? template.name}`).avatarShape,
    name: fields.name?.trim()
      ? fields.name
      : uniqueAgentName(getDatabase(), template.name, groupId),
    templateId: template.id,
  };
}

/**
 * `agents:create` without a group: a standalone profile (no membership, no
 * room session). Its name must be free among the active groupless profiles;
 * `defaultWorkspaceId` is where its chats open (else No project).
 */
export function createProfile(input: NewGroupAgentInput): AgentInfo {
  return createAgent(newAgentFields(input, undefined));
}

/**
 * Picking a template: creates an editable copy (name, role, instructions and
 * avatar copied, `template_id` set, app-default model). A taken name gets the
 * next free suffix in the group ("Planner 2"); `overrides.name` is used as given.
 */
export function createAgentFromTemplate(
  templateId: string,
  overrides: { name?: string; defaultWorkspaceId?: string | null; groupId?: string } = {},
): AgentInfo {
  return createAgent(
    newAgentFields(
      {
        templateId,
        name: overrides.name ?? "",
        ...(overrides.defaultWorkspaceId !== undefined
          ? { defaultWorkspaceId: overrides.defaultWorkspaceId }
          : {}),
      },
      overrides.groupId,
    ),
  );
}

/**
 * `agents:create`: a new agent that joins `groupId` (its only group) in ONE
 * transaction: the 10-member cap, the group's Project, a fresh hidden room
 * session and a "X joined as <role>" line. Allowed in a group blocked with a
 * single member (it is the way out).
 */
export function createAgentInGroup(input: CreateGroupAgentInput): AgentInfo {
  const { groupId, ...fields } = input;
  return withGroupTransaction(() => {
    getAgentGroupWithMembers(groupId);
    const agent = createAgent(newAgentFields(fields, groupId));
    joinGroupRows(groupId, agent.id);
    return toAgent(requireAgentRow(agent.id));
  });
}

/**
 * `group:create`: the group in its Project (required) with 2..10 NEW agents
 * (each with its hidden room session) and the lead by name, in ONE
 * transaction.
 */
export function createGroupWithNewAgents(input: {
  name: string;
  workspaceId: string | null | undefined;
  mode?: AgentGroupMode;
  members: NewGroupAgentInput[];
  leadName?: string | null;
}): AgentGroupWithMembers {
  return withGroupTransaction(() => {
    const groupId = insertGroupWithProject(input, input.members.length);
    let leadSessionId: string | null = null;
    const lead = input.leadName?.trim().toLocaleLowerCase();
    for (const member of input.members) {
      const agent = createAgent(newAgentFields(member, groupId));
      const row: AgentGroupMember = joinGroupRows(groupId, agent.id, undefined, {
        event: false,
        cap: false,
      });
      if (lead && agent.name.toLocaleLowerCase() === lead) leadSessionId = row.sessionId;
    }
    if (lead && leadSessionId === null) {
      throw new GroupStoreError("not-a-member", `The lead "${input.leadName}" must be a member.`);
    }
    if (leadSessionId !== null) setGroupLeadRow(groupId, leadSessionId);
    return getAgentGroupWithMembers(groupId);
  });
}

/**
 * `group:update-members` ("Manage members") in ONE transaction: removes
 * `removeAgentIds` (deleting those agents and their room sessions), creates
 * the `add` agents in the group, and sets the lead. The 2..10 rule
 * (groupMembersUpdateCountError) and the lead are checked against the FINAL
 * state, so a 2-member group can replace both members at once. Any failure
 * rolls everything back. Returns the group and the removed session ids (the
 * caller stops their runtime).
 */
export function updateGroupMembers(input: UpdateAgentGroupMembersInput): {
  group: AgentGroupWithMembers;
  removedSessionIds: string[];
} {
  const { groupId, add, removeAgentIds, lead } = input;
  if (new Set(removeAgentIds).size !== removeAgentIds.length) {
    throw new GroupStoreError("invalid-value", "Each agent can be removed only once.");
  }
  const addKey = (name: string) => name.trim().toLocaleLowerCase();
  return withGroupTransaction(() => {
    const before = getAgentGroupWithMembers(groupId).members;
    const removed = removeAgentIds.map((agentId) => {
      const member = before.find((row) => row.agentId === agentId);
      if (!member) {
        throw new GroupStoreError("not-a-member", `Agent ${agentId} is not a member of the group.`);
      }
      return member;
    });
    throwCountError(groupMembersUpdateCountError(before.length, add.length, removed.length));
    const kept = before.filter((member) => !removeAgentIds.includes(member.agentId));
    let leadSessionId: string | null = null;
    if (lead && "agentId" in lead) {
      const member = kept.find((row) => row.agentId === lead.agentId);
      if (!member) {
        throw new GroupStoreError(
          "not-a-member",
          `The lead agent ${lead.agentId} must be a member after the change.`,
        );
      }
      leadSessionId = member.sessionId;
    } else if (lead && !add.some((agent) => addKey(agent.name) === addKey(lead.name))) {
      throw new GroupStoreError("not-a-member", `The lead "${lead.name}" must be a new member.`);
    }
    // Removes first: their names are free for the new agents.
    const removedSessionIds = removed.flatMap((member) =>
      removeAgentFromGroupRows(groupId, member.sessionId, false),
    );
    for (const member of add) {
      const agent = createAgent(newAgentFields(member, groupId));
      const row = joinGroupRows(groupId, agent.id, undefined, { cap: false });
      if (lead && "name" in lead && addKey(agent.name) === addKey(lead.name)) {
        leadSessionId = row.sessionId;
      }
    }
    setGroupLeadRow(groupId, leadSessionId);
    return {
      group: getAgentGroupWithMembers(groupId),
      removedSessionIds,
    };
  });
}

/** Changes only the given fields; `null` clears the model / default Project. */
export function updateAgent(agentId: string, input: UpdateAgentInput): AgentInfo {
  const row = requireAgentRow(agentId);
  // Saved lists stay exactly as they are until the role changes; a new role
  // replaces them with that role's lists.
  const roleChanged =
    input.role !== undefined && roleIdForLabel(input.role) !== roleIdForLabel(row.role);
  const capabilities = roleChanged
    ? capabilitiesForRole(roleIdForLabel(input.role))
    : savedCapabilities(row);
  const nextModelId = input.modelId !== undefined ? input.modelId || null : row.model_id;
  const avatarShape = requireAvatar(
    input.avatarShape ?? row.avatar_shape,
    AGENT_AVATAR_SHAPES,
    "avatar shape",
  );
  if (input.avatarShape !== undefined && row.group_id !== null) {
    requireFreeGroupShape(row.group_id, agentId, avatarShape);
  }
  getDatabase()
    .prepare(
      `update agents
       set name = ?, role = ?, instructions = ?, model_id = ?, default_workspace_id = ?,
           avatar_face = ?, avatar_color = ?, avatar_shape = ?, updated_at = ?, capability_ids_json = ?, supported_task_kinds_json = ?
       where id = ?`,
    )
    .run(
      input.name !== undefined ? requireFreeName(input.name, row.group_id, agentId) : row.name,
      input.role !== undefined ? input.role.trim() : row.role,
      input.instructions !== undefined ? input.instructions : row.instructions,
      nextModelId,
      input.defaultWorkspaceId !== undefined
        ? requireWorkspace(input.defaultWorkspaceId)
        : row.default_workspace_id,
      requireAvatar(input.avatarFace ?? row.avatar_face, AGENT_AVATAR_FACES, "avatar face"),
      requireAvatar(input.avatarColor ?? row.avatar_color, AGENT_AVATAR_COLORS, "avatar color"),
      avatarShape,
      new Date().toISOString(),
      JSON.stringify(capabilities.capabilityIds),
      JSON.stringify(capabilities.supportedTaskKinds),
      agentId,
    );
  // The agent's 1:1 chat (A3) is titled after it.
  if (input.name !== undefined) {
    getDatabase()
      .prepare(
        "update agent_sessions set title = ? where agent_id = ? and kind = 'chat' and read_only = 0",
      )
      .run(requireAgentRow(agentId).name, agentId);
  }
  // Edit agent Model must rebind every session that runs as this agent: the
  // hidden room session (group_member) and the 1:1 chat. Otherwise the next
  // wake / turn keeps the model stamped at create time.
  if (input.modelId !== undefined) {
    rebindAgentSessionModels(agentId, nextModelId);
  }
  return toAgent(requireAgentRow(agentId));
}

/**
 * Stamp `model` onto the agent's room session and 1:1 chat so the next prompt
 * (and any resume) picks up an Edit-agent model change without a restart.
 */
function rebindAgentSessionModels(agentId: string, modelId: string | null): void {
  const db = getDatabase();
  const member = db
    .prepare("select session_id from agent_group_members where agent_id = ?")
    .get(agentId) as { session_id: string } | undefined;
  const sessionIds = [...(member ? [member.session_id] : []), ...agentChatSessionIds([agentId])];
  if (sessionIds.length === 0) return;
  const update = db.prepare("update agent_sessions set model = ? where id = ?");
  for (const sessionId of sessionIds) {
    update.run(modelId, sessionId);
  }
}

/**
 * Archive / restore. Membership is untouched: an archived agent stays in its
 * groups but is never woken (the room posts "<name> is archived").
 */
export function setAgentArchived(agentId: string, archived: boolean): AgentInfo {
  const row = requireAgentRow(agentId);
  const db = getDatabase();
  if (archived || row.archived_at === null) {
    db.prepare("update agents set archived_at = ? where id = ?").run(
      archived ? (row.archived_at ?? new Date().toISOString()) : null,
      agentId,
    );
    return toAgent(requireAgentRow(agentId));
  }
  // Restoring a groupless profile whose name an active profile took meanwhile:
  // auto-rename it with the migration's dedupe rule ("A 2", "A 3"…). The caller
  // compares names to say "Restored as 'A 2'".
  let name = row.name;
  if (row.group_id === null && nameOwner(name, null) !== undefined) {
    let n = 2;
    while (nameOwner(suffixedAgentName(row.name, n), null) !== undefined) n += 1;
    name = suffixedAgentName(row.name, n);
  }
  withGroupTransaction(() => {
    db.prepare("update agents set archived_at = null, name = ?, updated_at = ? where id = ?").run(
      name,
      name === row.name ? row.updated_at : new Date().toISOString(),
      agentId,
    );
    if (name !== row.name) {
      db.prepare(
        "update agent_sessions set title = ? where agent_id = ? and kind = 'chat' and read_only = 0",
      ).run(name, agentId);
    }
  });
  return toAgent(requireAgentRow(agentId));
}

/**
 * Deletes the agent. For a group agent this IS removing the member (one
 * operation): refused with `group-min-members` when only 2 are left, otherwise
 * the member-removal rules (lead cleared, open tasks released owner-first), its
 * "X left the group" posted, in one transaction. Returns the room session and
 * 1:1 chat ids, still on disk: the caller tears them down after the commit
 * (agents/agent-teardown).
 */
export function deleteAgent(agentId: string): string[] {
  const row = requireAgentRow(agentId);
  const membership = getDatabase()
    .prepare("select group_id, session_id from agent_group_members where agent_id = ?")
    .get(agentId) as { group_id: string; session_id: string } | undefined;
  if (membership) {
    return withGroupTransaction(() =>
      removeAgentFromGroupRows(membership.group_id, membership.session_id),
    );
  }
  return withGroupTransaction(() => {
    const chatIds = agentChatSessionIds([row.id]);
    getDatabase().prepare("delete from agents where id = ?").run(row.id);
    return chatIds;
  });
}

/**
 * The agent's chat: its MOST RECENT WRITABLE `chat` (read_only = 0), else a
 * new one. A new chat opens in the agent's `default_workspace_id`; without
 * one, a grouped agent keeps using its group's Project (until PR 4 migrates
 * groups) and a profile opens in No project (the Chats inbox).
 */
export function openAgentChatRow(agentId: string): string {
  const db = getDatabase();
  const existing = db
    .prepare(
      `select id from agent_sessions
       where agent_id = ? and kind = 'chat' and read_only = 0
       order by updated_at desc, id desc limit 1`,
    )
    .get(agentId) as { id: string } | undefined;
  if (existing) return existing.id;
  return createAgentChatRow(agentId);
}

/** A new chat for the agent ("New chat with profile"), placed as openAgentChatRow describes. */
export function createAgentChatRow(agentId: string): string {
  const agent = requireAgentRow(agentId);
  const project = agentChatProject(agent);
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into agent_sessions
         (id, workspace_id, title, cwd, status, runtime, model, kind, agent_id, created_at, updated_at)
       values (?, ?, ?, ?, 'idle', 'pi-sdk', ?, 'chat', ?, ?, ?)`,
    )
    .run(sessionId, project.id, agent.name, project.root, agent.model_id, agentId, now, now);
  return sessionId;
}

function agentChatProject(agent: AgentRow): { id: string; root: string } {
  if (agent.default_workspace_id !== null) {
    const row = getDatabase()
      .prepare("select id, root_path from workspaces where id = ?")
      .get(agent.default_workspace_id) as { id: string; root_path: string } | undefined;
    if (row) return { id: row.id, root: row.root_path };
  }
  if (agent.group_id !== null) {
    return requireGroupProject(requireGroupRow(agent.group_id).workspace_id);
  }
  const inbox = ensureChatsWorkspace();
  return { id: CHATS_WORKSPACE_ID, root: inbox.rootPath };
}

/**
 * Opens the agent's chat (see openAgentChatRow).
 */
export function openAgentChat(agentId: string): AgentSessionInfo {
  requireAgentRow(agentId);
  const sessionId = openAgentChatRow(agentId);
  const session = getAgentSession(sessionId);
  if (!session) throw new GroupStoreError("session-not-found", `Session not found: ${sessionId}`);
  return session;
}

/**
 * Why an agent's 1:1 chat is read-only (A3): its group is blocked
 * (groupBlockedReason, e.g. no Project). Null for a working group and for any
 * other session. The renderer shows the room's banner; IPC and runtime refuse
 * to send.
 */
export function agentChatBlockedReason(sessionId: string): GroupBlockedReason | null {
  const row = getDatabase()
    .prepare(
      `select a.group_id from agent_sessions s join agents a on a.id = s.agent_id
       where s.id = ? and s.kind = 'chat'`,
    )
    .get(sessionId) as { group_id: string | null } | undefined;
  if (!row?.group_id) return null;
  const group = getAgentGroup(row.group_id);
  if (!group) return null;
  const members = getDatabase()
    .prepare("select count(*) as count from agent_group_members where group_id = ?")
    .get(group.id) as { count: number };
  return groupBlockedReason(group, Number(members.count));
}

/** Refuses a send to a read-only 1:1 chat (`group-project-required` / `group-min-members`). */
export function requireAgentChatWritable(sessionId: string): void {
  requireSessionWritable(sessionId);
  const reason = agentChatBlockedReason(sessionId);
  if (reason) throw new GroupStoreError(groupBlockedErrorCode(reason), GROUP_BLOCKED_TEXT[reason]);
}

/** Refuses any write to a read-only (migrated history) session: `session-read-only`. */
export function requireSessionWritable(sessionId: string): void {
  const row = getDatabase()
    .prepare("select read_only from agent_sessions where id = ?")
    .get(sessionId) as { read_only: number } | undefined;
  if (row && Number(row.read_only) !== 0) {
    throw new GroupStoreError("session-read-only", "This chat is read-only history.");
  }
}

/**
 * The persona block for an agent's 1:1 chat (its system prompt): who it is
 * and its instructions. Undefined for any other session, or an agent with
 * neither role nor instructions.
 */
export function agentChatPersonaPrompt(sessionId: string): string | undefined {
  const row = getDatabase()
    .prepare(
      `select a.name, a.role, a.instructions from agent_sessions s
       join agents a on a.id = s.agent_id
       where s.id = ? and s.kind = 'chat'`,
    )
    .get(sessionId) as { name: string; role: string; instructions: string } | undefined;
  if (!row || (!row.role.trim() && !row.instructions.trim())) return undefined;
  const who = row.role.trim()
    ? `You are ${row.name}, the ${row.role.trim()}.`
    : `You are ${row.name}.`;
  const body = row.instructions.trim();
  return ["<agent_instructions>", who, ...(body ? [body] : []), "</agent_instructions>"].join("\n");
}
