import type { AgentTemplate } from "../../../../shared/agent-templates";
import type {
  AgentAvatarColor,
  AgentAvatarFace,
  AgentInfo,
  CreateAgentGroupInput,
  NewGroupAgentInput,
} from "../../../../shared/contracts";
import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from "../../../../shared/group-blocked";

/*
 * The create-group modal (A4), pure part: the member list the user builds
 * from template cards, copies of other groups' agents and new custom agents,
 * the Lead, the footer rules and the ONE `group:create` payload.
 */

/** Where a member of the modal came from (only a template carries `templateId`). */
export type NewGroupMemberSource = "template" | "copy" | "custom";

export type NewGroupMember = {
  /** Stable key in the modal (the Lead points at it; names are editable). */
  key: string;
  source: NewGroupMemberSource;
  templateId?: string;
  name: string;
  role: string;
  instructions: string;
  /** "" = the app default model (templates only; copies and custom agents need one). */
  modelId: string;
  avatarFace: AgentAvatarFace;
  avatarColor: AgentAvatarColor;
};

/** Group name used when the name field is left empty. */
export const NEW_GROUP_DEFAULT_NAME = "New group";

export const NEW_GROUP_HINTS = {
  folder: "Choose a folder for the group.",
  min: `A group needs at least ${GROUP_MIN_MEMBERS} agents.`,
  max: `A group can have at most ${GROUP_MAX_MEMBERS} agents.`,
  names: "Each agent needs a different name.",
  emptyName: "Every agent needs a name.",
  model: "Choose a model for every agent that isn't from a template.",
} as const;

const nameKey = (name: string) => name.trim().toLocaleLowerCase();

/** `base` when free in `taken` (case-insensitive), else "base 2", "base 3"… */
export function nextFreeName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map(nameKey));
  const clean = base.trim() || "Agent";
  if (!used.has(nameKey(clean))) return clean;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${clean} ${suffix}`;
    if (!used.has(nameKey(candidate))) return candidate;
  }
}

/** A template card picked (or picked again: "Builder 2"). */
export function templateMember(
  template: AgentTemplate,
  members: readonly NewGroupMember[],
  key: string,
): NewGroupMember {
  return {
    key,
    source: "template",
    templateId: template.id,
    name: nextFreeName(
      template.name,
      members.map((member) => member.name),
    ),
    role: template.role,
    instructions: template.instructions,
    modelId: "",
    avatarFace: template.avatarFace,
    avatarColor: template.avatarColor,
  };
}

/**
 * "Copy from another group": an independent copy (name, role, instructions,
 * model, face, color) that becomes a normal member: no templateId, no
 * history, a new agent. A copied template agent on the app default (null)
 * takes `fallbackModelId`, because a member without a template needs a model.
 */
export function copyMember(
  agent: Pick<
    AgentInfo,
    "name" | "role" | "instructions" | "modelId" | "avatarFace" | "avatarColor"
  >,
  members: readonly NewGroupMember[],
  key: string,
  fallbackModelId = "",
): NewGroupMember {
  return {
    key,
    source: "copy",
    name: nextFreeName(
      agent.name,
      members.map((member) => member.name),
    ),
    role: agent.role,
    instructions: agent.instructions,
    modelId: agent.modelId ?? fallbackModelId,
    avatarFace: agent.avatarFace,
    avatarColor: agent.avatarColor,
  };
}

/** A member from the agent dialog (Customize on a card, or New agent). */
export function dialogMember(
  input: NewGroupAgentInput,
  members: readonly NewGroupMember[],
  key: string,
  fallback: { avatarFace: AgentAvatarFace; avatarColor: AgentAvatarColor },
): NewGroupMember {
  return {
    key,
    source: input.templateId ? "template" : "custom",
    ...(input.templateId ? { templateId: input.templateId } : {}),
    name: nextFreeName(
      input.name,
      members.map((member) => member.name),
    ),
    role: input.role ?? "",
    instructions: input.instructions ?? "",
    modelId: input.modelId ?? "",
    avatarFace: input.avatarFace ?? fallback.avatarFace,
    avatarColor: input.avatarColor ?? fallback.avatarColor,
  };
}

/** The footer counter: "N/10". */
export function newGroupCounter(count: number): string {
  return `${count}/${GROUP_MAX_MEMBERS}`;
}

/**
 * Why "Create" is disabled (first reason), or null. The folder and the
 * 2..10 count come first; names and models mirror the IPC rules so the user
 * sees them before the round trip (the IPC error still wins, shown inline).
 */
export function newGroupBlocker(state: {
  workspaceId: string;
  members: readonly NewGroupMember[];
}): string | null {
  if (!state.workspaceId) return NEW_GROUP_HINTS.folder;
  const count = state.members.length;
  if (count < GROUP_MIN_MEMBERS) return NEW_GROUP_HINTS.min;
  if (count > GROUP_MAX_MEMBERS) return NEW_GROUP_HINTS.max;
  if (state.members.some((member) => !member.name.trim())) return NEW_GROUP_HINTS.emptyName;
  const keys = state.members.map((member) => nameKey(member.name));
  if (new Set(keys).size !== keys.length) return NEW_GROUP_HINTS.names;
  if (state.members.some((member) => !member.templateId && !member.modelId.trim())) {
    return NEW_GROUP_HINTS.model;
  }
  return null;
}

/** One member of the `group:create` payload. */
export function newGroupMemberInput(member: NewGroupMember): NewGroupAgentInput {
  const modelId = member.modelId.trim();
  return {
    ...(member.templateId ? { templateId: member.templateId } : {}),
    name: member.name.trim(),
    role: member.role.trim(),
    instructions: member.instructions,
    ...(modelId ? { modelId } : {}),
    avatarFace: member.avatarFace,
    avatarColor: member.avatarColor,
  };
}

/** The ONE `group:create` payload: members in order, the Lead by its final name. */
export function newGroupCreateInput(state: {
  name: string;
  workspaceId: string;
  members: readonly NewGroupMember[];
  leadKey: string | null;
}): CreateAgentGroupInput {
  const lead = state.members.find((member) => member.key === state.leadKey);
  return {
    name: state.name.trim() || NEW_GROUP_DEFAULT_NAME,
    workspaceId: state.workspaceId,
    members: state.members.map(newGroupMemberInput),
    ...(lead ? { leadName: lead.name.trim() } : {}),
  };
}
