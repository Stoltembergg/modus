import type { agentPromptSchema } from "../ipc/schemas";
import type { PromptAgentInput } from "./runtime";

/**
 * L2 (Grok, 2026-10-04): there is no model / effort picker in the Composer, so every
 * user turn runs on the CURRENT Settings default model. Whatever model the renderer sends,
 * and the model stored on an old session, are ignored for runs: otherwise an old (or no
 * longer allowed) session model would be stuck forever with no way to leave it. Thinking /
 * effort is never taken from the renderer either: the runtime applies the default model's
 * own configured thinking (model_configs).
 */
export const NO_DEFAULT_MODEL_MESSAGE =
  "No model is configured. Connect a provider in Settings first.";

type ParsedPrompt = ReturnType<(typeof agentPromptSchema)["parse"]>;

/** agent:prompt payload -> runtime input, with the model forced to the Settings default. */
export function userTurnPromptInput(
  parsed: ParsedPrompt,
  defaultModelId: string | undefined,
): PromptAgentInput {
  if (!defaultModelId) throw new Error(NO_DEFAULT_MODEL_MESSAGE);
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
    model: defaultModelId,
    ...(parsed.planId !== undefined ? { planId: parsed.planId } : {}),
  };
}
