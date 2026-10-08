import type { TaskClassificationInput } from "../../../../shared/contracts";
import { evaluateIntentGate } from "../intent-gate";
import { classifyHarnessTask } from "../task-classifier";
import type {
  HarnessContext,
  HarnessHook,
  TurnStartInput,
  TurnStartOutput,
} from "./harness-hooks";

/**
 * Standard Turn Start Hook:
 * Evaluates the user's message using IntentGate and TaskClassifier:
 * - Records task classification and intent gate result in context.state
 * - Does NOT abort turn for clarify/confirm: leaves interactive question handling
 *   and session exclusions to the runtime pipeline
 */
export const turnStartIntentHook: HarnessHook<TurnStartInput, TurnStartOutput> = {
  name: "turn_start_intent_classifier",
  phase: "turn_start",
  priority: 10,
  isCritical: true,
  execute: async (
    input: TurnStartInput,
    context: HarnessContext
  ): Promise<TurnStartOutput> => {
    const messageText = input.message ?? input.userPrompt ?? "";
    const contextPaths = (input.context || [])
      .map((c: any) => c.path || c.uri || "")
      .filter(Boolean);

    if (input.contextPaths) {
      contextPaths.push(...input.contextPaths);
    }

    const classificationInput: TaskClassificationInput = {
      text: messageText,
      mode: input.mode ?? context.mode ?? "build",
      contextPaths,
      changedPaths: [],
      hasDestructiveAction: false,
    };

    const classification = classifyHarnessTask(classificationInput);
    const gateResult = evaluateIntentGate(classificationInput);

    // Save classification in context state for downstream hooks
    context.state.set("task_classification", classification);
    context.state.set("intent_gate_result", gateResult);

    return {
      proceed: true,
      classification,
      gateResult,
      effectiveMessage: messageText,
    };
  },
};
