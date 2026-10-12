// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  reloadTaskChecklistPreference,
  setTaskChecklistVisible,
  TASK_CHECKLIST_STORAGE_KEY,
} from "../../lib/taskChecklist";
import { WorkActivityRow } from "./ActivityGroup";

afterEach(() => {
  cleanup();
  localStorage.clear();
  reloadTaskChecklistPreference();
});

const todosItem = {
  type: "todos",
  id: "todos-1",
  todos: [{ id: "t0", content: "Write the migration", status: "in_progress" }],
  updating: false,
} as unknown as Parameters<typeof WorkActivityRow>[0]["item"];

describe("task checklist visibility", () => {
  it("shows the checklist by default and hides it when toggled off", () => {
    render(<WorkActivityRow item={todosItem} />);
    expect(screen.getByText("Write the migration")).toBeTruthy();
    act(() => setTaskChecklistVisible(false));
    expect(screen.queryByText("Write the migration")).toBeNull();
    expect(localStorage.getItem(TASK_CHECKLIST_STORAGE_KEY)).toBe("false");
    act(() => setTaskChecklistVisible(true));
    expect(screen.getByText("Write the migration")).toBeTruthy();
  });

  it("restores a persisted hidden state on launch", () => {
    localStorage.setItem(TASK_CHECKLIST_STORAGE_KEY, "false");
    reloadTaskChecklistPreference();
    render(<WorkActivityRow item={todosItem} />);
    expect(screen.queryByText("Write the migration")).toBeNull();
  });
});
