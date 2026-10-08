import type {
  HarnessContext,
  HarnessHook,
  ModelSelectInput,
  ModelSelectOutput,
} from "./harness-hooks";

/**
 * Standard Model Select Hook:
 * Dynamically adjusts thinking variant and model parameters based on task complexity.
 */
export const modelSelectHook: HarnessHook<ModelSelectInput, ModelSelectOutput> = {
  name: "model_select_thinking_budget",
  phase: "model_select",
  priority: 10,
  isCritical: false,
  execute: async (input: ModelSelectInput, context: HarnessContext): Promise<ModelSelectOutput> => {
    const classification = input.taskComplexity
      ? { complexity: input.taskComplexity, risk: "low" }
      : input.taskClassification || (context.state.get("task_classification") as any);

    let thinkingBudget = input.requestedThinking ?? 4096;
    let thinkingLevel: "low" | "medium" | "high" = "medium";

    if (classification) {
      if (classification.complexity === "complex" || classification.risk === "high") {
        thinkingLevel = "high";
        thinkingBudget = 16384;
      } else if (classification.complexity === "simple" && classification.risk === "low") {
        thinkingLevel = "low";
        thinkingBudget = 2048;
      }
    }

    const effectiveModel = input.requestedModel || "default";

    return {
      selectedModel: effectiveModel,
      effectiveModel,
      thinkingBudget,
      provider: "openrouter",
      thinkingLevel,
      maxTokens: thinkingLevel === "high" ? 16384 : 8192,
    };
  },
};
