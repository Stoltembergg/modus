import { isFeatureFlagEnabled } from "../feature-flags";
import type {
  HarnessContext,
  HarnessHook,
  PromptBuildInput,
  PromptBuildOutput,
  TurnSettleInput,
  TurnSettleOutput,
} from "../kernel/harness-hooks";
import { formatResponse } from "./response-formatter";
import {
  DEFAULT_RESPONSE_LEVEL,
  RESPONSE_POLICY_PROMPTS,
  type ResponseLevel,
  type resolveResponsePolicy,
} from "./response-policy";
import { ResponsePolicyRegistry } from "./response-registry";

/**
 * Hook for `prompt_build` phase: injects active Response Policy instructions
 * into the model's system prompt context.
 */
export const defaultPromptBuildResponsePolicyHook: HarnessHook<
  PromptBuildInput,
  PromptBuildOutput
> = {
  name: "response-policy-prompt-build",
  phase: "prompt_build",
  priority: 45, // After core persona/context, before model select
  execute: async (input: PromptBuildInput, context: HarnessContext): Promise<PromptBuildOutput> => {
    const existingSections = (input.systemSections ?? []).map((s) => ({
      id: s.id,
      content: s.content,
      volatile: s.volatile ?? false,
    }));

    // Fail-open pass-through if feature flag is disabled
    if (!isFeatureFlagEnabled("MODUS_RESPONSE_POLICY")) {
      return {
        finalSystemPrompt: input.basePrompt,
        activePromptSections: existingSections,
      };
    }

    try {
      const registry = ResponsePolicyRegistry.getInstance();
      const policy = registry.getSessionPolicy(context.sessionId);

      // Check context state override if specified
      const stateLevel = context.state.get("responsePolicy") as ResponseLevel | undefined;
      const effectiveLevel = stateLevel ?? policy.level ?? DEFAULT_RESPONSE_LEVEL;
      const policyPrompt =
        RESPONSE_POLICY_PROMPTS[effectiveLevel] ?? RESPONSE_POLICY_PROMPTS[DEFAULT_RESPONSE_LEVEL];

      context.state.set("harness.response_policy_prompt", policyPrompt);
      context.state.set("harness.response_policy", policy);

      const base = input.basePrompt ?? "";
      const updatedPrompt = base ? `${base}\n\n${policyPrompt}` : policyPrompt;

      const activeSections = [...existingSections];
      if (!activeSections.some((s) => s.id === "response_policy")) {
        activeSections.push({
          id: "response_policy",
          content: policyPrompt,
          volatile: false,
        });
      }

      return {
        finalSystemPrompt: updatedPrompt,
        activePromptSections: activeSections,
      };
    } catch (error) {
      console.warn("[modus-response] failed to inject response policy prompt (fail-open):", error);
      return {
        finalSystemPrompt: input.basePrompt,
        activePromptSections: existingSections,
      };
    }
  },
};

/**
 * Hook for `turn_settle` phase: inspects the final assistant output, evaluates policy
 * compliance, records metrics, and formats responses when strict mode is active.
 */
export const defaultTurnSettleResponsePolicyHook: HarnessHook<TurnSettleInput, TurnSettleOutput> = {
  name: "response-policy-turn-settle",
  phase: "turn_settle",
  priority: 40,
  execute: async (input: TurnSettleInput, context: HarnessContext): Promise<TurnSettleOutput> => {
    // Fail-open pass-through if feature flag is disabled
    if (!isFeatureFlagEnabled("MODUS_RESPONSE_POLICY")) {
      return { settled: true, triggerContinuation: false };
    }

    try {
      const registry = ResponsePolicyRegistry.getInstance();
      const policy =
        (context.state.get("harness.response_policy") as ReturnType<
          typeof resolveResponsePolicy
        >) ?? registry.getSessionPolicy(context.sessionId);

      const rawResponse = context.state.get("harness.assistant_response") as string | undefined;

      if (rawResponse && rawResponse.trim().length > 0) {
        const deliverables = context.state.get("harness.deliverables");
        const formatted = formatResponse({
          message: rawResponse,
          policy,
          deliverables: Array.isArray(deliverables) ? deliverables : undefined,
        });

        registry.recordEvaluation({
          violated: formatted.violated,
          formatted: policy.enforcementMode === "strict" && formatted.violated,
          charsBefore: rawResponse.length,
          charsAfter: formatted.response.length,
        });

        context.state.set("harness.formatted_response", formatted.response);
        context.state.set("harness.response_violated", formatted.violated);
        if (formatted.reason) {
          context.state.set("harness.response_violation_reason", formatted.reason);
        }
      }

      return { settled: true, triggerContinuation: false };
    } catch (error) {
      console.warn(
        "[modus-response] turn_settle response policy evaluation failed (fail-open):",
        error,
      );
      return { settled: true, triggerContinuation: false };
    }
  },
};
