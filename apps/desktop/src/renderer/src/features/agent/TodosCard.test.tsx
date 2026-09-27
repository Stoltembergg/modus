import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TodoItem } from "../../../../shared/contracts";
import { TodosCard } from "./TodosCard";

function renderTodo(todo: TodoItem) {
  return renderToStaticMarkup(<TodosCard todos={[todo]} updating={false} />);
}

describe("TodosCard", () => {
  it("shows a blocked label and its reason beneath the task", () => {
    const markup = renderTodo({
      id: "blocked-task",
      content: "Deploy the release",
      status: "blocked",
      blockedReason: "Waiting for approval from the release owner.",
    });

    expect(markup).toContain("Deploy the release");
    expect(markup).toContain("Blocked");
    expect(markup).toContain("Waiting for approval from the release owner.");
    expect(markup).toContain("text-warning");
  });

  it("shows the blocked label without an empty reason when none is provided", () => {
    const markup = renderTodo({
      id: "blocked-task",
      content: "Deploy the release",
      status: "blocked",
    });

    expect(markup).toContain("Blocked");
    expect(markup).not.toContain("undefined");
  });

  it.each([
    ["pending", "text-fg-subtle", "text-fg-faint"],
    ["in_progress", "text-fg font-medium", "text-fg-muted"],
    ["completed", "line-through", "text-fg-faint"],
    ["cancelled", "line-through", "text-fg-faint"],
  ] as const)("preserves %s presentation", (status, textClass, iconClass) => {
    const markup = renderTodo({ id: status, content: "Keep this task", status });

    expect(markup).toContain("Keep this task");
    expect(markup).toContain(textClass);
    expect(markup).toContain(iconClass);
  });
});
