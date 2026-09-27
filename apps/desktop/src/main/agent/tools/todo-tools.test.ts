import { describe, expect, it, vi } from "vitest";
import {
  applyTodoWrite,
  clearTodoSessionCache,
  formatTodosForModel,
  registerTodoTools,
} from "./todo-tools";
import { setAgentToolContext } from "./tool-context";
import { toolRegistry } from "./registry";

const persistedTodos = vi.hoisted(() => ({ current: [] as Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }> }));
vi.mock("../agent-event-store", () => ({
  getLatestSessionTodos: () => persistedTodos.current,
}));

describe("applyTodoWrite", () => {
  it("replaces the whole list when merge is omitted", () => {
    const current = [{ id: "todo-1", content: "Old step", status: "pending" as const }];
    const next = applyTodoWrite(current, {
      todos: [{ content: "New step", status: "in_progress" }],
    });
    expect(next).toEqual([{ id: "todo-1", content: "New step", status: "in_progress" }]);
  });

  it("merges by id and appends unknown items", () => {
    const current = [
      { id: "todo-1", content: "Plan", status: "completed" as const },
      { id: "todo-2", content: "Implement", status: "in_progress" as const },
    ];
    const next = applyTodoWrite(current, {
      merge: true,
      todos: [
        { id: "todo-2", content: "Implement feature", status: "completed" },
        { content: "Verify", status: "in_progress" },
      ],
    });
    expect(next).toEqual([
      { id: "todo-1", content: "Plan", status: "completed" },
      { id: "todo-2", content: "Implement feature", status: "completed" },
      { id: "todo-3", content: "Verify", status: "in_progress" },
    ]);
  });

  it("truncates long content", () => {
    const long = "x".repeat(300);
    const next = applyTodoWrite([], { todos: [{ content: long, status: "pending" }] });
    expect(next[0]?.content.length).toBeLessThanOrEqual(240);
  });

  it("preserves a bounded blocked reason only for blocked todos", () => {
    const blocked = applyTodoWrite([], {
      todos: [
        {
          content: "Wait for approval",
          status: "blocked",
          blockedReason: "reason ".repeat(100),
        },
      ],
    } as never);
    expect(blocked[0]?.status).toBe("blocked");
    expect(blocked[0]?.blockedReason?.length).toBeLessThanOrEqual(240);

    const pending = applyTodoWrite([], {
      todos: [
        {
          content: "Implement feature",
          status: "pending",
          blockedReason: "obsolete",
        },
      ],
    } as never);
    expect(pending[0]).not.toHaveProperty("blockedReason");
  });
});

describe("formatTodosForModel", () => {
  it("renders checklist markers and counts completed items", () => {
    const text = formatTodosForModel([
      { id: "todo-1", content: "Plan", status: "completed" },
      { id: "todo-2", content: "Build", status: "in_progress" },
    ]);
    expect(text).toContain("1 of 2 done");
    expect(text).toContain("[x] todo-1: Plan");
    expect(text).toContain("[>] todo-2: Build");
  });
});

describe("clearTodoSessionCache", () => {
  it("rehydrates the single todo list from the latest persisted event after cache clear", async () => {
    const sessionId = "todo-cache-rehydrate-test";
    registerTodoTools();
    persistedTodos.current = [{ id: "todo-1", content: "Persisted after rollback", status: "pending" }];
    setAgentToolContext({
      workspaceId: "workspace",
      cwd: process.cwd(),
      sessionId,
      profile: "chat",
      emit: vi.fn(),
    });
    const definition = toolRegistry
      .getCustomToolDefinitions("chat")
      .find((tool) => tool.name === "todo_write");
    if (!definition) throw new Error("todo_write tool is not registered");
    const execute = definition.execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
    const call = async (content: string) =>
      await execute(
        "todo-test",
        { merge: true, todos: [{ id: "todo-1", content, status: "completed" }] },
        new AbortController().signal,
        undefined,
        { cwd: process.cwd() },
      );

    await call("Cached old state");
    clearTodoSessionCache(sessionId);
    const result = await call("Updated persisted state");

    expect(result.content[0]?.text).toContain("Updated persisted state");
    expect(result.content[0]?.text).not.toContain("Cached old state");
  });
});
