import { modusText } from "../../shared/modus-text";
import type { agentPromptSchema } from "../ipc/schemas";
import { MODUS_PROVIDER_ID } from "./providers/modus-router-adapter";
import type { PromptAgentInput } from "./runtime";

/**
 * Which model a user turn (1:1) or a group-room turn runs on.
 *
 * L2 (Grok, 2026-10-04): there is no model / effort picker in the Composer; thinking /
 * effort is never taken from the renderer (the model's own model_configs apply), and the
 * model the renderer sends is ignored.
 *
 * L3b (Grok 01:03 / 01:30 BRT, replaces L2b decision #2 "Settings default for every session"):
 * - a session / agent on the Modus provider (`modus/...`) is FORCED to the Modus turn model:
 *   the user's Settings default if it is an allowed Modus model, else the plan default from
 *   /v1/models (getModusTurnModelId). No usable Modus model → the turn is refused with the
 *   Modus-unavailable copy; it never silently moves to the user's own key.
 * - a session / agent on its own provider (BYOK) keeps its model. A 1:1 session whose stored
 *   model is no longer usable falls back to the Settings default (so it is never stuck); a
 *   group agent's explicit model is passed as-is (its runtime reports an unavailable model,
 *   as before).
 * - no stored model (new session, template agent on the app default) → the Settings default,
 *   with the Modus rule applied when that default is a Modus model.
 * The desktop always sends an explicit model id to the router (see l3b-pr-body.md).
 */
export const NO_DEFAULT_MODEL_MESSAGE =
  "No model is configured. Connect a provider in Settings first.";
export const MODUS_UNAVAILABLE_MESSAGE = modusText("modus.unavailable");

export function isModusModelId(modelId: string | null | undefined): boolean {
  return typeof modelId === "string" && modelId.startsWith(`${MODUS_PROVIDER_ID}/`);
}

export type TurnModelDeps = {
  /** Settings default (model-service getDefaultModelId, with its fallback). */
  defaultModelId(): string | undefined;
  /** model-service getModusTurnModelId. */
  modusTurnModelId(): string | undefined;
  /** Listed, enabled and not a locked Modus model. */
  isUsable(modelId: string): boolean;
};

function modusTurn(deps: TurnModelDeps): string {
  const model = deps.modusTurnModelId();
  if (!model) throw new Error(MODUS_UNAVAILABLE_MESSAGE);
  return model;
}

/**
 * `candidate`: the session's stored model (1:1), or the agent's model / its session's model
 * (group). `keepUnusable`: pass a non-Modus candidate through even when not listed.
 */
export function resolveTurnModel(
  candidate: string | null | undefined,
  deps: TurnModelDeps,
  options: { keepUnusable?: boolean } = {},
): string {
  const base = candidate?.trim() || deps.defaultModelId();
  if (!base) throw new Error(NO_DEFAULT_MODEL_MESSAGE);
  if (isModusModelId(base)) return modusTurn(deps);
  if (options.keepUnusable || deps.isUsable(base)) return base;
  const fallback = deps.defaultModelId();
  if (!fallback) throw new Error(NO_DEFAULT_MODEL_MESSAGE);
  return isModusModelId(fallback) ? modusTurn(deps) : fallback;
}

type ParsedPrompt = ReturnType<(typeof agentPromptSchema)["parse"]>;

/** agent:prompt payload -> runtime input, on `turnModelId` (resolveTurnModel). */
export function userTurnPromptInput(
  parsed: ParsedPrompt,
  turnModelId: string | undefined,
): PromptAgentInput {
  if (!turnModelId) throw new Error(NO_DEFAULT_MODEL_MESSAGE);
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
    model: turnModelId,
    ...(parsed.planId !== undefined ? { planId: parsed.planId } : {}),
  };
}
