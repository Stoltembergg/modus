import { randomUUID } from "node:crypto";
import { agentAvatarForId, getAgentTemplate } from "../../shared/agent-templates";
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_FACES,
  type AgentAvatarColor,
  type AgentAvatarFace,
  type AgentGroupMember,
  type AgentGroupMode,
  type AgentGroupWithMembers,
  type AgentInfo,
  type CreateAgentInput,
  type CreateGroupAgentInput,
  type NewGroupAgentInput,
  type UpdateAgentGroupMembersInput,
  type UpdateAgentInput,
} from "../../shared/contracts";
import { groupMembersUpdateCountError } from "../../shared/group-blocked";
import { getDatabase, uniqueAgentName } from "../db/database";
import {
  GroupStoreError,
  getAgentGroupWithMembers,
  insertGroupWithProject,
  joinGroupRows,
  removeAgentFromGroupRows,
  setGroupLeadRow,
  throwCountError,
  withGroupTransaction,
} from "../groups/group-store";

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
  template_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

const AGENT_COLUMNS = `id, group_id, name, role, instructions, model_id, default_workspace_id,
  avatar_face, avatar_color, template_id, created_at, updated_at, archived_at`;

function toAgent(row: AgentRow): AgentInfo {
  return {
    id: row.id,
    ...(row.group_id !== null ? { groupId: row.group_id } : {}),
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    ...(row.model_id !== null ? { modelId: row.model_id } : {}),
    ...(row.default_workspace_id !== null ? { defaultWorkspaceId: row.default_workspace_id } : {}),
    avatarFace: row.avatar_face,
    avatarColor: row.avatar_color,
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

/** Trimmed, non-empty name that no OTHER agent of the same group has (case-insensitive). */
function requireFreeName(name: string, groupId: string | null, selfId?: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) {
    throw new GroupStoreError("invalid-value", "Agent name must not be empty.");
  }
  const owner = getDatabase()
    .prepare("select id from agents where name = ? and group_id is ?")
    .get(trimmed, groupId) as { id: string } | undefined;
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
export function createAgent(
  input: CreateAgentInput & { templateId?: string; groupId?: string },
): AgentInfo {
  const id = randomUUID();
  const now = new Date().toISOString();
  const avatar = agentAvatarForId(id);
  const groupId = input.groupId ?? null;
  getDatabase()
    .prepare(
      `insert into agents (${AGENT_COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)`,
    )
    .run(
      id,
      groupId,
      requireFreeName(input.name, groupId),
      (input.role ?? "").trim(),
      input.instructions ?? "",
      input.modelId?.trim() || null,
      requireWorkspace(input.defaultWorkspaceId ?? null),
      requireAvatar(input.avatarFace ?? avatar.avatarFace, AGENT_AVATAR_FACES, "avatar face"),
      requireAvatar(input.avatarColor ?? avatar.avatarColor, AGENT_AVATAR_COLORS, "avatar color"),
      input.templateId ?? null,
      now,
      now,
    );
  return toAgent(requireAgentRow(id));
}

/**
 * The fields of a new agent: a template fills name (next free in the group),
 * role, instructions and avatar; explicit fields win.
 */
function newAgentFields(
  input: NewGroupAgentInput,
  groupId: string | undefined,
): CreateAgentInput & { templateId?: string; groupId?: string } {
  const { templateId, ...fields } = input;
  const base = { ...fields, ...(groupId !== undefined ? { groupId } : {}) };
  if (templateId === undefined) return base;
  const template = getAgentTemplate(templateId);
  if (!template) {
    throw new GroupStoreError("invalid-value", `Unknown agent template: ${templateId}`);
  }
  return {
    role: template.role,
    instructions: template.instructions,
    avatarFace: template.avatarFace,
    avatarColor: template.avatarColor,
    ...base,
    name: fields.name?.trim()
      ? fields.name
      : uniqueAgentName(getDatabase(), template.name, groupId),
    templateId: template.id,
  };
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
    for (const member of removed) removeAgentFromGroupRows(groupId, member.sessionId, false);
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
      removedSessionIds: removed.map((member) => member.sessionId),
    };
  });
}

/** Changes only the given fields; `null` clears the model / default Project. */
export function updateAgent(agentId: string, input: UpdateAgentInput): AgentInfo {
  const row = requireAgentRow(agentId);
  getDatabase()
    .prepare(
      `update agents
       set name = ?, role = ?, instructions = ?, model_id = ?, default_workspace_id = ?,
           avatar_face = ?, avatar_color = ?, updated_at = ?
       where id = ?`,
    )
    .run(
      input.name !== undefined ? requireFreeName(input.name, row.group_id, agentId) : row.name,
      input.role !== undefined ? input.role.trim() : row.role,
      input.instructions !== undefined ? input.instructions : row.instructions,
      input.modelId !== undefined ? input.modelId?.trim() || null : row.model_id,
      input.defaultWorkspaceId !== undefined
        ? requireWorkspace(input.defaultWorkspaceId)
        : row.default_workspace_id,
      requireAvatar(input.avatarFace ?? row.avatar_face, AGENT_AVATAR_FACES, "avatar face"),
      requireAvatar(input.avatarColor ?? row.avatar_color, AGENT_AVATAR_COLORS, "avatar color"),
      new Date().toISOString(),
      agentId,
    );
  return toAgent(requireAgentRow(agentId));
}

/**
 * Archive / restore. Membership is untouched: an archived agent stays in its
 * groups but is never woken (the room posts "<name> is archived").
 */
export function setAgentArchived(agentId: string, archived: boolean): AgentInfo {
  requireAgentRow(agentId);
  getDatabase()
    .prepare("update agents set archived_at = ? where id = ?")
    .run(archived ? new Date().toISOString() : null, agentId);
  return toAgent(requireAgentRow(agentId));
}

/**
 * Deletes the agent. For a group agent this IS removing the member (one
 * operation): refused with `group-min-members` when only 2 are left, otherwise
 * the member-removal rules (lead cleared, open tasks released owner-first), its
 * hidden room session deleted and "X left the group" posted, in one
 * transaction. Returns the room session ids: the caller stops their runtime.
 */
export function deleteAgent(agentId: string): string[] {
  const row = requireAgentRow(agentId);
  const membership = getDatabase()
    .prepare("select group_id, session_id from agent_group_members where agent_id = ?")
    .get(agentId) as { group_id: string; session_id: string } | undefined;
  if (membership) {
    return withGroupTransaction(() => {
      removeAgentFromGroupRows(membership.group_id, membership.session_id);
      return [membership.session_id];
    });
  }
  getDatabase().prepare("delete from agents where id = ?").run(row.id);
  return [];
}
