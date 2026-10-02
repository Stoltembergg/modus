// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanRef } from "../../../../shared/contracts";
import { PlanTimelineCard } from "./PlanTimelineCard";
import { PlanStepList, PlanToolCard } from "./PlanTool";

afterEach(() => cleanup());

const plan = {
  id: "s1",
  title: "Release readiness",
  overview: "Prepare the release.",
  path: "/tmp/ws/.modus/plans/plan.md",
  hash: "h",
  workspaceId: "w",
  sessionId: "s1",
  blocks: [],
  content: "## Steps\n\nRun the checks.",
  todos: [
    { id: "a", content: "Run checks", status: "completed" },
    { id: "b", content: "Publish", status: "pending" },
  ],
  buildStatus: "idle",
  createdAt: "2026-10-02T00:00:00Z",
} as unknown as PlanRef;

describe("PlanStepList", () => {
  it("renders statuses and the done count", () => {
    render(
      <PlanStepList
        steps={[
          { id: "1", content: "One", status: "completed" },
          { id: "2", content: "Two", status: "in_progress" },
          { id: "3", content: "Three", status: "pending", detail: "Acceptance criteria: x" },
        ]}
      />,
    );
    expect(screen.getByRole("region", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    const rows = document.querySelectorAll("li[data-status]");
    expect([...rows].map((row) => row.getAttribute("data-status"))).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    expect(screen.getByText("One").className).toContain("line-through");
    expect(screen.getByText("Two").className).toContain("font-medium");
    expect(screen.getByText("Acceptance criteria: x")).toBeTruthy();
  });

  it("numbers untracked steps and renders nothing when empty", () => {
    render(<PlanStepList steps={[{ id: "1", content: "One" }]} />);
    expect(screen.getByText("1", { selector: "span.rounded-full" })).toBeTruthy();
    cleanup();
    const { container } = render(<PlanStepList steps={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("PlanToolCard", () => {
  it("writing: shimmer label, spinner, no expand", () => {
    render(<PlanToolCard state="writing" title="Draft" />);
    expect(screen.getByText("Writing the plan")).toBeTruthy();
    expect(document.querySelector("article")?.getAttribute("data-plan-state")).toBe("writing");
    expect(screen.queryByRole("button", { name: "Expand plan" })).toBeNull();
  });

  it("empty ready plan says so", () => {
    render(<PlanToolCard state="ready" />);
    expect(screen.getByText("No plan content provided.")).toBeTruthy();
  });

  it("failed state", () => {
    render(<PlanToolCard state="failed" title="T" />);
    expect(screen.getByText("Plan failed").className).toContain("text-danger");
  });

  it("expands to show steps and collapses back", () => {
    render(
      <PlanToolCard
        content="Body"
        state="ready"
        steps={[{ id: "1", content: "Do it", status: "pending" }]}
        title="T"
      />,
    );
    expect(screen.getByText("1 task")).toBeTruthy();
    expect(screen.queryByText("Do it")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Read detailed plan" }));
    expect(screen.getByText("Do it")).toBeTruthy();
    expect(document.querySelector("[data-plan-preview]")?.getAttribute("data-plan-preview")).toBe(
      "expanded",
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse plan" }));
    expect(screen.queryByText("Do it")).toBeNull();
  });
});

describe("PlanTimelineCard (adapter)", () => {
  it("shows the writing state from args while streaming", () => {
    render(
      <PlanTimelineCard
        args={{ title: "From args", content: "x" }}
        isComplete={false}
        isError={false}
      />,
    );
    expect(screen.getByText("Writing the plan")).toBeTruthy();
    expect(screen.getByText("From args")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open plan" })).toBeNull();
  });

  it("ready plan: file name, copy/open actions, tasks with status", () => {
    const onOpen = vi.fn();
    render(<PlanTimelineCard isComplete isError={false} onOpen={onOpen} plan={plan} />);
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("plan.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open plan" }));
    expect(onOpen).toHaveBeenCalledWith(plan);
    expect(screen.getByRole("button", { name: /Copy plan/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand plan" }));
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByText("Run checks").className).toContain("line-through");
  });
});
