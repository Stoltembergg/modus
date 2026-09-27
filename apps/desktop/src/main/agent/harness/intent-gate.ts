import type { QuestionPrompt, TaskClassificationInput } from "../../../shared/contracts";
import { classifyHarnessTask } from "./task-classifier";

export type IntentGateResult =
  | { action: "proceed" }
  | {
      action: "suggest_plan";
      classification: ReturnType<typeof classifyHarnessTask>;
    }
  | { action: "clarify"; question: QuestionPrompt; default: string }
  | { action: "confirm"; question: QuestionPrompt };

const CLARIFY_DEFAULT = "Use a conservative default and proceed.";
const ACTION_CLAUSE_BOUNDARY = String.raw`(?:^|[.!?;:]\s*|,\s*(?:and\s+)?then\s+|\bthen\s+)`;
const DIRECT_REQUEST_PREFIX = String.raw`(?:(?:please|can you|could you|i want you to|i want to|we need to)\s+)*`;
const DESTRUCTIVE_VERB = `(?:delete|remove|drop|wipe|erase|destroy|truncate|overwrite)`;
const CONSEQUENTIAL_DATA_TARGET = String.raw`(?:(?:the|all|my|our|these|those)\s+)*(?:(?:production|prod|live)\s+)?(?:database|db|data|records?|accounts?|customer\s+accounts?|user\s+accounts?|[a-z][a-z0-9_-]*\s+tables?)`;
const DIRECT_DESTRUCTIVE_EFFECT = new RegExp(
  `${ACTION_CLAUSE_BOUNDARY}${DIRECT_REQUEST_PREFIX}${DESTRUCTIVE_VERB}\\s+${CONSEQUENTIAL_DATA_TARGET}\\b`,
  "i",
);

function hasMaterialAmbiguity(text: string): boolean {
  if (/^\s*(?:explain|discuss|review|analyze|describe)\s+(?:whether|if)\b/i.test(text)) {
    return false;
  }
  return /\b(which|whether|should i|do you mean|not sure|unclear|ambiguous|help me choose)\b/i.test(
    text,
  );
}

function clarificationQuestion(): QuestionPrompt {
  return {
    id: "intent-clarification",
    header: "What requirement or target should guide this task?",
    detail: "Type a brief answer, choose the conservative default, or cancel this turn.",
    multiSelect: false,
    options: [
      { label: "Use a conservative default", recommended: true },
      { label: "Cancel this turn" },
    ],
  };
}

function confirmationQuestion(): QuestionPrompt {
  return {
    id: "intent-confirmation",
    header: "Confirm consequential action",
    detail: "This request may have consequential effects. Confirm before the agent proceeds.",
    multiSelect: false,
    options: [{ label: "Proceed" }, { label: "Cancel", recommended: true }],
  };
}

export function evaluateIntentGate(input: TaskClassificationInput): IntentGateResult {
  const classification = classifyHarnessTask(input);
  const directDestructiveEffect =
    input.mode === "build" &&
    (input.hasDestructiveAction === true || DIRECT_DESTRUCTIVE_EFFECT.test(input.text));
  if (directDestructiveEffect) {
    return { action: "confirm", question: confirmationQuestion() };
  }
  if (hasMaterialAmbiguity(input.text)) {
    return { action: "clarify", question: clarificationQuestion(), default: CLARIFY_DEFAULT };
  }
  if (classification.complexity === "complex") {
    return { action: "suggest_plan", classification };
  }
  return { action: "proceed" };
}
