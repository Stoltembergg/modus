import type { PlanRef } from "./contracts";

/**
 * The concise instruction sent when the user approves a session plan. The
 * internal plan.md is the Markdown source of truth for execution.
 */
export function buildPlanMessage(plan: PlanRef): string {
  const todoLines = plan.todos.map((todo, index) => `${index + 1}. ${todo.content}`).join("\n");
  return [
    `Build the approved plan "${plan.title}". Read the full plan at ${plan.path} as the single`,
    "source of truth, then implement it end-to-end and verify against its acceptance criteria",
    "before reporting done.",
    "",
    "To-dos:",
    todoLines,
  ].join("\n");
}
