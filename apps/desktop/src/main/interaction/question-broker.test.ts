import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, QuestionPrompt } from "../../shared/contracts";
import {
  denyPendingQuestionRequests,
  requestQuestions,
  resolveQuestionRequest,
} from "./question-broker";

const QUESTIONS: QuestionPrompt[] = [
  { id: "q1", header: "Which view?", multiSelect: false, options: [{ label: "Side" }] },
];

afterEach(() => {
  denyPendingQuestionRequests();
});

describe("question-broker", () => {
  it("emits question.requested and resolves with the user's answers", async () => {
    const events: AgentEvent[] = [];
    const pending = requestQuestions({
      sessionId: "session-1",
      questions: QUESTIONS,
      emit: (event) => events.push(event),
    });

    const requested = events.find((event) => event.type === "question.requested");
    if (requested?.type !== "question.requested") {
      throw new Error("missing question.requested");
    }
    resolveQuestionRequest(requested.request.id, [{ questionId: "q1", selected: ["Side"] }], false);

    await expect(pending).resolves.toMatchObject({
      skipped: false,
      answers: [{ questionId: "q1", selected: ["Side"] }],
    });
    expect(
      events.some((event) => event.type === "question.resolved" && event.skipped === false),
    ).toBe(true);
  });

  it("a skip discards answers and resolves as skipped", async () => {
    const events: AgentEvent[] = [];
    const pending = requestQuestions({
      sessionId: "session-1",
      questions: QUESTIONS,
      emit: (event) => events.push(event),
    });
    const requested = events.find((event) => event.type === "question.requested");
    if (requested?.type !== "question.requested") {
      throw new Error("missing request");
    }
    // Even if answers are passed, skipped=true must win (answers dropped).
    resolveQuestionRequest(requested.request.id, [{ questionId: "q1", selected: ["Side"] }], true);

    await expect(pending).resolves.toMatchObject({ skipped: true, answers: [] });
  });

  it("an aborted run unblocks the question as skipped", async () => {
    const controller = new AbortController();
    const pending = requestQuestions({
      sessionId: "session-1",
      questions: QUESTIONS,
      emit: () => {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ skipped: true });
  });

  it("denies all pending questions on window close", async () => {
    const pending = requestQuestions({
      sessionId: "session-1",
      questions: QUESTIONS,
      emit: () => {},
    });
    denyPendingQuestionRequests();
    await expect(pending).resolves.toMatchObject({ skipped: true });
  });
});

it("coalesces simultaneous copies of the same question so one answer cannot reveal another copy", async () => {
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent) => {
    events.push(event);
    if (event.type === "question.requested")
      queueMicrotask(() =>
        resolveQuestionRequest(
          event.request.id,
          [{ questionId: event.request.questions[0]?.id ?? "", selected: ["Side"] }],
          false,
        ),
      );
  };
  const first = requestQuestions({ sessionId: "same", runId: "run", questions: QUESTIONS, emit });
  const second = requestQuestions({
    sessionId: "same",
    runId: "run",
    questions: QUESTIONS.map((question) => ({ ...question, id: "different-id" })),
    emit,
  });
  const [a, b] = await Promise.all([first, second]);
  expect(events.filter((event) => event.type === "question.requested")).toHaveLength(1);
  expect(a.answers).toEqual([{ questionId: "q1", selected: ["Side"] }]);
  expect(b.answers).toEqual([{ questionId: "different-id", selected: ["Side"] }]);
});

it("cancels a shared caller without closing the original question", async () => {
  const events: AgentEvent[] = [];
  const input = {
    sessionId: "shared-cancel",
    runId: "run",
    questions: QUESTIONS,
    emit: (event: AgentEvent) => events.push(event),
  };
  const first = requestQuestions(input);
  const controller = new AbortController();
  const second = requestQuestions({ ...input, signal: controller.signal });
  controller.abort();
  await expect(second).resolves.toMatchObject({ skipped: true });
  const requested = events.find((event) => event.type === "question.requested");
  if (requested?.type !== "question.requested") throw new Error("missing request");
  resolveQuestionRequest(requested.request.id, [{ questionId: "q1", selected: ["Side"] }], false);
  await expect(first).resolves.toMatchObject({ skipped: false });
  expect(events.filter((event) => event.type === "question.resolved")).toHaveLength(1);
});

it("accepts an immediate answer during publication of the request", async () => {
  const response = await requestQuestions({
    sessionId: "immediate",
    questions: QUESTIONS,
    emit: (event) => {
      if (event.type === "question.requested")
        resolveQuestionRequest(event.request.id, [{ questionId: "q1", selected: ["Side"] }], false);
    },
  });
  expect(response.skipped).toBe(false);
});
