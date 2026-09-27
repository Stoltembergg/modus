import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
});
