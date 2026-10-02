import { memo, useMemo } from "react";
import type { QuestionAnswer, QuestionRequest } from "../../../../shared/contracts";
import { QuestionCard, type QuestionSummaryItem } from "../../components/question/QuestionCard";

/**
 * Transcript card for a completed `ask_user` call (Cursor/Codex-style): collapsed
 * it reads "Asked N questions"; expanded it lists each question with the answer
 * the user chose from the structured `question.resolved` event. Thin adapter over
 * the unified Question Tool card in summary mode.
 */

type QuestionToolCardProps = {
  args?: unknown;
  isComplete?: boolean;
  request?: QuestionRequest;
  answers?: QuestionAnswer[];
  skipped?: boolean;
};

type ArgQuestion = {
  id?: string;
  header: string;
  options?: Array<{ label?: string; recommended?: boolean }>;
};

function readQuestions(args: unknown): ArgQuestion[] {
  if (!args || typeof args !== "object") {
    return [];
  }
  const value = (args as { questions?: unknown }).questions;
  return Array.isArray(value) ? (value as ArgQuestion[]) : [];
}

function answerText(answer: QuestionAnswer | undefined): string {
  const parts = [...(answer?.selected ?? [])];
  if (answer?.custom) {
    parts.push(answer.custom);
  }
  return parts.join("; ");
}

function buildQuestionSummary(
  questions: ArgQuestion[],
  answers: QuestionAnswer[] | undefined,
  skipped: boolean | undefined,
): QuestionSummaryItem[] {
  const answersById = new Map((answers ?? []).map((answer) => [answer.questionId, answer]));
  return questions.map((question, index) => {
    const structured = question.id ? answersById.get(question.id) : answers?.[index];
    const answer = skipped ? "Skipped" : answerText(structured);
    const recommended = (question.options ?? []).some(
      (option) =>
        option.recommended === true &&
        option.label != null &&
        structured?.selected.includes(option.label),
    );
    return { id: question.id ?? question.header, header: question.header, answer, recommended };
  });
}

export const QuestionToolCard = memo(function QuestionToolCard({
  args,
  isComplete = false,
  request,
  answers,
  skipped,
}: QuestionToolCardProps) {
  const questions = useMemo(() => request?.questions ?? readQuestions(args), [args, request]);
  const items = useMemo(
    () => buildQuestionSummary(questions, answers, skipped),
    [answers, questions, skipped],
  );
  return <QuestionCard items={items} mode="summary" running={!isComplete} />;
});
