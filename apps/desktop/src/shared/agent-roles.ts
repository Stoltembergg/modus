import { AGENT_TEMPLATES, getAgentTemplate } from "./agent-templates";
import type { GroupMemberCapabilities } from "./group-capabilities";

/*
 * Agent roles. The work an agent handles (capabilityIds + supportedTaskKinds)
 * follows from its role and is never picked by hand: a template agent uses
 * its template's values, any other agent the values of the role its label
 * names, and a label that names no role is Custom. The role is stored as the
 * label text only (agents.role); no role id is persisted.
 */

export type AgentRoleId =
  | "lead"
  | "builder"
  | "reviewer"
  | "explorer"
  | "librarian"
  | "advisor"
  | "designer"
  | "custom";

export type AgentRole = { id: AgentRoleId; label: string; templateId?: string };

/** The seven known roles, each backed by its template, then Custom. */
export const AGENT_ROLES: readonly AgentRole[] = [
  { id: "lead", label: "Lead", templateId: "planner" },
  { id: "builder", label: "Builder", templateId: "builder" },
  { id: "reviewer", label: "Reviewer", templateId: "reviewer" },
  { id: "explorer", label: "Explorer", templateId: "explorer" },
  { id: "librarian", label: "Librarian", templateId: "librarian" },
  { id: "advisor", label: "Advisor", templateId: "oracle" },
  { id: "designer", label: "Designer", templateId: "designer" },
  { id: "custom", label: "Custom" },
];

/** Custom never implements, reviews or takes code tasks. */
export const CUSTOM_ROLE_CAPABILITIES: GroupMemberCapabilities = {
  capabilityIds: ["research", "docs"],
  supportedTaskKinds: ["docs", "research", "question"],
};

function copy(capabilities: GroupMemberCapabilities): GroupMemberCapabilities {
  return {
    capabilityIds: [...capabilities.capabilityIds],
    supportedTaskKinds: [...capabilities.supportedTaskKinds],
  };
}

export function getAgentRole(id: AgentRoleId): AgentRole {
  return AGENT_ROLES.find((role) => role.id === id) ?? (AGENT_ROLES.at(-1) as AgentRole);
}

/** The role's work, read from its template so the two can never drift. */
export function capabilitiesForRole(id: AgentRoleId): GroupMemberCapabilities {
  const template = getAgentTemplate(getAgentRole(id).templateId ?? "");
  return copy(template ?? CUSTOM_ROLE_CAPABILITIES);
}

const key = (text: string) => text.trim().toLocaleLowerCase("en");

/**
 * The role a free-text label names: a role label ("Lead") or its template's
 * name ("Planner"), ignoring case and surrounding spaces. Anything else is Custom.
 */
export function roleIdForLabel(label: string | undefined): AgentRoleId {
  const wanted = key(label ?? "");
  if (!wanted) return "custom";
  for (const role of AGENT_ROLES) {
    if (role.id === "custom") continue;
    const template = AGENT_TEMPLATES.find((t) => t.id === role.templateId);
    if (key(role.label) === wanted || (template && key(template.name) === wanted)) return role.id;
  }
  return "custom";
}

function roleIdForTemplate(templateId: string | undefined): AgentRoleId | undefined {
  if (!templateId) return undefined;
  return AGENT_ROLES.find((role) => role.templateId === templateId)?.id;
}

/** The role an agent's saved lists are derived from: its template, else its label. */
export function derivedRoleId(agent: { role?: string; templateId?: string }): AgentRoleId {
  return roleIdForTemplate(agent.templateId) ?? roleIdForLabel(agent.role);
}

/**
 * The work an agent handles. Saved lists win; an agent saved without them
 * (either list empty, which routing treats as "handles no typed task") gets
 * its derived role's lists, so deriving can only add work, never remove it.
 */
export function effectiveCapabilities(agent: {
  role?: string;
  templateId?: string;
  capabilityIds?: readonly string[];
  supportedTaskKinds?: readonly string[];
}): GroupMemberCapabilities {
  if (agent.capabilityIds?.length && agent.supportedTaskKinds?.length) {
    return {
      capabilityIds: [...agent.capabilityIds],
      supportedTaskKinds: [
        ...agent.supportedTaskKinds,
      ] as GroupMemberCapabilities["supportedTaskKinds"],
    };
  }
  return capabilitiesForRole(derivedRoleId(agent));
}

function sameCapabilities(a: GroupMemberCapabilities, b: GroupMemberCapabilities): boolean {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((value) => y.includes(value));
  return same(a.capabilityIds, b.capabilityIds) && same(a.supportedTaskKinds, b.supportedTaskKinds);
}

/**
 * True when an agent's saved lists match neither the role its label names nor
 * its template: they were picked by hand and a role change replaces them.
 */
export function hasCustomWorkTypes(agent: {
  role?: string;
  templateId?: string;
  capabilityIds: readonly string[];
  supportedTaskKinds: readonly string[];
}): boolean {
  const saved = effectiveCapabilities(agent);
  if (sameCapabilities(saved, capabilitiesForRole(roleIdForLabel(agent.role)))) return false;
  const templateRole = roleIdForTemplate(agent.templateId);
  return !(templateRole && sameCapabilities(saved, capabilitiesForRole(templateRole)));
}

const KIND_WORDS: Record<string, string> = {
  code: "code",
  docs: "docs",
  design: "design",
  review: "review",
  research: "research",
  question: "question",
};
const CAPABILITY_VERBS: Record<string, string> = {
  plan: "plans",
  implement: "implements",
  verify: "verifies",
  review: "reviews",
  research: "researches",
  docs: "writes docs",
};

function list(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** One plain sentence pair, e.g. "Handles code tasks. Implements and verifies." */
export function describeCapabilities(capabilities: GroupMemberCapabilities): string {
  const kinds = capabilities.supportedTaskKinds.flatMap((kind) =>
    KIND_WORDS[kind] ? [KIND_WORDS[kind]] : [],
  );
  const verbs = capabilities.capabilityIds.flatMap((id) =>
    CAPABILITY_VERBS[id] ? [CAPABILITY_VERBS[id]] : [],
  );
  const parts: string[] = [];
  if (kinds.length) parts.push(`Handles ${list(kinds)} tasks.`);
  if (verbs.length) {
    const sentence = list(verbs);
    parts.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
  }
  return parts.join(" ") || "Handles untyped tasks only.";
}
