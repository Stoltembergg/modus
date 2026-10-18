import {
  type AgentToolResult,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { GOAL_TOOL_NAMES, GOAL_TOOL_UI, type GoalToolName } from "../../../shared/tools";
import {
  completeSessionGoal,
  createSessionGoal,
  getSessionGoalState,
  type SessionGoal,
} from "../goal-state";
import { toolRegistry } from "./registry";
import { resolveAgentToolContext } from "./tool-context";

/**
 * define-goal skill tools (one goal per session, see goal-state.ts). They are
 * registered for every session but only exposed once the skill is active in it
 * (activeToolNamesForSession), from the next turn on, and never removed.
 */
type GoalDetails = { goal: SessionGoal | null };

const criteria = (description: string) =>
  Type.Array(Type.String({ minLength: 1 }), { description });

export const getGoalParams = Type.Object({});

export const createGoalParams = Type.Object({
  objective: Type.String({
    minLength: 1,
    description:
      "One concise, verifiable objective: the concrete outcome that will be true, including the evidence that proves it.",
  }),
  done_when: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description:
      "Completion criteria: each a binary or quantitative check (exact command and pass condition, threshold, observable behaviour).",
  }),
  out_of_scope: Type.Optional(
    criteria("What this goal must not change or include, when the boundary matters."),
  ),
  stop_and_ask: Type.Optional(
    criteria("Conditions under which you stop and ask the user instead of continuing."),
  ),
});

export const completeGoalParams = Type.Object({
  evidence: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description:
      "Evidence that each done_when criterion is met: commands run with their results, test/CI output, links, measured numbers.",
  }),
  summary: Type.String({ minLength: 1, description: "Short summary of what was achieved." }),
});

function sessionIdFor(cwd: string): string {
  const sessionId = resolveAgentToolContext(cwd).sessionId;
  if (!sessionId) throw new Error("Goal tools need an owning Modus session.");
  return sessionId;
}

function describeGoal(goal: SessionGoal): string {
  const list = (title: string, items: readonly string[]) =>
    items.length > 0 ? [`${title}:`, ...items.map((item) => `- ${item}`)] : [];
  return [
    `Goal (${goal.status}): ${goal.objective}`,
    ...list("Done when", goal.doneWhen),
    ...list("Out of scope", goal.outOfScope),
    ...list("Stop and ask if", goal.stopAndAsk),
    ...(goal.status === "completed"
      ? [...list("Evidence", goal.evidence ?? []), `Summary: ${goal.summary ?? ""}`]
      : []),
  ].join("\n");
}

function result(text: string, goal: SessionGoal | undefined): AgentToolResult<GoalDetails> {
  return { content: [{ type: "text", text }], details: { goal: goal ?? null } };
}

const getGoalTool: ToolDefinition = defineTool({
  name: "get_goal",
  label: "Get goal",
  description:
    "Read this session's goal (at most one per session). Call it before creating a goal, and before telling the user the goal's work is done, to check your work against its done_when criteria.",
  parameters: getGoalParams,
  execute: async (_id, _input: Static<typeof getGoalParams>, _signal, _onUpdate, ctx) => {
    const goal = getSessionGoalState(sessionIdFor(ctx.cwd)).goal;
    return result(goal ? describeGoal(goal) : "This session has no goal.", goal);
  },
});

const createGoalTool: ToolDefinition = defineTool({
  name: "create_goal",
  label: "Create goal",
  description:
    "Set this session's single goal once it passes the define-goal quality bar. Fails while an active goal exists: continue it, complete it, or start a new session for a separate goal. Only for goal-backed work the user asked for.",
  parameters: createGoalParams,
  execute: async (_id, input: Static<typeof createGoalParams>, _signal, _onUpdate, ctx) => {
    const goal = createSessionGoal(sessionIdFor(ctx.cwd), {
      objective: input.objective,
      doneWhen: input.done_when,
      ...(input.out_of_scope ? { outOfScope: input.out_of_scope } : {}),
      ...(input.stop_and_ask ? { stopAndAsk: input.stop_and_ask } : {}),
    });
    return result(`Goal set.\n${describeGoal(goal)}`, goal);
  },
});

const completeGoalTool: ToolDefinition = defineTool({
  name: "complete_goal",
  label: "Complete goal",
  description:
    "Mark this session's goal completed. Call get_goal first and only complete when every done_when criterion is met, giving the evidence for each. Fails when there is no active goal.",
  parameters: completeGoalParams,
  execute: async (_id, input: Static<typeof completeGoalParams>, _signal, _onUpdate, ctx) => {
    const goal = completeSessionGoal(sessionIdFor(ctx.cwd), {
      evidence: input.evidence,
      summary: input.summary,
    });
    return result(`Goal completed.\n${describeGoal(goal)}`, goal);
  },
});

const DEFINITIONS: Record<GoalToolName, ToolDefinition> = {
  get_goal: getGoalTool,
  create_goal: createGoalTool,
  complete_goal: completeGoalTool,
};

let registered = false;

export function registerGoalTools(): void {
  if (registered) return;
  registered = true;
  for (const name of GOAL_TOOL_NAMES) {
    toolRegistry.registerTool({
      entry: {
        name,
        profiles: ["chat", "review", "plan"],
        permission: { danger: "safe" },
        capabilities: [],
        ui: GOAL_TOOL_UI[name],
      },
      definition: DEFINITIONS[name],
    });
  }
}
