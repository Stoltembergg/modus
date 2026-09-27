import { join } from "node:path";
import {
  type AgentToolResult,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { app } from "electron";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { PLAN_TOOL_NAME, PLAN_TOOL_UI } from "../../../shared/tools";
import { writePlan } from "../../plan/plan-store";
import { toolRegistry } from "./registry";
import { resolveAgentToolContext } from "./tool-context";

const MAX_PLAN_CONTENT_BYTES = 64 * 1024;

/**
 * Plan Mode tool. In Plan Mode the agent is read-only on the codebase
 * (read/grep/find/ls); `plan_write` materializes the session-scoped Markdown
 * artifact. The tool does not write the codebase, so the profile remains safe
 * without edit/write/bash.
 *
 * Plans live under the app's user-data dir and are removed with their session.
 */

/** Shared plans root (`<userData>/plans`), reused by the runtime's build-state updates. */
export function plansRoot(): string {
  return join(app.getPath("userData"), "plans");
}

function toResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

const planParams = Type.Object(
  {
    title: Type.String({
      minLength: 1,
      description:
        "Short title rendered separately above the plan body; do not repeat it in content.",
    }),
    overview: Type.String({
      minLength: 1,
      description:
        "One-paragraph summary of the approach (what gets built and how), shown as the plan's " +
        "subtitle in the Review card. Keep it to 1–3 sentences.",
    }),
    todos: Type.Array(
      Type.Union([
        Type.String({
          minLength: 1,
          description: "One implementation step, action-oriented.",
        }),
        Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
            content: Type.String({ minLength: 1 }),
            acceptanceCriterionIds: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }), {
                maxItems: 100,
              }),
            ),
          },
          { additionalProperties: false },
        ),
      ]),
      {
        minItems: 1,
        maxItems: 100,
        description:
          "Ordered implementation steps. Use plain strings for Plan Mode; in Spec Mode use objects " +
          "with stable ids and acceptanceCriterionIds. These drive execution, so each step must be " +
          "a self-contained unit of work.",
      },
    ),
    content: Type.String({
      minLength: 1,
      maxLength: MAX_PLAN_CONTENT_BYTES,
      description:
        "Markdown plan body after the title (last field). Modus renders `title` separately, so " +
        "do not repeat it here. This text is the executor's source of truth.",
    }),
    spec: Type.Optional(
      Type.Object(
        {
          requirements: Type.Array(
            Type.Object(
              {
                id: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
                text: Type.String({ minLength: 1, maxLength: 2000 }),
              },
              { additionalProperties: false },
            ),
            { maxItems: 100 },
          ),
          acceptanceCriteria: Type.Array(
            Type.Object(
              {
                id: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
                requirementId: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
                description: Type.String({ minLength: 1, maxLength: 2000 }),
                todoIds: Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }), {
                  maxItems: 100,
                }),
                requiredCheckKinds: Type.Optional(
                  Type.Array(
                    Type.Union([
                      Type.Literal("tests"),
                      Type.Literal("typecheck"),
                      Type.Literal("lint"),
                      Type.Literal("build"),
                    ]),
                    { uniqueItems: true, maxItems: 4 },
                  ),
                ),
                status: Type.Optional(Type.Literal("pending")),
              },
              { additionalProperties: false },
            ),
            { maxItems: 100 },
          ),
          assumptions: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
          openQuestions: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
            maxItems: 20,
          }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const planTool: ToolDefinition = defineTool({
  name: PLAN_TOOL_NAME,
  label: "Write plan",
  description:
    "Write or update the implementation plan for the current Plan Mode session. The plan is a " +
    "session-scoped Markdown document — the source of truth used for execution. Research the " +
    "codebase (read/grep/find/ls) and resolve open questions with the user BEFORE writing, then " +
    "call this once with the complete plan. After a successful call, stop; only a later user " +
    "revision request should write a new version. Do not implement anything in Plan Mode.",
  promptSnippet:
    "plan_write(title, overview, todos, content) — write/update this session's single Markdown " +
    "plan. `content` is the plan body after the title and must be the final field.",
  promptGuidelines: [
    "Plan Mode is read-only on the codebase: research with read/grep/find/ls, never edit/run. Persist the Plan with plan_write.",
    "Front-load clarifying questions so the plan is self-contained — a separate executor (or two parallel ones) must be able to build from it without asking the user again.",
    "Be decision-complete: pin the actual data shapes, signatures, algorithms (formula or precise steps), and config values an executor would otherwise have to invent — concrete and owned, never fabricated as fact.",
    "Keep the Markdown readable: use short sections, well-spaced lists, and diagrams/tables only when they clarify the plan.",
    "Always include testable Acceptance Criteria: these are what verifies the work later, so phrase them as observable behavior.",
  ],
  parameters: planParams,
  execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
    if (!Value.Check(planParams, params)) {
      throw new Error("Invalid plan_write parameters.");
    }
    if (Buffer.byteLength(params.content, "utf8") > MAX_PLAN_CONTENT_BYTES) {
      throw new Error("Plan content exceeds the maximum allowed size.");
    }
    const context = resolveAgentToolContext(ctx.cwd);
    if (!context.workspaceId || !context.sessionId) {
      throw new Error("No active Modus workspace for this plan.");
    }
    const hasStructuredTodos = params.todos.some((todo) => typeof todo !== "string");
    if ((params.spec || hasStructuredTodos) && context.mode !== "spec") {
      throw new Error("Structured plan metadata is available only in Spec Mode.");
    }
    const plan = writePlan(plansRoot(), {
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      title: params.title,
      overview: params.overview,
      content: params.content,
      todos: params.todos.map((todo) => (typeof todo === "string" ? { content: todo } : todo)),
      ...(params.spec
        ? {
            spec: {
              ...params.spec,
              acceptanceCriteria: params.spec.acceptanceCriteria.map((criterion) => ({
                ...criterion,
                status: "pending" as const,
              })),
            },
          }
        : {}),
    });
    context.emit?.({ type: "plan.updated", sessionId: context.sessionId, plan, toolCallId });
    return toResult(`Plan "${plan.title}" written to ${plan.path}.`, plan);
  },
});

let registered = false;

/** Register the plan tool into the shared registry (idempotent). */
export function registerPlanTools(): void {
  if (registered) {
    return;
  }
  registered = true;

  toolRegistry.registerTool({
    entry: {
      name: PLAN_TOOL_NAME,
      profiles: ["plan"],
      permission: { danger: "safe" },
      capabilities: ["write"],
      readOnly: false,
      ui: PLAN_TOOL_UI,
    },
    definition: planTool,
  });
}
