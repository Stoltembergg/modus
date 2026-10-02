// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodoItem } from "../../../../shared/contracts";
import { detectTodoChanges, TODO_CHANGE_HIGHLIGHT_MS, TodosCard } from "./TodosCard";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const list = (...statuses: TodoItem["status"][]): TodoItem[] =>
  statuses.map((status, index) => ({ id: `t${index}`, content: `Task ${index}`, status }));

function rowStatus(id: number): string | null | undefined {
  return document.querySelectorAll("li[data-status]")[id]?.getAttribute("data-status");
}

describe("detectTodoChanges", () => {
  it("reports new rows and status changes by id", () => {
    const before = list("in_progress", "pending");
    const after: TodoItem[] = [
      { id: "t1", content: "Task 1", status: "in_progress" },
      { id: "t0", content: "Task 0", status: "completed" },
      { id: "t2", content: "Task 2", status: "pending" },
    ];
    expect(detectTodoChanges(before, after)).toEqual([
      { id: "t1", oldStatus: "pending", newStatus: "in_progress" },
      { id: "t0", oldStatus: "in_progress", newStatus: "completed" },
      { id: "t2", newStatus: "pending" },
    ]);
    expect(detectTodoChanges(before, before)).toEqual([]);
  });
});

describe("TodosCard states", () => {
  it("in progress: header counts and the active row", () => {
    render(<TodosCard todos={list("completed", "in_progress", "pending")} updating={false} />);
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("· 1 done")).toBeTruthy();
    expect(rowStatus(1)).toBe("in_progress");
    expect(document.querySelector("section")?.getAttribute("data-todos-state")).toBe("settled");
  });

  it("completed: every row struck and done count equals total", () => {
    render(<TodosCard todos={list("completed", "completed")} updating={false} />);
    expect(screen.getByText("· 2 done")).toBeTruthy();
    expect(document.querySelectorAll("li .line-through")).toHaveLength(2);
  });

  it("empty: shows an empty hint, or the creating shimmer while a write is in flight", () => {
    render(<TodosCard todos={[]} updating={false} />);
    expect(screen.getByText("No to-dos yet.")).toBeTruthy();
    cleanup();
    render(<TodosCard todos={[]} updating />);
    expect(screen.getByText("Creating to-do list…")).toBeTruthy();
    expect(document.querySelector("section")?.getAttribute("data-todos-state")).toBe("creating");
  });

  it("pending update: shimmer while updating, changed rows highlighted then cleared", () => {
    vi.useFakeTimers();
    const before = list("in_progress", "pending");
    const { rerender } = render(<TodosCard todos={before} updating />);
    expect(screen.getByText("Updating to-dos…")).toBeTruthy();
    expect(document.querySelectorAll("[data-changed]")).toHaveLength(0);

    rerender(<TodosCard todos={list("completed", "in_progress")} updating={false} />);
    expect(screen.queryByText("Updating to-dos…")).toBeNull();
    const changed = document.querySelectorAll("[data-changed]");
    expect(changed).toHaveLength(2);
    expect(changed[0]?.className).toContain("bg-build/12");

    act(() => {
      vi.advanceTimersByTime(TODO_CHANGE_HIGHLIGHT_MS + 10);
    });
    expect(document.querySelectorAll("[data-changed]")).toHaveLength(0);
  });

  it("pending update: a no-op update mid-highlight does not leave the highlight stuck", () => {
    vi.useFakeTimers();
    const { rerender } = render(<TodosCard todos={list("in_progress", "pending")} updating />);
    rerender(<TodosCard todos={list("completed", "in_progress")} updating={false} />);
    expect(document.querySelectorAll("[data-changed]")).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    const edited = list("completed", "in_progress").map((todo) => ({
      ...todo,
      content: `${todo.content} (edited)`,
    }));
    rerender(<TodosCard todos={edited} updating={false} />);
    expect(screen.getByText("Task 0 (edited)")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(TODO_CHANGE_HIGHLIGHT_MS);
    });
    expect(document.querySelectorAll("[data-changed]")).toHaveLength(0);
  });

  it("keeps the collapse toggle", () => {
    render(<TodosCard todos={list("pending")} updating={false} />);
    const toggle = screen.getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
