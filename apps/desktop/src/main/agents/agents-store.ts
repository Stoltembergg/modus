import { randomUUID } from "node:crypto";
import { faceForAvatarSeed, normalizeAvatarSeed } from "../../shared/agent-avatar-seeds";
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
  type AgentInfo,
  type AgentSessionInfo,
  CHATS_WORKSPACE_ID,
  type CreateAgentInput,
  type NewGroupAgentInput,
  type UpdateAgentInput,
} from "../../shared/contracts";
import {
  type GroupMemberCapabilities,
  normalizeGroupMemberCapabilities,
} from "../../shared/group-capabilities";
import type { GroupErrorCode } from "../../shared/group-errors";
import { getAgentSession } from "../agent/agent-store";
import { getDatabase, uniqueAgentName } from "../db/database";
import { ensureChatsWorkspace } from "../workspace/workspace-store";

/*
 * Agents (profiles): a name unique among the active profiles
 * (case-insensitive), a persona and defaults. `group_id` is legacy: the
 * Groups → Projects migration cleared it on every agent and nothing sets it
 * again. Errors are GroupStoreError so the `[group-error:<code>]` IPC wire
 * format (toGroupIpcError) and the renderer's messages apply unchanged.
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

/** One write transaction (not nestable). */
function inTransaction<T>(fn: () => T): T {
  const db = getDatabase();
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

/** The 1:1 chat session ids of these agents (A3; kind 'chat', linked by agent_id). */
function agentChatSessionIds(agentIds: readonly string[]): string[] {
  // Writable chats only: read-only (migrated) history is never torn down; deleting
  // the agent just unlinks it (agent_id → null by the FK).
  const select = getDatabase().prepare(
    "select id from agent_sessions where agent_id = ? and kind = 'chat' and read_only = 0",
  );
  return agentIds.flatMap((agentId) =>
    (select.all(agentId) as Array<{ id: string }>).map((row) => row.id),
  );
}

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
  avatar_seed: string | null;
};

const AGENT_COLUMNS = `id, group_id, name, role, instructions, model_id, default_workspace_id,
  avatar_face, avatar_color, avatar_shape, template_id, created_at, updated_at, archived_at, capability_ids_json, supported_task_kinds_json, avatar_seed`;

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
    avatarSeed: row.avatar_seed || null,
    ...(row.template_id !== null ? { templateId: row.template_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
  };
}

/** The stored avatar seed: trimmed, null when absent or blank (never ""), else a bad value. */
export function requireAvatarSeed(value: string | null | undefined): string | null {
  try {
    return normalizeAvatarSeed(value);
  } catch {
    throw new GroupStoreError("invalid-value", "Invalid avatar seed.");
  }
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

/** Another ACTIVE profile holding `name` (archived names are free). */
function nameOwner(name: string): { id: string } | undefined {
  return getDatabase()
    .prepare("select id from agents where name = ? and group_id is null and archived_at is null")
    .get(name) as { id: string } | undefined;
}

/** Max agent name length (the IPC schema's `agentFields.name`). */
export const AGENT_NAME_MAX_LENGTH = 80;

/** "Name n" within AGENT_NAME_MAX_LENGTH: the base is shortened, never the suffix. */
export function suffixedAgentName(base: string, n: number): string {
  const suffix = ` ${n}`;
  return `${base.slice(0, AGENT_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

/** Trimmed, non-empty name that no OTHER active profile has. */
function requireFreeName(name: string, selfId?: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) {
    throw new GroupStoreError("invalid-value", "Agent name must not be empty.");
  }
  const owner = nameOwner(trimmed);
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
    /** A template's default shape (an explicit avatarShape wins). */
    preferredAvatarShape?: AgentAvatarShape;
  };

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

/** Inserts an agent row (a profile: `group_id` null). */
export function createAgent(input: AgentCreateFields): AgentInfo {
  const capabilities = requireCapabilities(input);
  const id = randomUUID();
  const now = new Date().toISOString();
  const avatar = agentAvatarForId(id);
  const avatarShape = requireAvatar(
    input.avatarShape ?? input.preferredAvatarShape ?? avatar.avatarShape,
    AGENT_AVATAR_SHAPES,
    "avatar shape",
  );
  // A picker seed sets the face it stands for, so avatar_face matches the drawn eyes.
  const avatarSeed = requireAvatarSeed(input.avatarSeed);
  const avatarFace = faceForAvatarSeed(avatarSeed) ?? input.avatarFace ?? avatar.avatarFace;
  getDatabase()
    .prepare(
      `insert into agents (${AGENT_COLUMNS}) values (?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)`,
    )
    .run(
      id,
      requireFreeName(input.name),
      (input.role ?? "").trim(),
      input.instructions ?? "",
      input.modelId || null,
      requireWorkspace(input.defaultWorkspaceId ?? null),
      requireAvatar(avatarFace, AGENT_AVATAR_FACES, "avatar face"),
      requireAvatar(input.avatarColor ?? avatar.avatarColor, AGENT_AVATAR_COLORS, "avatar color"),
      avatarShape,
      input.templateId ?? null,
      now,
      now,
      JSON.stringify(capabilities.capabilityIds),
      JSON.stringify(capabilities.supportedTaskKinds),
      avatarSeed,
    );
  return toAgent(requireAgentRow(id));
}

/**
 * The fields of a new agent: a template fills name (next free), role,
 * instructions and avatar; explicit fields win.
 */
function newAgentFields(input: NewGroupAgentInput): AgentCreateFields {
  // A copy never inherits its source's avatar seed; the modal picks it a new
  // face seed (copyAvatarSeed), saved like any other seed.
  const { templateId, copiedFromAgentId, ...fields } = input;
  const base = fields;
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
    name: fields.name?.trim() ? fields.name : uniqueAgentName(getDatabase(), template.name),
    templateId: template.id,
  };
}

/**
 * `agents:create` without a group: a standalone profile (no membership, no
 * room session). Its name must be free among the active groupless profiles;
 * `defaultWorkspaceId` is where its chats open (else No project).
 */
export function createProfile(input: NewGroupAgentInput): AgentInfo {
  return createAgent(newAgentFields(input));
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
  return createAgent(
    newAgentFields({
      templateId,
      name: overrides.name ?? "",
      ...(overrides.defaultWorkspaceId !== undefined
        ? { defaultWorkspaceId: overrides.defaultWorkspaceId }
        : {}),
    }),
  );
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
  // avatarSeed absent: seed and face stay as stored. A seed: stored, and a
  // picker seed sets its face. null / blank: cleared, so the avatar is drawn
  // with the id again and the face falls back to the id-derived one.
  const avatarSeed =
    input.avatarSeed !== undefined ? requireAvatarSeed(input.avatarSeed) : row.avatar_seed;
  const avatarFace =
    input.avatarSeed === undefined
      ? (input.avatarFace ?? row.avatar_face)
      : (faceForAvatarSeed(avatarSeed) ??
        input.avatarFace ??
        (avatarSeed === null ? agentAvatarForId(agentId).avatarFace : row.avatar_face));
  getDatabase()
    .prepare(
      `update agents
       set name = ?, role = ?, instructions = ?, model_id = ?, default_workspace_id = ?,
           avatar_face = ?, avatar_color = ?, avatar_shape = ?, avatar_seed = ?, updated_at = ?, capability_ids_json = ?, supported_task_kinds_json = ?
       where id = ?`,
    )
    .run(
      input.name !== undefined ? requireFreeName(input.name, agentId) : row.name,
      input.role !== undefined ? input.role.trim() : row.role,
      input.instructions !== undefined ? input.instructions : row.instructions,
      nextModelId,
      input.defaultWorkspaceId !== undefined
        ? requireWorkspace(input.defaultWorkspaceId)
        : row.default_workspace_id,
      requireAvatar(avatarFace, AGENT_AVATAR_FACES, "avatar face"),
      requireAvatar(input.avatarColor ?? row.avatar_color, AGENT_AVATAR_COLORS, "avatar color"),
      avatarShape,
      avatarSeed,
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
  // Edit agent Model must rebind the agent's 1:1 chats. Otherwise the next
  // turn keeps the model stamped at create time.
  if (input.modelId !== undefined) {
    rebindAgentSessionModels(agentId, nextModelId);
  }
  return toAgent(requireAgentRow(agentId));
}

/**
 * Stamp `model` onto the agent's 1:1 chats so the next prompt
 * (and any resume) picks up an Edit-agent model change without a restart.
 */
function rebindAgentSessionModels(agentId: string, modelId: string | null): void {
  const db = getDatabase();
  const sessionIds = agentChatSessionIds([agentId]);
  if (sessionIds.length === 0) return;
  const update = db.prepare("update agent_sessions set model = ? where id = ?");
  for (const sessionId of sessionIds) {
    update.run(modelId, sessionId);
  }
}

/** Archive / restore. */
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
  if (row.group_id === null && nameOwner(name) !== undefined) {
    let n = 2;
    while (nameOwner(suffixedAgentName(row.name, n)) !== undefined) n += 1;
    name = suffixedAgentName(row.name, n);
  }
  inTransaction(() => {
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
 * Deletes the agent in one transaction. Returns its writable 1:1 chat ids,
 * still on disk: the caller tears them down after the commit
 * (agents/agent-teardown). Read-only (migrated) history is only unlinked, and
 * any legacy group membership row cascades with the agent.
 */
export function deleteAgent(agentId: string): string[] {
  const row = requireAgentRow(agentId);
  return inTransaction(() => {
    const chatIds = agentChatSessionIds([row.id]);
    getDatabase().prepare("delete from agents where id = ?").run(row.id);
    return chatIds;
  });
}

/**
 * The agent's chat: its MOST RECENT WRITABLE `chat` (read_only = 0), else a
 * new one. A new chat opens in the agent's `default_workspace_id`; without
 * one it opens in No project (the Chats inbox).
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
