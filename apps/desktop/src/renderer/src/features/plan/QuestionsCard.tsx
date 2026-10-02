import type { QuestionAnswer, QuestionRequest } from "../../../../shared/contracts";
import { QuestionCard } from "../../components/question/QuestionCard";

/**
 * "Questions" card shown above the composer when the agent calls `ask_user`.
 * Thin adapter over the unified Question Tool card (components/question):
 * numbered options with a moveable keyboard cursor, an always-present
 * free-text row and a Dismiss/Submit footer. It paginates across questions and
 * resolves the blocked run via onSubmit (answers) or onSkip; a promise returned
 * by either that rejects re-enables the card.
 */
export function QuestionsCard({
  request,
  onSubmit,
  onSkip,
}: {
  request: QuestionRequest;
  onSubmit: (answers: QuestionAnswer[]) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
}) {
  return (
    <QuestionCard
      mode="question"
      onSkip={onSkip}
      onSubmit={onSubmit}
      questions={request.questions}
    />
  );
}
