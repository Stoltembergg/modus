import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HyperPlanSummary, PlanRef } from "../../../../shared/contracts";
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

const summary = {
  critiques: [
    {
      critic: "architecture",
      status: "completed",
      findings: ["Keep the release checks in one workflow."],
      references: ["apps/desktop/src/main/release.ts"],
    },
    { critic: "risk", status: "unavailable", findings: [], references: [] },
    {
      critic: "simplicity",
      status: "completed",
      findings: ["The scope is focused."],
      references: [],
    },
    { critic: "failure", status: "completed", findings: [], references: [] },
  ],
  agreements: ["Keep release checks together."],
  disagreements: [],
  risks: ["The release may be delayed if checks fail."],
  openQuestions: ["Who approves the release?"],
  references: ["apps/desktop/src/main/release.ts"],
} satisfies HyperPlanSummary;

function renderCard(props: Partial<Parameters<typeof ReviewPlanCard>[0]> = {}) {
  return renderToStaticMarkup(
    <ReviewPlanCard onBuildLocally={vi.fn()} onContinuePlanning={vi.fn()} plan={plan} {...props} />,
  );
}

describe("ReviewPlanCard", () => {
  it("keeps HyperPlan opt-in and separate from the explicit Build action", () => {
    const markup = renderCard({ onReviewWithHyperPlan: vi.fn() });

    expect(markup).toContain("Review with HyperPlan");
    expect(markup).toContain("Yes, implement this plan");
    expect(markup).toContain("Acceptance criteria");
  });

  it("does not offer HyperPlan for a plan without Spec metadata", () => {
    const { spec: _spec, ...ordinaryPlan } = plan;
    const markup = renderCard({ plan: ordinaryPlan });

    expect(markup).not.toContain("Review with HyperPlan");
  });

  it("shows loading and a generic error without exposing raw error details", () => {
    const loading = renderCard({ hyperPlanStatus: "loading" });
    const error = renderCard({ hyperPlanStatus: "error" });

    expect(loading).toContain("Reviewing plan…");
    expect(error).toContain("Review unavailable. Try again.");
    expect(error).not.toContain("secret raw error");
  });

  it("shows critic statuses and structured summary fields without transcripts", () => {
    const markup = renderCard({ hyperPlanStatus: "completed", hyperPlanSummary: summary });

    expect(markup).toContain("Architecture");
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Keep release checks together.");
    expect(markup).toContain("The release may be delayed if checks fail.");
    expect(markup).toContain("Who approves the release?");
    expect(markup).not.toContain("transcript");
    expect(markup).toContain("Yes, implement this plan");
  });
});
