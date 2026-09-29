import { GROUP_ERROR_MESSAGES } from "../groups/groupErrors";

export const AGENT_NAME_REQUIRED = "Give the agent a name.";

export type AgentDialogDraft = {
  name: string;
  role: string;
  instructions: string;
  modelId: string;
};

export type AgentDialogContext = {
  /** A custom agent (`template_id` null): name AND model are required (A2 rule). */
  custom: boolean;
  /** The other members' names in the group (the name is unique per group, case-insensitive). */
  takenNames: readonly string[];
  /** Models of configured providers. */
  availableModelIds: readonly string[];
  /** The agent's saved model (edit): kept as-is even if its provider went away. */
  savedModelId?: string | undefined;
};

/**
 * First blocking problem of the draft, or null. Same rules as the IPC
 * (`agent-name-taken`, `agent-model-required`, `agent-model-unavailable`), so
 * the dialog can say it before the round trip; the IPC error still wins.
 */
export function agentDialogError(
  draft: AgentDialogDraft,
  context: AgentDialogContext,
): string | null {
  const name = draft.name.trim();
  if (!name) return AGENT_NAME_REQUIRED;
  const key = name.toLocaleLowerCase();
  if (context.takenNames.some((taken) => taken.trim().toLocaleLowerCase() === key)) {
    return GROUP_ERROR_MESSAGES["agent-name-taken"];
  }
  const modelId = draft.modelId.trim();
  if (context.custom && !modelId) return GROUP_ERROR_MESSAGES["agent-model-required"];
  if (modelId && modelId !== context.savedModelId && !context.availableModelIds.includes(modelId)) {
    return GROUP_ERROR_MESSAGES["agent-model-unavailable"];
  }
  return null;
}

/** Create of a custom agent with no role and no instructions: generate them first. */
export function needsProfileGeneration(
  draft: Pick<AgentDialogDraft, "role" | "instructions">,
  custom: boolean,
): boolean {
  return custom && !draft.role.trim() && !draft.instructions.trim();
}
