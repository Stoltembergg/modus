import { describe, expect, it } from "vitest";
import type { GroupTask } from "./contracts";
import { evaluateGroupTaskGate, validateGroupTaskDraft } from "./group-task-policy";
import type { GroupTaskDraft, GroupTaskReview } from "./group-work-state";

const fingerprint = "source-1";

function task(overrides: Partial<GroupTask> = {}): GroupTask {
  return {
    id: "task-1",
    groupId: "group-1",
    title: "Implement",
    status: "in_review",
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    kind: "code",
    priority: "normal",
    dependencyIds: [],
    criteria: [{ id: "criterion-1", description: "Tests pass", requiredCheckKinds: ["tests"] }],
    criteriaVersion: 2,
    verificationPolicy: { mode: "required", requireReview: true },
    evidenceRefs: [],
    stateVersion: 3,
    reviewerSessionId: "reviewer-1",
    ...overrides,
  };
}

function draft(overrides: Partial<GroupTaskDraft> = {}): GroupTaskDraft {
  return {
    groupId: "group-1",
    title: "Implement",
    kind: "code",
    priority: "normal",
    dependencyIds: [],
    criteria: [{ id: "criterion-1", description: "Tests pass", requiredCheckKinds: ["tests"] }],
    verificationPolicy: { mode: "required", requireReview: true },
    reviewerSessionId: "reviewer-1",
    ...overrides,
  };
}

function review(overrides: Partial<GroupTaskReview> = {}): GroupTaskReview {
  return {
    reviewerSessionId: "reviewer-1",
    verdict: "approve",
    criteriaVersion: 2,
    sourceFingerprint: fingerprint,
    eventId: "review-event-1",
    approvedCriterionIds: ["criterion-1"],
    ...overrides,
  };
}

function multiCriterionQaInput(approvedCriterionIds: string[]) {
  return {
    task: task({
      criteria: [
        { id: "criterion-1", description: "Tests pass", requiredCheckKinds: ["tests"] },
        { id: "criterion-2", description: "Types pass", requiredCheckKinds: ["typecheck"] },
      ],
    }),
    review: review({ approvedCriterionIds }),
    sourceFingerprint: fingerprint,
    dependencies: [],
    criterionOutcomes: ["criterion-1", "criterion-2"].map((criterionId) => ({
      criterionId,
      criteriaVersion: 2,
      status: "passed" as const,
      sourceFingerprint: fingerprint,
    })),
  };
}

describe("group task policy", () => {
  it("required_qa_is_not_satisfied_by_user_confirmation", () => {
    const input = {
      task: task(),
      review: review(),
      sourceFingerprint: fingerprint,
      dependencies: [],
    };
    for (const status of [
      "user_confirmed",
      "missing",
      "unavailable",
      "skipped",
      "failed",
    ] as const) {
      expect(
        evaluateGroupTaskGate({
          ...input,
          criterionOutcomes: [
            {
              criterionId: "criterion-1",
              criteriaVersion: 2,
              status,
              sourceFingerprint: fingerprint,
            },
          ],
        }).satisfied,
      ).toBe(false);
    }
    expect(
      evaluateGroupTaskGate({
        ...input,
        criterionOutcomes: [
          {
            criterionId: "criterion-1",
            criteriaVersion: 2,
            status: "passed",
            sourceFingerprint: fingerprint,
          },
        ],
      }).satisfied,
    ).toBe(true);
  });

  it("review_is_bound_to_criteria_and_source", () => {
    const current = {
      task: task(),
      review: review(),
      sourceFingerprint: fingerprint,
      dependencies: [],
      criterionOutcomes: [
        {
          criterionId: "criterion-1",
          criteriaVersion: 2,
          status: "passed" as const,
          sourceFingerprint: fingerprint,
        },
      ],
    };
    expect(evaluateGroupTaskGate(current).satisfied).toBe(true);
    expect(
      evaluateGroupTaskGate({ ...current, review: review({ criteriaVersion: 1 }) }).satisfied,
    ).toBe(false);
    expect(
      evaluateGroupTaskGate({ ...current, review: review({ sourceFingerprint: "old-source" }) })
        .satisfied,
    ).toBe(false);
    expect(evaluateGroupTaskGate({ ...current, sourceFingerprint: "new-source" }).satisfied).toBe(
      false,
    );
    expect(
      evaluateGroupTaskGate({ ...current, review: review({ reviewerSessionId: "other-reviewer" }) })
        .satisfied,
    ).toBe(false);
    expect(
      evaluateGroupTaskGate({ ...current, review: review({ verdict: "changes" }) }).satisfied,
    ).toBe(false);
  });

  it("required_review_with_empty_approved_ids_cannot_complete_qa_criteria", () => {
    expect(evaluateGroupTaskGate(multiCriterionQaInput([])).satisfied).toBe(false);
  });

  it("required_review_with_partial_approved_ids_cannot_complete_qa_criteria", () => {
    expect(evaluateGroupTaskGate(multiCriterionQaInput(["criterion-1"])).satisfied).toBe(false);
    expect(
      evaluateGroupTaskGate(multiCriterionQaInput(["criterion-1", "criterion-2"])).satisfied,
    ).toBe(true);
  });

  it("rejects_dependency_cycles_and_cross_group_ids", () => {
    const a = task({ id: "a", dependencyIds: ["b"] });
    const b = task({ id: "b", dependencyIds: ["a"] });
    expect(
      validateGroupTaskDraft(draft({ dependencyIds: ["a"] }), [a, b]).issues.map(
        (issue) => issue.code,
      ),
    ).toContain("dependency-cycle");
    expect(
      validateGroupTaskDraft(draft({ dependencyIds: ["foreign"] }), [
        task({ id: "foreign", groupId: "group-2" }),
      ]).issues.map((issue) => issue.code),
    ).toContain("invalid-dependency");
    expect(
      validateGroupTaskDraft(draft({ dependencyIds: ["missing"] }), []).issues.map(
        (issue) => issue.code,
      ),
    ).toContain("invalid-dependency");
  });

  it("required_policy_rejects_empty_criteria", () => {
    expect(
      validateGroupTaskDraft(draft({ criteria: [] }), []).issues.map((issue) => issue.code),
    ).toContain("verification-required");
    expect(
      evaluateGroupTaskGate({
        task: task({ criteria: [] }),
        criterionOutcomes: [],
        review: review(),
        sourceFingerprint: fingerprint,
        dependencies: [],
      }).satisfied,
    ).toBe(false);
  });

  it("criterion_without_checks_needs_current_review", () => {
    const criteria = [{ id: "criterion-1", description: "Looks good", requiredCheckKinds: [] }];
    const noChecks = task({ criteria });
    expect(
      validateGroupTaskDraft(
        draft({ criteria, verificationPolicy: { mode: "required", requireReview: false } }),
        [],
      ).issues.map((issue) => issue.code),
    ).toContain("verification-required");
    const input = {
      task: noChecks,
      review: review(),
      sourceFingerprint: fingerprint,
      dependencies: [],
    };
    expect(
      evaluateGroupTaskGate({
        ...input,
        criterionOutcomes: [
          {
            criterionId: "criterion-1",
            criteriaVersion: 2,
            status: "passed",
            sourceFingerprint: fingerprint,
          },
        ],
      }).satisfied,
    ).toBe(false);
    expect(
      evaluateGroupTaskGate({
        ...input,
        review: review({ approvedCriterionIds: [] }),
        criterionOutcomes: [
          {
            criterionId: "criterion-1",
            criteriaVersion: 2,
            status: "review_approved",
            sourceFingerprint: fingerprint,
          },
        ],
      }).satisfied,
    ).toBe(false);
    expect(
      evaluateGroupTaskGate({
        ...input,
        criterionOutcomes: [
          {
            criterionId: "criterion-1",
            criteriaVersion: 2,
            status: "review_approved",
            sourceFingerprint: fingerprint,
          },
        ],
      }).satisfied,
    ).toBe(true);
  });

  it("legacy_none_policy_can_complete", () => {
    const legacy = task({
      kind: "legacy",
      criteria: [],
      criteriaVersion: 1,
      verificationPolicy: { mode: "none", requireReview: false },
    });
    expect(
      evaluateGroupTaskGate({
        task: legacy,
        criterionOutcomes: [],
        sourceFingerprint: "",
        dependencies: [],
      }),
    ).toEqual({ satisfied: true, reasonCodes: [] });
    expect(
      evaluateGroupTaskGate({
        task: task({ dependencyIds: ["dep"] }),
        criterionOutcomes: [
          {
            criterionId: "criterion-1",
            criteriaVersion: 2,
            status: "passed",
            sourceFingerprint: fingerprint,
          },
        ],
        review: review(),
        sourceFingerprint: fingerprint,
        dependencies: [{ id: "dep", status: "open" }],
      }).satisfied,
    ).toBe(false);
  });
});
