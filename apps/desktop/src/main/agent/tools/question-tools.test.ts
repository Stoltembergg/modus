import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  QuestionPrompt,
  QuestionRequest,
  QuestionResponse,
} from "../../../shared/contracts";
import {
  denyPendingQuestionRequests,
  resolveQuestionRequest,
} from "../../interaction/question-broker";
import { runWithAgentToolContext } from "./tool-context";

const history = vi.hoisted(() => ({
  entries: [] as Array<{ request: QuestionRequest; response: QuestionResponse }>,
}));
vi.mock("../agent-event-store", () => ({ getSessionQuestionHistory: () => history.entries }));
afterEach(() => {
  history.entries = [];
  denyPendingQuestionRequests();
});

import { registerQuestionTools } from "./question-tools";
import { toolRegistry } from "./registry";

function toolEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: "tool_call", toolCallId: "t1", toolName, input } as ToolCallEvent;
}

describe("registerQuestionTools", () => {
  it("registers ask_user into both the plan and chat profiles", () => {
    registerQuestionTools();
    expect(new Set(toolRegistry.resolveActiveTools("plan")).has("ask_user")).toBe(true);
    expect(new Set(toolRegistry.resolveActiveTools("chat")).has("ask_user")).toBe(true);
  });

  it("keeps ask_user out of the read-only review profile", () => {
    registerQuestionTools();
    expect(new Set(toolRegistry.resolveActiveTools("review")).has("ask_user")).toBe(false);
  });

  it("classifies ask_user as safe (a read-only round-trip, no approval prompt)", () => {
    registerQuestionTools();
    expect(toolRegistry.classify(toolEvent("ask_user", { questions: [] })).dangerous).toBe(false);
  });

  it("is idempotent — calling twice does not duplicate the definition", () => {
    registerQuestionTools();
    registerQuestionTools();
    const definitions = toolRegistry
      .getCustomToolDefinitions("plan")
      .filter((definition) => definition.name === "ask_user");
    expect(definitions).toHaveLength(1);
  });
});

const visualQuestion: QuestionPrompt = {
  id: "old-id",
  header: "Qual direção visual?",
  multiSelect: false,
  options: [{ label: "Escuro", recommended: true }, { label: "Claro" }],
};

function savedAnswer(question = visualQuestion): void {
  history.entries = [
    {
      request: { id: "old-request", sessionId: "s", runId: "run", questions: [question] },
      response: {
        requestId: "old-request",
        skipped: false,
        answers: [{ questionId: question.id, selected: ["Claro"], custom: "Sem bordas" }],
      },
    },
  ];
}

async function ask(questions: QuestionPrompt[], runId = "run") {
  registerQuestionTools();
  const events: AgentEvent[] = [];
  const tool = toolRegistry
    .getCustomToolDefinitions("plan")
    .find((tool) => tool.name === "ask_user");
  if (!tool) throw new Error("ask_user missing");
  const result = await runWithAgentToolContext(
    {
      workspaceId: "w",
      cwd: "/tmp",
      sessionId: "s",
      runId,
      emit: (event) => {
        events.push(event);
        if (event.type === "question.requested") {
          queueMicrotask(() =>
            resolveQuestionRequest(
              event.request.id,
              event.request.questions.map((q) => ({
                questionId: q.id,
                selected: [q.options[0]?.label ?? ""],
              })),
              false,
            ),
          );
        }
      },
    },
    () => tool.execute("tool", { questions }, undefined, undefined, { cwd: "/tmp" } as never),
  );
  return { result, events };
}

describe("answered question reuse", () => {
  it("returns the user's existing answer without reopening the same question in a run", async () => {
    savedAnswer();
    const { events, result } = await ask([visualQuestion]);
    expect(events.filter((event) => event.type === "question.requested")).toHaveLength(0);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("Claro; Sem bordas") }),
      ]),
    );
    expect(result.details).toMatchObject({
      skipped: false,
      answers: [{ questionId: "q1", selected: ["Claro"], custom: "Sem bordas" }],
    });
  });

  it("only opens the unanswered part of a mixed batch and remaps answer ids", async () => {
    savedAnswer();
    const { events, result } = await ask([
      { ...visualQuestion, header: "Qual layout?" },
      visualQuestion,
    ]);
    const requested = events.find((event) => event.type === "question.requested");
    expect(
      requested?.type === "question.requested" && requested.request.questions.map((q) => q.header),
    ).toEqual(["Qual layout?"]);
    expect(result.details).toMatchObject({
      answers: [
        { questionId: "q1", selected: ["Escuro"] },
        { questionId: "q2", selected: ["Claro"] },
      ],
    });
  });

  it("does not reuse an answer belonging to a different run", async () => {
    savedAnswer();
    const { events } = await ask([visualQuestion], "new-run");
    expect(events.filter((event) => event.type === "question.requested")).toHaveLength(1);
  });

  it.each([
    { detail: "Now for a different project" },
    { options: [{ label: "System" }] },
    { multiSelect: true },
  ])("asks again when decision semantics change: %j", async (change) => {
    savedAnswer();
    const { events } = await ask([{ ...visualQuestion, ...change }]);
    expect(events.filter((event) => event.type === "question.requested")).toHaveLength(1);
  });

  it("does not reuse skipped or empty answers", async () => {
    savedAnswer();
    if (history.entries[0]) history.entries[0].response.skipped = true;
    const { events } = await ask([visualQuestion]);
    expect(events.filter((event) => event.type === "question.requested")).toHaveLength(1);
  });

  it("binds a new question request to the host-owned run", async () => {
    const { events } = await ask([visualQuestion]);
    expect(events.find((event) => event.type === "question.requested")).toMatchObject({
      request: { runId: "run" },
    });
  });
});
