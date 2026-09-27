import type { TodoItem } from "../../../shared/contracts";

export type TodoContinuationInput = {
  todos: readonly TodoItem[];
  outcome: "completed" | "failed" | "cancelled";
  aborted: boolean;
  hasQueuedInput: boolean;
  attempts: number;
};

export type TodoContinuationDecision = {
  action: "stop" | "continue" | "blocked";
  reason: string;
};

export function evaluateTodoContinuation(input: TodoContinuationInput): TodoContinuationDecision {
  if (input.aborted) return { action: "stop", reason: "run_aborted" };
  if (input.outcome !== "completed") return { action: "stop", reason: "run_not_completed" };
  if (input.hasQueuedInput) return { action: "stop", reason: "queued_input" };

  const blocked = input.todos.find((todo) => todo.status === "blocked");
  if (blocked) {
    return {
      action: "blocked",
      reason: (blocked.blockedReason?.trim() || "Todo requires user input.").slice(0, 240),
    };
  }

  const hasActionableWork = input.todos.some(
    (todo) => todo.status === "pending" || todo.status === "in_progress",
  );
  if (!hasActionableWork) return { action: "stop", reason: "all_todos_complete" };
  if (input.attempts >= 1) return { action: "stop", reason: "max_attempts" };
  return { action: "continue", reason: "actionable_todos" };
}
