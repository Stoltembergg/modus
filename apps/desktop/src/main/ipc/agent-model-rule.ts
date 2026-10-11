import { encodeGroupErrorMessage } from "../../shared/group-errors";

/**
 * The model rule for agents WITHOUT a template, checked by IPC on create and
 * update only (stored rows are never rewritten): a model is required
 * (`agent-model-required`) and, when the payload sets it, it must belong to a
 * configured provider (`agent-model-unavailable`). Template agents are exempt
 * (the app default model applies).
 */
export function requireAgentModel(
  isModelAvailable: (modelId: string) => boolean,
  agent: { templateId?: string | null | undefined; modelId?: string | null | undefined },
  changed = true,
): void {
  if (agent.templateId) return;
  const id = agent.modelId;
  if (!id) {
    throw new Error(
      encodeGroupErrorMessage("agent-model-required", "Choose a model for this agent."),
    );
  }
  if (changed && !isModelAvailable(id)) {
    throw new Error(
      encodeGroupErrorMessage("agent-model-unavailable", `Model not available: ${id}`),
    );
  }
}
