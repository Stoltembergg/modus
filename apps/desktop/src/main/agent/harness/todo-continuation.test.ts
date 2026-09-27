import { describe, expect, it } from "vitest";
import type { TodoItem } from "../../../shared/contracts";
import { evaluateTodoContinuation } from "./todo-continuation";

const evaluate = (overrides: Partial<Parameters<typeof evaluateTodoContinuation>[0]> = {}) =>
  evaluateTodoContinuation({
    todos: [],
    outcome: "completed",
    aborted: false,
    hasQueuedInput: false,
    attempts: 0,
    ...overrides,
  });

const todo = (status: TodoItem["status"], id = "todo-1"): TodoItem => ({
  id,
  content: "Complete task step",
  status,
});

describe("evaluateTodoContinuation", () => {
  it("stops when all todos are complete or cancelled", () => {
    expect(evaluate({ todos: [todo("completed"), todo("cancelled", "todo-2")] })).toMatchObject({
      action: "stop",
    });
  });

  it("allows one continuation for actionable pending todos", () => {
    expect(evaluate({ todos: [todo("pending")] })).toMatchObject({ action: "continue" });
  });

  it("blocks continuation when a todo needs user input", () => {
    expect(
      evaluate({ todos: [{ ...todo("blocked"), blockedReason: "Needs product decision" }] }),
    ).toMatchObject({
      action: "blocked",
    });
  });

  it("stops on failure and abort", () => {
    expect(evaluate({ todos: [todo("pending")], outcome: "failed" })).toMatchObject({
      action: "stop",
    });
    expect(evaluate({ todos: [todo("pending")], aborted: true })).toMatchObject({ action: "stop" });
  });

  it("stops when new input is queued or the continuation budget is exhausted", () => {
    expect(evaluate({ todos: [todo("pending")], hasQueuedInput: true })).toMatchObject({
      action: "stop",
    });
    expect(evaluate({ todos: [todo("pending")], attempts: 1 })).toMatchObject({ action: "stop" });
  });

  it("starts a new turn with an independent continuation budget", () => {
    expect(evaluate({ todos: [todo("pending")], attempts: 0 })).toMatchObject({
      action: "continue",
    });
  });
});
