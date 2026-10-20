import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  QuestionAnswer,
  QuestionPrompt,
  QuestionRequest,
  QuestionResponse,
} from "../../shared/contracts";
import { PendingRequestRegistry } from "./pending-requests";

/**
 * Broker for the interactive `ask_user` tool. Same lifecycle as the permission
 * broker (it shares the generic PendingRequestRegistry): the tool emits a
 * `question.requested` event, the run parks on the returned Promise, and the UI
 * resolves it via IPC. An unanswered request (timeout, window close, session
 * abort) resolves as `skipped` — the authoritative "no decision" signal the
 * planner treats as "proceed with defaults and record them as assumptions".
 */

type QuestionContext = { request: QuestionRequest; emit(event: AgentEvent): void };

const registry = new PendingRequestRegistry<QuestionResponse, QuestionContext>();
const inFlight = new Map<
  string,
  { request: QuestionRequest; response: Promise<QuestionResponse> }
>();

/** Ignore request-local ids and recommendation/order presentation, preserving decision semantics. */
export function questionPromptKey(question: QuestionPrompt): string {
  return JSON.stringify({
    header: question.header.normalize("NFC").trim(),
    detail: question.detail ?? "",
    multiSelect: question.multiSelect,
    options: question.options
      .map(({ label, description }) => JSON.stringify([label, description ?? ""]))
      .sort(),
  });
}

async function sharedResponse(
  pending: { request: QuestionRequest; response: Promise<QuestionResponse> },
  questions: QuestionPrompt[],
  signal?: AbortSignal,
): Promise<QuestionResponse> {
  let onAbort: (() => void) | undefined;
  const cancelled = signal
    ? new Promise<QuestionResponse>((resolve) => {
        onAbort = () => resolve({ requestId: pending.request.id, answers: [], skipped: true });
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })
    : undefined;
  try {
    const response = await (cancelled
      ? Promise.race([pending.response, cancelled])
      : pending.response);
    return {
      ...response,
      answers: response.answers.flatMap((answer) => {
        const index = pending.request.questions.findIndex(
          (question) => question.id === answer.questionId,
        );
        const question = questions[index];
        return question
          ? [{ ...answer, questionId: question.id, selected: [...answer.selected] }]
          : [];
      }),
    };
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** Generous window: a human may take minutes to decide; then fall back to skipped. */
const QUESTION_TIMEOUT_MS = 30 * 60_000;

function makeResponse(
  context: QuestionContext,
  answers: QuestionAnswer[],
  skipped: boolean,
): QuestionResponse {
  const response: QuestionResponse = { requestId: context.request.id, answers, skipped };
  if (context.request.sessionId) {
    context.emit({
      type: "question.resolved",
      sessionId: context.request.sessionId,
      requestId: context.request.id,
      answers,
      skipped,
    });
  }
  return response;
}

const skip = (context: QuestionContext): QuestionResponse => makeResponse(context, [], true);

export async function requestQuestions(input: {
  sessionId: string;
  runId?: string | undefined;
  questions: QuestionPrompt[];
  emit(event: AgentEvent): void;
  /** When the run is aborted mid-question, unblock as skipped so the turn ends cleanly. */
  signal?: AbortSignal | undefined;
}): Promise<QuestionResponse> {
  // Multiple parallel ask_user calls must not stack identical interactive cards.
  // Sharing is confined to one session/run; a caller's cancellation stays local.
  const key = input.runId
    ? JSON.stringify([input.sessionId, input.runId, input.questions.map(questionPromptKey)])
    : undefined;
  const existing = key ? inFlight.get(key) : undefined;
  if (existing) return sharedResponse(existing, input.questions, input.signal);
  const request: QuestionRequest = {
    id: randomUUID(),
    sessionId: input.sessionId,
    questions: input.questions,
  };
  if (input.runId !== undefined) request.runId = input.runId;

  const pending = registry.open({
    id: request.id,
    sessionId: input.sessionId,
    context: { request, emit: input.emit },
    timeoutMs: QUESTION_TIMEOUT_MS,
    onTimeout: (context) => skip(context),
  });

  const flight = { request, response: pending };
  if (key) inFlight.set(key, flight);
  const onAbort = () => resolveQuestionRequest(request.id, [], true);
  try {
    // Register before publishing: even an immediate answer must find its request.
    input.emit({ type: "question.requested", sessionId: input.sessionId, request });
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    return await pending;
  } catch (error) {
    resolveQuestionRequest(request.id, [], true);
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    if (key && inFlight.get(key) === flight) inFlight.delete(key);
  }
}

export function resolveQuestionRequest(
  requestId: string,
  answers: QuestionAnswer[],
  skipped: boolean,
): QuestionResponse | undefined {
  return registry.settle(requestId, (context) =>
    makeResponse(context, skipped ? [] : answers, skipped),
  );
}

export function denyPendingQuestionRequests(): void {
  registry.cancelAll((context) => skip(context));
}

export function denyPendingQuestionRequestsForSession(sessionId: string): void {
  registry.cancelForSession(sessionId, (context) => skip(context));
}
