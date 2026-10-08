import type { agentPromptSchema } from "../ipc/schemas";
import type { PromptAgentInput } from "./runtime";

/**
 * Which model a user turn (1:1) or a group-room turn runs on.
 *
 * A stored session or agent choice is authoritative. The app default is considered only
 * when no choice exists; if that choice is unavailable, fail without substituting a model.
 * The renderer's model and thinking fields remain untrusted and are deliberately ignored.
 */
export const NO_DEFAULT_MODEL_MESSAGE =
  "No model is configured. Connect a provider in Settings first.";
export type TurnModelDeps = {
  /** Explicit Settings default, or a derived default when none was configured. */
  defaultModelId(): string | undefined;
  /** Listed, enabled, available, and not a locked model. */
  isUsable(modelId: string): boolean;
};

/** `candidate`: the session's stored model (1:1), or the agent's model (group). */
export function resolveTurnModel(
  candidate: string | null | undefined,
  deps: TurnModelDeps,
): string {
  const selected =
    candidate === undefined || candidate === null || candidate === ""
      ? deps.defaultModelId()
      : candidate;
  if (selected === undefined || selected === "") {
    throw new Error(NO_DEFAULT_MODEL_MESSAGE);
  }
  if (!deps.isUsable(selected)) {
    throw new Error(`Selected model is unavailable: ${selected}`);
  }
  return selected;
}

/** Resolve a persisted selection without applying defaults before session restoration. */
export function resolveExplicitTurnModel(
  candidate: string | null | undefined,
  deps: TurnModelDeps,
): string | undefined {
  if (candidate === undefined || candidate === null || candidate === "") return undefined;
  return resolveTurnModel(candidate, deps);
}

type ParsedPrompt = ReturnType<(typeof agentPromptSchema)["parse"]>;

/** agent:prompt payload -> runtime input; an absent model stays unset for session restoration. */
export function userTurnPromptInput(
  parsed: ParsedPrompt,
  turnModelId: string | null | undefined,
): PromptAgentInput {
  return {
    sessionId: parsed.sessionId,
    message: parsed.message,
    context: parsed.context ?? [],
    ...(parsed.delivery !== undefined ? { delivery: parsed.delivery } : {}),
    ...(parsed.userMessageId !== undefined ? { userMessageId: parsed.userMessageId } : {}),
    ...(parsed.attachments !== undefined ? { attachments: parsed.attachments } : {}),
    ...(parsed.skills !== undefined ? { skills: parsed.skills } : {}),
    ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
    // parsed.model / thinkingLevel / thinkingVariant are deliberately dropped.
    ...(turnModelId ? { model: turnModelId } : {}),
    ...(parsed.planId !== undefined ? { planId: parsed.planId } : {}),
  };
}
