import {
  type AgentToolResult,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { QuestionAnswer, QuestionPrompt, QuestionResponse } from "../../../shared/contracts";
import { ASK_USER_TOOL_NAME, ASK_USER_TOOL_UI } from "../../../shared/tools";
import { questionPromptKey, requestQuestions } from "../../interaction/question-broker";
import { getSessionQuestionHistory } from "../agent-event-store";
import { toolRegistry } from "./registry";
import { resolveAgentToolContext } from "./tool-context";

/**
 * Interactive clarification tool. When research can't settle a genuine product/
 * preference decision, the agent calls `ask_user` with menu-style questions; the
 * run blocks on the QuestionsCard above the composer until the user answers (or
 * skips). The answers come back as the tool result so the model proceeds with
 * the user's intent. Capability is `safe` (read-only round-trip — it writes
 * nothing), so it is available in both plan and chat profiles.
 */

function toResult(text: string, details: QuestionResponse): AgentToolResult<QuestionResponse> {
  return { content: [{ type: "text", text }], details };
}

const askUserParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      header: Type.String({ minLength: 1, description: "The question to ask the user." }),
      detail: Type.Optional(
        Type.String({ description: "Optional one-line context shown under the question." }),
      ),
      multiSelect: Type.Optional(
        Type.Boolean({
          description: "Allow choosing several options. Default false (single choice).",
        }),
      ),
      options: Type.Array(
        Type.Object({
          label: Type.String({ minLength: 1, description: "A concise choice." }),
          description: Type.Optional(Type.String({ description: "Optional clarifier." })),
          recommended: Type.Optional(
            Type.Boolean({ description: "Mark your suggested default (shown as 'recommended')." }),
          ),
        }),
        {
          minItems: 1,
          maxItems: 4,
          description:
            "2–4 mutually-exclusive choices. The user may also type a custom answer or skip.",
        },
      ),
    }),
    { minItems: 1, maxItems: 4, description: "1–4 questions to ask together." },
  ),
});

function formatAnswers(questions: QuestionPrompt[], answers: QuestionAnswer[]): string {
  const lines: string[] = [];
  for (const question of questions) {
    const answer = answers.find((entry) => entry.questionId === question.id);
    const parts = [...(answer?.selected ?? [])];
    if (answer?.custom) {
      parts.push(answer.custom);
    }
    lines.push(`Q: ${question.header}`);
    lines.push(`A: ${parts.length > 0 ? parts.join("; ") : "(no answer)"}`);
  }
  return lines.join("\n");
}

function answeredQuestions(sessionId: string, runId?: string) {
  const answers = new Map<
    string,
    { question: QuestionPrompt; answer: QuestionAnswer; requestId: string }
  >();
  for (const { request, response } of getSessionQuestionHistory(sessionId, runId)) {
    if (
      (request.sessionId && request.sessionId !== sessionId) ||
      (runId !== undefined && request.runId !== runId)
    )
      continue;
    for (const question of request.questions) {
      const key = questionPromptKey(question);
      answers.delete(key);
      const answer = response.answers.find((answer) => answer.questionId === question.id);
      if (
        response.skipped ||
        !answer ||
        (!answer.selected.length && !answer.custom?.trim()) ||
        (!question.multiSelect && answer.selected.length > 1) ||
        answer.selected.some((label) => !question.options.some((option) => option.label === label))
      )
        continue;
      answers.set(key, { question, answer, requestId: request.id });
    }
  }
  return answers;
}

/** Bounded reference data survives SDK compaction and reopening a session. */
export function answeredQuestionContext(sessionId: string): string {
  const decisions: Array<{
    question: string;
    detail?: string;
    selected: string[];
    custom?: string;
  }> = [];
  for (const { question, answer } of [...answeredQuestions(sessionId).values()].reverse()) {
    const next = {
      question: question.header,
      ...(question.detail ? { detail: question.detail } : {}),
      selected: answer.selected,
      ...(answer.custom ? { custom: answer.custom } : {}),
    };
    if (Buffer.byteLength(JSON.stringify([...decisions, next]), "utf8") <= 8192)
      decisions.push(next);
  }
  return decisions.length ? JSON.stringify(decisions.reverse()) : "";
}

const askUserTool: ToolDefinition = defineTool({
  name: ASK_USER_TOOL_NAME,
  label: "Ask the user",
  description:
    "Ask the user one to four menu-style questions and wait for the answer. Use ONLY for genuine " +
    "product/preference decisions that exploring the repo cannot settle — never for facts you can " +
    "discover yourself. Each question offers 2–4 mutually-exclusive options (mark one recommended); " +
    "the user can also type a custom answer or skip. If skipped, proceed with your recommended " +
    "defaults and record them as assumptions.",
  promptSnippet:
    "ask_user(questions) — ask the user menu-style questions and wait for their choices.",
  promptGuidelines: [
    "Front-load the few decisions that actually shape the work; do not ask about anything you can find by reading the repo.",
    "Give each question 2–4 concrete, mutually-exclusive options and mark the one you recommend.",
    "Reuse decisions the user has already answered while they remain relevant. Do not ask the same questions again when formalizing a plan or resuming work. The latest user instruction takes precedence.",
    "Treat a skip / no-answer as 'use my recommended default' and record it as an assumption.",
  ],
  parameters: askUserParams,
  execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
    const context = resolveAgentToolContext(ctx.cwd);
    const emit = context.emit;
    if (!context.sessionId || !emit) {
      const skipped: QuestionResponse = { requestId: "", answers: [], skipped: true };
      return toResult(
        "No interactive channel is available here; proceed with reasonable defaults and record them as assumptions.",
        skipped,
      );
    }

    if (signal?.aborted) {
      return toResult("Question request cancelled.", { requestId: "", answers: [], skipped: true });
    }

    const questions: QuestionPrompt[] = params.questions.map((question, index) => ({
      id: `q${index + 1}`,
      header: question.header,
      ...(question.detail !== undefined ? { detail: question.detail } : {}),
      multiSelect: question.multiSelect ?? false,
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description !== undefined ? { description: option.description } : {}),
        ...(option.recommended !== undefined ? { recommended: option.recommended } : {}),
      })),
    }));

    // Only replay inside the same host-owned run and delivered user turn.
    // Across turns, prior decisions are context, never fresh action authorization.
    const previous = context.runId
      ? answeredQuestions(context.sessionId, context.runId)
      : new Map();
    const reused = new Map<string, QuestionAnswer>();
    let previousRequestId = "";
    for (const question of questions) {
      const saved = previous.get(questionPromptKey(question));
      if (!saved) continue;
      previousRequestId = saved.requestId;
      reused.set(question.id, {
        ...saved.answer,
        questionId: question.id,
        selected: [...saved.answer.selected],
      });
    }
    const unanswered = questions.filter((question) => !reused.has(question.id));
    const response: QuestionResponse = unanswered.length
      ? await requestQuestions({
          sessionId: context.sessionId,
          ...(context.runId ? { runId: context.runId } : {}),
          questions: unanswered,
          emit,
          ...(signal ? { signal } : {}),
        })
      : { requestId: previousRequestId, answers: [], skipped: false };
    const answers = questions.flatMap((question) => {
      const answer =
        reused.get(question.id) ??
        response.answers.find((answer) => answer.questionId === question.id);
      return answer ? [answer] : [];
    });
    const combined = { ...response, answers, skipped: response.skipped && reused.size === 0 };

    if (combined.skipped) {
      return toResult(
        "The user skipped the questions. Proceed with your recommended defaults and record them explicitly as assumptions.",
        response,
      );
    }
    const note = response.skipped
      ? "The remaining questions were skipped; use recommended defaults only for unanswered questions. Preserve the existing answers below.\n"
      : reused.size > 0
        ? "These decisions were already answered in this turn. Reuse them and continue without asking again.\n"
        : "";
    return toResult(note + formatAnswers(questions, answers), combined);
  },
});

let registered = false;

/** Register the ask_user tool into the shared registry (idempotent). */
export function registerQuestionTools(): void {
  if (registered) {
    return;
  }
  registered = true;

  toolRegistry.registerTool({
    entry: {
      name: ASK_USER_TOOL_NAME,
      profiles: ["plan", "chat"],
      permission: { danger: "safe" },
      capabilities: ["read"],
      ui: ASK_USER_TOOL_UI,
    },
    definition: askUserTool,
  });
}
