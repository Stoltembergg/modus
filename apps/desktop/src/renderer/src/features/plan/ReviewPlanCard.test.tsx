// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  revisedContent: "# Revised release plan",
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

const draft = {
  draftId: "draft-1",
  revision: {
    title: "Revised release readiness",
    overview: "A safer release plan.",
    content: "# Revised release plan\n\nRun the checks before publishing.",
    todos: [
      {
        id: "todo-revised",
        content: "Run revised checks",
        acceptanceCriterionIds: ["criterion-revised"],
      },
    ],
    spec: {
      requirements: [{ id: "requirement-revised", text: "Verify release artifacts" }],
      acceptanceCriteria: [
        {
          id: "criterion-revised",
          requirementId: "requirement-revised",
          description: "Every release artifact is verified",
          todoIds: ["todo-revised"],
          requiredCheckKinds: ["tests" as const],
        },
      ],
      assumptions: ["The release candidate is already available."],
      openQuestions: ["Which team owns the final sign-off?"],
    },
  },
};

afterEach(cleanup);

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

  it("shows the animated reviewing state and disables duplicate review", () => {
    const loading = renderCard({
      hyperPlanStatus: "reviewing",
      onReviewWithHyperPlan: vi.fn(),
    });

    expect(loading).toContain('role="status"');
    expect(loading).toContain("Reviewing plan with HyperPlan");
    expect(loading).toContain('alt="HyperPlan review in progress"');
    expect(loading).toContain("disabled");
  });

  it("shows the revised plan and explicit choices after a successful review", () => {
    const markup = renderCard({
      hyperPlanStatus: "completed",
      hyperPlanSummary: summary,
      onUseRevisedPlan: vi.fn(),
      onKeepPreviousPlan: vi.fn(),
    });

    expect(markup).toContain("Revised plan preview");
    expect(markup).toContain("# Revised release plan");
    expect(markup).not.toContain("HyperPlan review in progress");
    expect(markup).toContain("Usar plano revisado");
    expect(markup).toContain("Manter plano anterior");
    expect(markup).toContain("Architecture");
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Keep release checks together.");
    expect(markup).toContain("The release may be delayed if checks fail.");
    expect(markup).toContain("Who approves the release?");
    expect(markup).not.toContain("transcript");
    expect(markup).toContain("Yes, implement this plan");
  });

  it("shows only the centered thinking treatment while review is loading", () => {
    const markup = renderCard({ hyperPlanState: { status: "loading" } });

    expect(markup).toContain('data-testid="hyperplan-gif"');
    expect(markup).toContain("Thinking");
    expect(markup).not.toContain("Implement this plan?");
    expect(markup).not.toContain("Acceptance criteria");
    expect(markup).not.toContain("Yes, implement this plan");
    expect(markup).not.toContain("Prepare the release safely.");
  });

  it("shows only the revised plan and dispatches the exact selected choice", async () => {
    const user = userEvent.setup();
    const onChoosePlan = vi.fn();
    const { container } = render(
      <ReviewPlanCard
        onBuildLocally={vi.fn()}
        onContinuePlanning={vi.fn()}
        onChoosePlan={onChoosePlan}
        hyperPlanState={{ status: "ready", preview: draft }}
        plan={plan}
        hyperPlanSummary={summary}
      />,
    );

    expect(container.textContent).toContain("Revised release readiness");
    expect(container.textContent).toContain("Run the checks before publishing.");
    expect(container.textContent).toContain("Run revised checks");
    expect(container.textContent).toContain("Verify release artifacts");
    expect(container.textContent).toContain("Every release artifact is verified");
    expect(container.textContent).toContain("The release candidate is already available.");
    expect(container.textContent).toContain("Which team owns the final sign-off?");
    expect(container.textContent).not.toContain("Prepare the release safely.");
    expect(container.textContent).not.toContain("All release checks pass");
    expect(container.textContent).not.toContain("Keep release checks together.");
    expect(screen.getAllByRole("button")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Accept revised plan and build" }));
    expect(onChoosePlan).toHaveBeenLastCalledWith("revision");

    cleanup();
    render(
      <ReviewPlanCard
        onBuildLocally={vi.fn()}
        onContinuePlanning={vi.fn()}
        onChoosePlan={onChoosePlan}
        hyperPlanState={{ status: "ready", preview: draft }}
        plan={plan}
      />,
    );
    const originalUser = userEvent.setup();
    await originalUser.click(screen.getByRole("button", { name: "Build the original plan" }));
    expect(onChoosePlan).toHaveBeenLastCalledWith("original");
  });

  it("blocks repeated choices while a choice is being resolved", async () => {
    const user = userEvent.setup();
    const onChoosePlan = vi.fn();
    render(
      <ReviewPlanCard
        onBuildLocally={vi.fn()}
        onContinuePlanning={vi.fn()}
        onChoosePlan={onChoosePlan}
        hyperPlanState={{ status: "ready", preview: draft }}
        plan={plan}
      />,
    );

    const accept = screen.getByRole("button", { name: "Accept revised plan and build" });
    await user.dblClick(accept);
    expect(onChoosePlan).toHaveBeenCalledTimes(1);
    expect(onChoosePlan).toHaveBeenCalledWith("revision");
  });

  it("only retries the same choice after an uncertain choice result", async () => {
    const user = userEvent.setup();
    const onChoosePlan = vi.fn();
    render(
      <ReviewPlanCard
        onBuildLocally={vi.fn()}
        onContinuePlanning={vi.fn()}
        onChoosePlan={onChoosePlan}
        hyperPlanState={{ status: "choice-error", preview: draft, choice: "revision" }}
        plan={plan}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "Build the original plan" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Retry revised plan choice" }));
    expect(onChoosePlan).toHaveBeenCalledOnce();
    expect(onChoosePlan).toHaveBeenCalledWith("revision");
  });

  it("retries a failed explicit original start without offering another review", async () => {
    const user = userEvent.setup();
    const onChoosePlan = vi.fn();
    const onReviewWithHyperPlan = vi.fn();
    render(
      <ReviewPlanCard
        onBuildLocally={vi.fn()}
        onContinuePlanning={vi.fn()}
        onChoosePlan={onChoosePlan}
        onReviewWithHyperPlan={onReviewWithHyperPlan}
        hyperPlanState={{ status: "review-error", originalStart: "error" }}
        plan={plan}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "Try review again" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Retry original plan build" }));
    expect(onChoosePlan).toHaveBeenCalledExactlyOnceWith("original");
    expect(onReviewWithHyperPlan).not.toHaveBeenCalled();
  });

  it("shows a safe review failure reason while keeping retry and original build actions", () => {
    render(
      <ReviewPlanCard
        onBuildLocally={vi.fn()}
        onContinuePlanning={vi.fn()}
        onChoosePlan={vi.fn()}
        onReviewWithHyperPlan={vi.fn()}
        hyperPlanState={{
          status: "review-error",
          reason: "No model available for HyperPlan review. Choose a model in Spec and try again.",
        }}
        plan={plan}
      />,
    );

    expect(screen.getByRole("heading", { name: "Review unavailable" })).toBeTruthy();
    expect(
      screen.getByText(
        "No model available for HyperPlan review. Choose a model in Spec and try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Your original plan is unchanged.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try review again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build the original plan" })).toBeTruthy();
  });
});
