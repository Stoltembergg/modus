import { describe, expect, it } from "vitest";
import {
  classifySupervisedAsk,
  composeSupervisedFlowSection,
  planSupervisedCodeFlow,
} from "./group-supervised-flow";

const roster = [
  { sessionId: "lead", title: "Planner", role: "Lead" },
  { sessionId: "build", title: "Builder", role: "Builder" },
  { sessionId: "review", title: "Reviewer", role: "Reviewer" },
] as const;

describe("classifySupervisedAsk", () => {
  it("detects social, docs, trivial, design, review-only, and code asks", () => {
    expect(classifySupervisedAsk("hi team")).toBe("social");
    expect(classifySupervisedAsk("Update the README with install steps")).toBe("docs");
    expect(classifySupervisedAsk("fix typo in the error string")).toBe("trivial");
    expect(classifySupervisedAsk("Propose an architecture approach for auth")).toBe("design");
    expect(classifySupervisedAsk("Please review this PR for edge cases")).toBe("review-only");
    expect(classifySupervisedAsk("Implement the login feature with tests")).toBe("code");
  });
});

describe("planSupervisedCodeFlow skippable stages", () => {
  it("does not apply to social or simple questions", () => {
    const social = planSupervisedCodeFlow({
      body: "hey",
      members: roster,
      leadSessionId: "lead",
    });
    expect(social.applies).toBe(false);
    expect(social.delegations).toEqual([]);

    const question = planSupervisedCodeFlow({
      body: "What is the Groups model?",
      members: roster,
      leadSessionId: "lead",
    });
    expect(question.applies).toBe(false);
  });

  it("keeps all stages for full code work and requires Builder + Reviewer tools", () => {
    const plan = planSupervisedCodeFlow({
      body: "Implement workspace symlink escape fixes with tests",
      members: roster,
      leadSessionId: "lead",
    });
    expect(plan.applies).toBe(true);
    expect(plan.kind).toBe("code");
    expect(plan.stages.map((stage) => [stage.id, stage.skip])).toEqual([
      ["plan", false],
      ["implement", false],
      ["review", false],
      ["deliver", false],
    ]);
    expect(plan.stages.find((stage) => stage.id === "plan")?.ownerSessionId).toBe("lead");
    expect(plan.stages.find((stage) => stage.id === "implement")?.ownerSessionId).toBe("build");
    expect(plan.stages.find((stage) => stage.id === "review")?.ownerSessionId).toBe("review");
    expect(plan.stages.find((stage) => stage.id === "deliver")?.ownerSessionId).toBe("lead");
    expect(plan.delegations).toEqual([
      expect.objectContaining({
        stage: "implement",
        tool: "group_handoff",
        memberId: "build",
      }),
      expect.objectContaining({
        stage: "review",
        tool: "group_request_review",
        memberId: "review",
      }),
    ]);
  });

  it("skips Reviewer for docs-only asks but still plans implement + deliver", () => {
    const plan = planSupervisedCodeFlow({
      body: "Update the README documentation for Groups setup",
      members: roster,
      leadSessionId: "lead",
    });
    expect(plan.applies).toBe(true);
    expect(plan.kind).toBe("docs");
    expect(plan.stages.find((stage) => stage.id === "review")).toMatchObject({
      skip: true,
      reason: expect.stringContaining("docs-only"),
    });
    expect(plan.stages.filter((stage) => !stage.skip).map((stage) => stage.id)).toEqual([
      "plan",
      "implement",
      "deliver",
    ]);
    expect(plan.delegations.map((item) => item.stage)).toEqual(["implement"]);
    expect(plan.delegations.some((item) => item.stage === "review")).toBe(false);
  });

  it("skips plan and review for trivial fixes", () => {
    const plan = planSupervisedCodeFlow({
      body: "Fix typo in the button label",
      members: roster,
      leadSessionId: "lead",
    });
    expect(plan.kind).toBe("trivial");
    expect(plan.stages.filter((stage) => stage.skip).map((stage) => stage.id)).toEqual([
      "plan",
      "review",
    ]);
    expect(plan.delegations.map((item) => item.stage)).toEqual(["implement"]);
  });

  it("skips implement and review for design-only asks", () => {
    const plan = planSupervisedCodeFlow({
      body: "Propose an architecture approach for the queue",
      members: roster,
      leadSessionId: "lead",
    });
    expect(plan.kind).toBe("design");
    expect(plan.stages.filter((stage) => stage.skip).map((stage) => stage.id)).toEqual([
      "implement",
      "review",
    ]);
    expect(plan.delegations).toEqual([]);
  });

  it("skips plan and implement for review-only asks", () => {
    const plan = planSupervisedCodeFlow({
      body: "Please review this PR for regressions",
      members: roster,
      leadSessionId: "lead",
    });
    expect(plan.kind).toBe("review-only");
    expect(plan.stages.filter((stage) => stage.skip).map((stage) => stage.id)).toEqual([
      "plan",
      "implement",
    ]);
    expect(plan.delegations).toEqual([
      expect.objectContaining({
        stage: "review",
        tool: "group_request_review",
        memberId: "review",
      }),
    ]);
  });

  it("omits Builder/Reviewer delegations when those members are absent", () => {
    const plan = planSupervisedCodeFlow({
      body: "Implement feature X with tests",
      members: [{ sessionId: "lead", title: "Planner", role: "Lead" }],
      leadSessionId: "lead",
    });
    expect(plan.applies).toBe(true);
    expect(plan.delegations).toEqual([]);
    expect(plan.stages.find((stage) => stage.id === "implement")?.ownerSessionId).toBe("lead");
  });
});

describe("composeSupervisedFlowSection", () => {
  it("returns empty when the flow does not apply", () => {
    const plan = planSupervisedCodeFlow({
      body: "hi",
      members: roster,
      leadSessionId: "lead",
    });
    expect(composeSupervisedFlowSection(plan)).toBe("");
  });

  it("lists skip reasons and required tool delegations for code work", () => {
    const code = planSupervisedCodeFlow({
      body: "Implement the login feature with tests",
      members: roster,
      leadSessionId: "lead",
    });
    const section = composeSupervisedFlowSection(code);
    expect(section).toContain("<supervised_flow>");
    expect(section).toContain("group_handoff");
    expect(section).toContain("group_request_review");
    expect(section).toContain("memberId=build");
    expect(section).toContain("memberId=review");
    expect(section).toContain("implement: RUN");
    expect(section).toContain("review: RUN");

    const docs = planSupervisedCodeFlow({
      body: "Update the README documentation",
      members: roster,
      leadSessionId: "lead",
    });
    const docsSection = composeSupervisedFlowSection(docs);
    expect(docsSection).toContain("review: SKIP");
    expect(docsSection).toContain("docs-only");
    expect(docsSection).not.toContain("memberId=review");
  });
});
