// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, TodoItem } from "../../../../shared/contracts";
import { pinnedTodosForRail } from "./Timeline";
import { TodosCard } from "./TodosCard";

afterEach(cleanup);

const TODOS: TodoItem[] = [
  { id: "a", content: "Write the migration", status: "in_progress" },
  { id: "b", content: "Add tests", status: "pending" },
];

describe("pinned To-dos card", () => {
  it("renders expanded by default and collapses from its header", async () => {
    const user = userEvent.setup();
    render(<TodosCard todos={TODOS} updating={false} />);
    const header = screen.getByRole("button", { expanded: true });
    expect(screen.getByText("Write the migration")).toBeTruthy();
    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("has no divider line above the list", () => {
    const { container } = render(<TodosCard todos={TODOS} updating={false} />);
    expect(container.querySelector("ul")?.className).not.toContain("border-t");
  });
});

function ev(id: string, event: AgentEvent) {
  return { id, event };
}

describe("pinned To-dos rail selection", () => {
  it("no todo_write means no pinned card (never an empty one)", () => {
    expect(pinnedTodosForRail([])).toBeUndefined();
    expect(
      pinnedTodosForRail([ev("1", { type: "todos.updated", sessionId: "s", todos: [] })]),
    ).toBeUndefined();
  });

  it("a todo_write with pending items pins the card, rendered expanded", () => {
    const block = pinnedTodosForRail([
      ev("1", { type: "tool.started", sessionId: "s", toolCallId: "t1", toolName: "todo_write" }),
      ev("2", { type: "todos.updated", sessionId: "s", todos: TODOS }),
      ev("3", { type: "tool.ended", sessionId: "s", toolCallId: "t1", isError: false }),
    ]);
    expect(block?.todos).toEqual(TODOS);
    if (!block) return;
    render(<TodosCard todos={block.todos} updating={block.updating} />);
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
    expect(screen.getByText("Add tests")).toBeTruthy();
  });

  it("an all-completed checklist is not pinned", () => {
    const done = TODOS.map((todo) => ({ ...todo, status: "completed" as const }));
    expect(
      pinnedTodosForRail([ev("1", { type: "todos.updated", sessionId: "s", todos: done })]),
    ).toBeUndefined();
  });
});
