import { randomUUID } from "node:crypto";
import { agentAvatarForId, getAgentTemplate } from "../../shared/agent-templates";
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_FACES,
  type AgentAvatarColor,
  type AgentAvatarFace,
  type AgentInfo,
  type CreateAgentInput,
  type UpdateAgentInput,
} from "../../shared/contracts";
import { getDatabase, uniqueAgentName } from "../db/database";
import { detachSessionFromGroupRows, GroupStoreError } from "../groups/group-store";

/*
 * Agents (agents model, A1): independent entities with a unique name
 * (case-insensitive), a persona and defaults. Plain function module like
 * group-store; errors are GroupStoreError so the group IPC error wire format
 * (and the renderer's messages) apply unchanged.
 */

type AgentRow = {
  id: string;
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

const AGENT_COLUMNS = `id, name, role, instructions, model_id, default_workspace_id,
  avatar_face, avatar_color, template_id, created_at, updated_at, archived_at`;

function toAgent(row: AgentRow): AgentInfo {
  return {
    id: row.id,
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

/** Trimmed, non-empty name that no OTHER agent has (case-insensitive). */
function requireFreeName(name: string, selfId?: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) {
    throw new GroupStoreError("invalid-value", "Agent name must not be empty.");
  }
  const owner = getDatabase().prepare("select id from agents where name = ?").get(trimmed) as
    | { id: string }
    | undefined;
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

export function createAgent(input: CreateAgentInput & { templateId?: string }): AgentInfo {
  const id = randomUUID();
  const now = new Date().toISOString();
  const avatar = agentAvatarForId(id);
  getDatabase()
    .prepare(`insert into agents (${AGENT_COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)`)
    .run(
      id,
      requireFreeName(input.name),
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
 * Picking a template: creates an editable copy (name, role, instructions and
 * avatar copied, `template_id` set, app-default model). A taken name gets the
 * next free suffix ("Planner 2"); `overrides.name` is used as given.
 */
export function createAgentFromTemplate(
  templateId: string,
  overrides: { name?: string; defaultWorkspaceId?: string | null } = {},
): AgentInfo {
  const template = getAgentTemplate(templateId);
  if (!template) {
    throw new GroupStoreError("invalid-value", `Unknown agent template: ${templateId}`);
  }
  return createAgent({
    name: overrides.name ?? uniqueAgentName(getDatabase(), template.name),
    role: template.role,
    instructions: template.instructions,
    avatarFace: template.avatarFace,
    avatarColor: template.avatarColor,
    templateId: template.id,
    ...(overrides.defaultWorkspaceId !== undefined
      ? { defaultWorkspaceId: overrides.defaultWorkspaceId }
      : {}),
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
      input.name !== undefined ? requireFreeName(input.name, agentId) : row.name,
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
 * groups (the room's no-wake / "is archived" behaviour is A2).
 */
export function setAgentArchived(agentId: string, archived: boolean): AgentInfo {
  requireAgentRow(agentId);
  getDatabase()
    .prepare("update agents set archived_at = ? where id = ?")
    .run(archived ? new Date().toISOString() : null, agentId);
  return toAgent(requireAgentRow(agentId));
}

/**
 * Deletes the agent and, in the same transaction, takes it out of every group
 * through the member-removal path (lead cleared, open tasks released
 * owner-first). The member session is kept: until A2 it is still a normal chat.
 */
export function deleteAgent(agentId: string): void {
  requireAgentRow(agentId);
  const db = getDatabase();
  db.exec("begin");
  try {
    const sessions = db
      .prepare("select session_id from agent_group_members where agent_id = ?")
      .all(agentId) as Array<{ session_id: string }>;
    for (const { session_id } of sessions) detachSessionFromGroupRows(session_id);
    db.prepare("delete from agents where id = ?").run(agentId);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
