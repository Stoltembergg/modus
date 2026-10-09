// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlanRef } from "../../../../shared/contracts";
import { PlanPanel } from "./PlanPanel";

const plan: PlanRef = {
  id: "plan-1",
  title: "Account security",
  overview: "Protect account access.",
  path: "/workspace/plan.md",
  hash: "hash-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  blocks: [{ type: "markdown", content: "# Keep the plan readable" }],
  content: "# Keep the plan readable",
  todos: [],
  spec: {
    requirements: [{ id: "req-1", text: "Protect account access" }],
    acceptanceCriteria: [
      {
        id: "criterion-1",
        requirementId: "req-1",
        description: "Reject invalid credentials",
        todoIds: [],
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

describe("PlanPanel", () => {
  it("keeps the Markdown plan and adds Spec acceptance details", () => {
    const markup = renderToStaticMarkup(<PlanPanel plan={plan} />);

    expect(markup).toContain("Keep the plan readable");
    expect(markup).toContain("Acceptance criteria");
    expect(markup).toContain("Reject invalid credentials");
  });

  it("revalidates persisted QA against the current source revision", async () => {
    const runWorkspaceRevision = vi.fn().mockResolvedValue("rev-current");
    const originalModus = Object.getOwnPropertyDescriptor(window, "modus");
    const spec = plan.spec;
    if (!spec) throw new Error("Test plan requires a Spec.");
    const passedPlan: PlanRef = {
      ...plan,
      spec: {
        ...spec,
        acceptanceCriteria: [
          {
            ...spec.acceptanceCriteria[0],
            requiredCheckKinds: ["tests"],
            status: "passed",
          },
        ],
        evidence: [
          {
            id: "evidence-tests",
            criterionId: "criterion-1",
            kind: "check",
            status: "passed",
            runId: "run-qa",
            eventId: "event-qa",
            revision: "rev-verified",
            label: "Tests",
          },
        ],
      },
    };
    Object.defineProperty(window, "modus", {
      configurable: true,
      value: {
        agent: { runWorkspaceRevision },
        files: {
          watch: vi.fn(async (cwd: string) => cwd),
          unwatch: vi.fn(async () => undefined),
          onChanged: vi.fn(() => () => undefined),
        },
      },
    });

    try {
      render(<PlanPanel plan={passedPlan} />);

      await waitFor(() => {
        expect(runWorkspaceRevision).toHaveBeenCalledWith({
          sessionId: passedPlan.sessionId,
          runId: "run-qa",
        });
        expect(screen.getByText("Not verified")).toBeTruthy();
      });
    } finally {
      cleanup();
      if (originalModus) Object.defineProperty(window, "modus", originalModus);
      else Reflect.deleteProperty(window, "modus");
    }
  });
});
