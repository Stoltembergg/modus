import type { AgentEvent, QuestionRequest } from "../../../../shared/contracts";

/**
 * The newest still-unanswered ask_user request, derived from the event stream
 * (mirrors latestPendingPermissionRequest): a `question.requested` is pending
 * until its matching `question.resolved` arrives.
 */
export function latestPendingQuestionRequest(
  events: Array<{ event: AgentEvent }>,
): QuestionRequest | undefined {
  const pending = new Map<string, QuestionRequest>();
  // Resolution is final even when hydration/live replay delivers its request later.
  const resolved = new Set(
    events.flatMap(({ event }) => (event.type === "question.resolved" ? [event.requestId] : [])),
  );

  for (const { event } of events) {
    if (
      event.type === "run.started" ||
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled" ||
      event.type === "run.blocked"
    ) {
      pending.clear();
      continue;
    }
    if (event.type === "question.requested") {
      if (resolved.has(event.request.id)) continue;
      pending.delete(event.request.id);
      pending.set(event.request.id, event.request);
      continue;
    }
    if (event.type === "question.resolved") {
      pending.delete(event.requestId);
    }
  }

  return Array.from(pending.values()).at(-1);
}
