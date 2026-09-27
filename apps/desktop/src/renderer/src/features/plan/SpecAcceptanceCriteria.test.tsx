import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlanSpec } from "../../../../shared/contracts";
import { criterionEvidenceStatus, SpecAcceptanceCriteria } from "./SpecAcceptanceCriteria";

const spec: PlanSpec = {
  requirements: [{ id: "req-auth", text: "Keep access controlled" }],
  acceptanceCriteria: [
    {
      id: "ac-auth",
      requirementId: "req-auth",
      description: "Reject unauthenticated requests",
      todoIds: ["todo-auth"],
      requiredCheckKinds: ["tests", "typecheck"],
      status: "passed",
    },
  ],
  evidence: [
    {
      id: "evidence-old-failed",
      criterionId: "ac-auth",
      kind: "check",
      status: "failed",
      runId: "run-41",
      eventId: "event-23",
      revision: "rev-6",
      label: "Tests",
    },
    {
      id: "evidence-tests",
      criterionId: "ac-auth",
      kind: "check",
      status: "passed",
      runId: "run-42",
      eventId: "event-24",
      revision: "rev-7",
      paths: ["src/auth.ts"],
      label: "Tests",
    },
    {
      id: "evidence-typecheck",
      criterionId: "ac-auth",
      kind: "check",
      status: "passed",
      runId: "run-42",
      eventId: "event-25",
      revision: "rev-7",
      paths: ["src/auth.ts"],
      label: "Typecheck",
    },
  ],
  assumptions: [],
  openQuestions: [],
};

describe("criterionEvidenceStatus", () => {
  it("requires linked passing evidence before showing a passed criterion", () => {
    expect(criterionEvidenceStatus("passed", [])).toBe("unverified");
    expect(
      criterionEvidenceStatus(
        "passed",
        spec.evidence.filter((evidence) => evidence.runId === "run-42"),
        ["tests", "typecheck"],
      ),
    ).toBe("passed");
    expect(
      criterionEvidenceStatus(
        "passed",
        spec.evidence.filter((evidence) => evidence.runId === "run-41"),
        ["tests", "typecheck"],
      ),
    ).toBe("failed");
  });

  it("does not override a non-passed criterion status with passing evidence", () => {
    expect(criterionEvidenceStatus("pending", spec.evidence)).toBe("pending");
    expect(
      criterionEvidenceStatus(
        "failed",
        spec.evidence.filter((evidence) => evidence.runId === "run-42"),
        ["tests", "typecheck"],
      ),
    ).toBe("failed");
  });
});

describe("SpecAcceptanceCriteria", () => {
  it("shows required checks and bounded linked evidence", () => {
    const markup = renderToStaticMarkup(<SpecAcceptanceCriteria spec={spec} />);

    expect(markup).toContain("Reject unauthenticated requests");
    expect(markup).toContain("Tests");
    expect(markup).toContain("Typecheck");
    expect(markup).toContain("Tests");
    expect(markup).toContain("Typecheck");
    expect(markup).toContain("run-42");
    expect(markup).toContain("event-24");
    expect(markup).toContain("rev-7");
    expect(markup).toContain("src/auth.ts");
    expect(markup).toContain("Passed");
    expect(markup).toContain("Earlier evidence");
    expect(markup).toContain("Run run-41");
    expect(markup.indexOf("Run run-42")).toBeLessThan(markup.indexOf("Earlier evidence"));
  });

  it("does not present passed without evidence as complete", () => {
    const withoutEvidence = { ...spec, evidence: [] };
    const markup = renderToStaticMarkup(<SpecAcceptanceCriteria spec={withoutEvidence} />);

    expect(markup).toContain("Not verified");
    expect(markup).not.toContain(">Passed<");
  });

  it("does not treat unscoped evidence as evidence from a Build run", () => {
    const withoutRunReference = {
      ...spec,
      evidence: spec.evidence
        .filter((item) => item.runId === "run-42" && item.label === "Tests")
        .map(({ runId: _runId, ...item }) => item),
    };
    const markup = renderToStaticMarkup(<SpecAcceptanceCriteria spec={withoutRunReference} />);

    expect(markup).toContain("Not verified");
    expect(markup).toContain("Earlier evidence (1)");
    expect(markup).not.toContain(">Passed<");
  });

  it("keeps a passed criterion unverified when the latest run lacks a required check", () => {
    const latestRunMissingTypecheck = {
      ...spec,
      evidence: spec.evidence.filter((item) => item.runId !== "run-42" || item.label === "Tests"),
    };
    const markup = renderToStaticMarkup(
      <SpecAcceptanceCriteria spec={latestRunMissingTypecheck} />,
    );

    expect(markup).toContain("Not verified");
    expect(markup).not.toContain(">Passed<");
  });

  it("does not let old failed evidence override a later passing run status", () => {
    const markup = renderToStaticMarkup(<SpecAcceptanceCriteria spec={spec} />);

    expect(markup).toContain(">Passed<");
    expect(markup).not.toContain(">Failed<");
  });

  it("does not show Passed when the latest run has failed evidence", () => {
    const latestRunFailed = {
      ...spec,
      evidence: spec.evidence.map((item) =>
        item.runId === "run-42" && item.label === "Tests"
          ? { ...item, status: "failed" as const }
          : item,
      ),
    };
    const markup = renderToStaticMarkup(<SpecAcceptanceCriteria spec={latestRunFailed} />);

    expect(markup).toContain(">Failed<");
    expect(markup).not.toContain(">Passed<");
  });
});
