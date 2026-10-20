import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../../shared/contracts";
import { latestPendingQuestionRequest } from "./questionRequests";

const request: AgentEvent = {
  type: "question.requested",
  sessionId: "s",
  request: { id: "q", sessionId: "s", questions: [] },
};
const resolved: AgentEvent = {
  type: "question.resolved",
  sessionId: "s",
  requestId: "q",
  answers: [],
  skipped: false,
};
const items = (...events: AgentEvent[]) => events.map((event) => ({ event }));
describe("pending questions", () => {
  it("does not reopen a resolved request when an older request event is replayed", () => {
    expect(latestPendingQuestionRequest(items(request, resolved, request))).toBeUndefined();
  });
  it("expires orphaned requests at the end of a run", () => {
    expect(
      latestPendingQuestionRequest(
        items(request, { type: "run.completed", sessionId: "s", runId: "run" }),
      ),
    ).toBeUndefined();
  });
  it("does not carry a pending request into another run", () => {
    expect(
      latestPendingQuestionRequest(
        items(request, { type: "run.started", sessionId: "s", runId: "new", delivery: "normal" }),
      ),
    ).toBeUndefined();
  });
  it("still displays a genuinely new unanswered request", () => {
    const next: AgentEvent = { ...request, request: { ...request.request, id: "next" } };
    expect(latestPendingQuestionRequest(items(request, resolved, next))?.id).toBe("next");
  });
});
