// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanRef } from "../../../../shared/contracts";
import { ReviewPlanCard } from "./ReviewPlanCard";

const plan: PlanRef = {
  id: "plan-1",
  title: "Release readiness",
  overview: "Prepare the release safely.",
  path: "/workspace/plan.md",
  hash: "hash-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  blocks: [{ type: "markdown", content: "# Release" }],
  content: "# Release",
  todos: [{ id: "todo-1", content: "Run release checks", status: "pending" }],
  spec: {
    requirements: [{ id: "req-1", text: "Release safely" }],
    acceptanceCriteria: [
      {
        id: "criterion-1",
        requirementId: "req-1",
        description: "All release checks pass",
        todoIds: ["todo-1"],
        requiredCheckKinds: ["tests"],
        status: "pending",
      },
    ],
    evidence: [],
    assumptions: [],
    openQuestions: [],
  },
  buildStatus: "not_built",
  createdAt: "now",
  updatedAt: "now",
};

afterEach(cleanup);
describe("Plan review", () => {
  it("preserves structured acceptance and offers only explicit implementation or further planning", () => {
    render(<ReviewPlanCard plan={plan} onBuildLocally={() => {}} onContinuePlanning={() => {}} />);
    expect(screen.getByText("All release checks pass")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Yes, implement/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /No, tell Modus/ })).toBeTruthy();
    expect(screen.queryByText(/HyperPlan/)).toBeNull();
  });
  it("blocks duplicate approval and shortcut while the build is starting", () => {
    const start = vi.fn();
    const view = render(
      <ReviewPlanCard busy plan={plan} onBuildLocally={start} onContinuePlanning={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Starting plan/ }));
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(start).not.toHaveBeenCalled();
    view.rerender(
      <ReviewPlanCard plan={plan} onBuildLocally={start} onContinuePlanning={() => {}} />,
    );
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(start).toHaveBeenCalledOnce();
  });
  it("still approves old plans without structured criteria", () => {
    const { spec: _spec, ...oldPlan } = plan;
    render(
      <ReviewPlanCard plan={oldPlan} onBuildLocally={() => {}} onContinuePlanning={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /Yes, implement/ })).toBeTruthy();
  });
});
