import { describe, expect, it, vi } from "vitest";
import type { PlanRef } from "../../../../shared/contracts";
import {
  createHyperPlanOperations,
  hyperPlanSourceProjection,
  reconcileHyperPlanReview,
  safeHyperPlanReviewReason,
} from "./ChatPane";

const preview = {
  draftId: "draft-1",
  revision: {
    title: "Revised plan",
    overview: "A safer approach.",
    content: "\n# Revised\n",
    todos: [{ id: "todo-1", content: "Implement safely" }],
    spec: {
      requirements: [{ id: "req-1", text: "Preserve safety" }],
      acceptanceCriteria: [
        {
          id: "criterion-1",
          requirementId: "req-1",
          description: "Tests pass",
          todoIds: ["todo-1"],
        },
      ],
      assumptions: ["The service is available"],
      openQuestions: ["Which environment first?"],
    },
  },
};

function promotedPlan(overrides: Partial<PlanRef> = {}): PlanRef {
  return {
    id: "plan-1",
    hash: "promoted-hash",
    title: preview.revision.title,
    overview: preview.revision.overview,
    content: preview.revision.content.trim(),
    todos: preview.revision.todos.map((todo) => ({ ...todo, status: "pending" as const })),
    spec: {
      ...preview.revision.spec,
      acceptanceCriteria: preview.revision.spec.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        status: "pending" as const,
      })),
      evidence: [],
    },
    path: "/plans/plan-1.md",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    blocks: [{ type: "markdown", content: preview.revision.content.trim() }],
    buildStatus: "not_built",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function sourceSnapshot(plan: PlanRef) {
  return {
    title: plan.title,
    overview: plan.overview,
    content: plan.content,
    todos: plan.todos.map(({ id, content, acceptanceCriterionIds }) => ({
      id,
      content,
      acceptanceCriterionIds: acceptanceCriterionIds ?? [],
    })),
    spec: plan.spec && {
      requirements: plan.spec.requirements,
      acceptanceCriteria: plan.spec.acceptanceCriteria,
      assumptions: plan.spec.assumptions,
      openQuestions: plan.spec.openQuestions,
      evidence: plan.spec.evidence,
    },
  };
}

function createApi() {
  return {
    createHyperPlanDraft: vi.fn().mockResolvedValue(preview),
    resolveHyperPlanDraft: vi.fn().mockResolvedValue({
      selectionId: "selection-1",
      plan: { id: "authoritative-plan-must-not-be-used" },
      planFingerprint: "fingerprint-must-not-be-used",
    }),
    startPlanBuild: vi.fn().mockResolvedValue({ runId: "run-1" }),
    startOriginalPlanBuild: vi.fn().mockResolvedValue({ runId: "run-original" }),
  };
}

describe("HyperPlan renderer operations", () => {
  it("snapshots legacy plans with empty evidence and reconciles an unchanged original fallback", async () => {
    const api = createApi();
    const operations = createHyperPlanOperations(api, () => "legacy-original-request");
    const latestPlan = promotedPlan();
    if (!latestPlan.spec) throw new Error("Expected a Spec plan.");
    const { evidence: _evidence, ...legacySpec } = latestPlan.spec;
    const legacyPlan = { ...latestPlan, spec: legacySpec } as unknown as PlanRef;
    const snapshot = hyperPlanSourceProjection(legacyPlan);
    const review = {
      planId: legacyPlan.id,
      planHash: legacyPlan.hash,
      sourceSnapshot: snapshot,
      status: "review-error" as const,
    };

    expect(snapshot.spec?.evidence).toEqual([]);
    expect(reconcileHyperPlanReview(review, legacyPlan)).toEqual({ review, invalidate: false });
    await operations.buildOriginal({
      sessionId: legacyPlan.sessionId,
      planId: legacyPlan.id,
      sourceSnapshot: snapshot,
    });
    expect(api.startOriginalPlanBuild).toHaveBeenCalledWith({
      sessionId: legacyPlan.sessionId,
      planId: legacyPlan.id,
      sourceSnapshot: expect.objectContaining({ spec: expect.objectContaining({ evidence: [] }) }),
      requestId: "legacy-original-request",
    });
  });

  it("preserves existing evidence in snapshots and invalidates when it changes", () => {
    const evidencePlan = promotedPlan({
      spec: {
        ...promotedPlan().spec!,
        evidence: [
          {
            id: "evidence-existing",
            criterionId: "criterion-1",
            kind: "test",
            label: "Tests passed",
            status: "passed",
          },
        ],
      },
    });
    const snapshot = hyperPlanSourceProjection(evidencePlan);
    const review = {
      planId: evidencePlan.id,
      planHash: evidencePlan.hash,
      sourceSnapshot: snapshot,
      status: "review-error" as const,
    };

    expect(snapshot.spec?.evidence).toEqual(evidencePlan.spec?.evidence);
    expect(reconcileHyperPlanReview(review, promotedPlan())).toEqual({
      review: undefined,
      invalidate: true,
    });
  });

  it("keeps a promoted revision choice retryable when its start rejects", async () => {
    const api = createApi();
    let rejectStart: ((error: Error) => void) | undefined;
    api.startPlanBuild.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectStart = reject;
        }),
    );
    const operations = createHyperPlanOperations(
      api,
      vi.fn().mockReturnValueOnce("choice-id").mockReturnValueOnce("start-id"),
    );
    const review = {
      planId: "plan-1",
      planHash: "old-hash",
      sourceSnapshot: sourceSnapshot(
        promotedPlan({
          hash: "old-hash",
          title: "Original plan",
          overview: "Original overview",
          content: "# Original",
        }),
      ),
      status: "choosing" as const,
      preview,
      choice: "revision" as const,
    };

    const firstChoice = operations.choose(preview, "revision");
    await vi.waitFor(() => expect(rejectStart).toBeDefined());
    const promoted = promotedPlan();
    const reconciliation = reconcileHyperPlanReview(review, promoted);

    expect(reconciliation.invalidate).toBe(false);
    expect(reconciliation.review?.planHash).toBe("promoted-hash");
    if (reconciliation.invalidate) operations.reset();
    rejectStart?.(new Error("start failed"));
    await expect(firstChoice).rejects.toMatchObject({ stage: "start" });
    api.startPlanBuild.mockResolvedValue({ runId: "run-retried" });

    await expect(operations.choose(preview, "revision")).resolves.toBeUndefined();
    expect(api.resolveHyperPlanDraft).toHaveBeenCalledOnce();
    expect(api.startPlanBuild.mock.calls.map(([input]) => input.requestId)).toEqual([
      "start-id",
      "start-id",
    ]);

    expect(
      reconcileHyperPlanReview(review, {
        ...promoted,
        content: "A different external plan update",
      }),
    ).toEqual({ review: undefined, invalidate: true });
  });

  it.each([
    ["title", { title: "External title" }],
    ["todos", { todos: [{ id: "todo-1", content: "External task", status: "pending" as const }] }],
    ["Spec", { spec: { ...promotedPlan().spec!, assumptions: ["External assumption"] } }],
  ])("invalidates a same-content revision when promoted %s diverges", (_field, override) => {
    const review = {
      planId: "plan-1",
      planHash: "old-hash",
      sourceSnapshot: sourceSnapshot(
        promotedPlan({
          hash: "old-hash",
          title: "Original plan",
          overview: "Original overview",
          content: "# Original",
        }),
      ),
      status: "choosing" as const,
      preview,
      choice: "revision" as const,
    };

    expect(reconcileHyperPlanReview(review, promotedPlan(override))).toEqual({
      review: undefined,
      invalidate: true,
    });
  });

  it.each([
    ["title", { title: "External title" }],
    ["todos", { todos: [{ id: "todo-1", content: "External task", status: "pending" as const }] }],
    ["spec", { spec: { ...promotedPlan().spec!, assumptions: ["External assumption"] } }],
    [
      "acceptance criterion status",
      {
        spec: {
          ...promotedPlan().spec!,
          acceptanceCriteria: [
            { ...promotedPlan().spec!.acceptanceCriteria[0]!, status: "passed" as const },
          ],
        },
      },
    ],
    [
      "evidence",
      {
        spec: {
          ...promotedPlan().spec!,
          evidence: [
            {
              id: "evidence-1",
              criterionId: "criterion-1",
              kind: "test" as const,
              label: "Tests passed",
              status: "passed" as const,
            },
          ],
        },
      },
    ],
    ["whitespace-only content", { content: " # Original\n" }],
  ])("invalidates %s changes that keep the markdown hash in retryable states", (_field, override) => {
    const plan = promotedPlan({
      hash: "same-hash",
      title: "Original plan",
      overview: "Original overview",
      content: "# Original",
    });
    const source = sourceSnapshot(plan);
    for (const status of ["ready", "review-error", "choice-error"] as const) {
      const review = {
        planId: plan.id,
        planHash: plan.hash,
        sourceSnapshot: source,
        status,
        ...(status === "ready" || status === "choice-error"
          ? { preview, choice: "original" as const }
          : {}),
        ...(status === "review-error" ? { originalStart: "error" as const } : {}),
      } as unknown as Parameters<typeof reconcileHyperPlanReview>[0];
      expect(reconcileHyperPlanReview(review, { ...plan, ...override })).toEqual({
        review: undefined,
        invalidate: true,
      });
    }
  });

  it("keeps an unchanged source valid and advances the snapshot for an exact revision promotion", () => {
    const original = promotedPlan({
      hash: "same-hash",
      title: "Original plan",
      overview: "Original overview",
      content: "# Original",
    });
    const review = {
      planId: original.id,
      planHash: original.hash,
      sourceSnapshot: sourceSnapshot(original),
      status: "ready" as const,
      preview,
    };
    expect(reconcileHyperPlanReview(review, original)).toEqual({ review, invalidate: false });

    const choosing = { ...review, status: "start-error" as const, choice: "revision" as const };
    const promoted = promotedPlan();
    const reconciliation = reconcileHyperPlanReview(choosing, promoted);
    expect(reconciliation.invalidate).toBe(false);
    expect(reconciliation.review).toMatchObject({
      planHash: promoted.hash,
      sourceSnapshot: sourceSnapshot(promoted),
    });
  });

  it("accepts a promotion event after start failure and keeps retry operation IDs", async () => {
    const api = createApi();
    api.startPlanBuild.mockRejectedValueOnce(new Error("start failed"));
    const operations = createHyperPlanOperations(
      api,
      vi.fn().mockReturnValueOnce("choice-id").mockReturnValueOnce("start-id"),
    );
    const original = promotedPlan({
      hash: "old-hash",
      title: "Original plan",
      overview: "Original overview",
      content: "# Original",
    });
    const review = {
      planId: original.id,
      planHash: original.hash,
      sourceSnapshot: sourceSnapshot(original),
      status: "choosing" as const,
      preview,
      choice: "revision" as const,
    };
    await expect(operations.choose(preview, "revision")).rejects.toMatchObject({ stage: "start" });
    const failedReview = { ...review, status: "start-error" as const };
    const reconciliation = reconcileHyperPlanReview(failedReview, promotedPlan());
    expect(reconciliation.invalidate).toBe(false);
    expect(reconciliation.review).toMatchObject({
      planHash: "promoted-hash",
      status: "start-error",
    });

    api.startPlanBuild.mockResolvedValue({ runId: "run-retried" });
    await operations.choose(preview, "revision");
    expect(api.resolveHyperPlanDraft).toHaveBeenCalledOnce();
    expect(api.startPlanBuild.mock.calls.map(([input]) => input.requestId)).toEqual([
      "start-id",
      "start-id",
    ]);
  });

  it("invalidates a promotion whose plan lacks legacy Spec evidence instead of throwing", () => {
    const promoted = promotedPlan();
    if (!promoted.spec) throw new Error("Expected a Spec plan.");
    const { evidence: _evidence, ...legacySpec } = promoted.spec;
    const legacy = { ...promoted, spec: legacySpec } as unknown as PlanRef;
    const review = {
      planId: "plan-1",
      planHash: "old-hash",
      sourceSnapshot: sourceSnapshot(
        promotedPlan({
          hash: "old-hash",
          title: "Original plan",
          overview: "Original overview",
          content: "# Original",
        }),
      ),
      status: "choosing" as const,
      preview,
      choice: "revision" as const,
    };

    expect(() => reconcileHyperPlanReview(review, legacy)).not.toThrow();
    expect(reconcileHyperPlanReview(review, legacy)).toEqual({
      review: undefined,
      invalidate: true,
    });
  });

  it.each([
    ["completed todo", { todos: [{ ...promotedPlan().todos[0]!, status: "completed" as const }] }],
    [
      "passed criterion",
      {
        spec: {
          ...promotedPlan().spec!,
          acceptanceCriteria: [
            { ...promotedPlan().spec!.acceptanceCriteria[0]!, status: "passed" as const },
          ],
        },
      },
    ],
    [
      "nonempty evidence",
      {
        spec: {
          ...promotedPlan().spec!,
          evidence: [
            {
              id: "evidence-1",
              criterionId: "criterion-1",
              kind: "test",
              label: "Tests passed",
              status: "passed" as const,
            },
          ],
        },
      },
    ],
    ["stored content whitespace", { content: ` ${preview.revision.content.trim()} ` }],
  ])("rejects promotion with %s", (_case, override) => {
    const review = {
      planId: "plan-1",
      planHash: "old-hash",
      sourceSnapshot: sourceSnapshot(
        promotedPlan({
          hash: "old-hash",
          title: "Original plan",
          overview: "Original overview",
          content: "# Original",
        }),
      ),
      status: "choosing" as const,
      preview,
      choice: "revision" as const,
    };
    const promoted = promotedPlan(override);

    const reconciliation = reconcileHyperPlanReview(review, promoted);

    expect(reconciliation).toEqual({ review: undefined, invalidate: true });
  });

  it("creates a draft preview without asking the legacy summary reviewer", async () => {
    const api = createApi();
    const operations = createHyperPlanOperations(api, () => "request-1");

    await expect(operations.review({ sessionId: "session-1", planId: "plan-1" })).resolves.toBe(
      preview,
    );
    expect(api.createHyperPlanDraft).toHaveBeenCalledWith({
      sessionId: "session-1",
      planId: "plan-1",
    });
    expect(api.resolveHyperPlanDraft).not.toHaveBeenCalled();
  });

  it("forwards the Spec/composer model into createHyperPlanDraft", async () => {
    const api = createApi();
    const operations = createHyperPlanOperations(api, () => "request-1");

    await operations.review({
      sessionId: "session-1",
      planId: "plan-1",
      model: "composer-model",
    });

    expect(api.createHyperPlanDraft).toHaveBeenCalledWith({
      sessionId: "session-1",
      planId: "plan-1",
      model: "composer-model",
    });
  });

  it("keeps only short path-free HyperPlan failure reasons for the UI", () => {
    expect(safeHyperPlanReviewReason(new Error("No model available for HyperPlan review."))).toBe(
      "No model available for HyperPlan review.",
    );
    expect(
      safeHyperPlanReviewReason(new Error("Session setup failed: /home/user/.modus/secret")),
    ).toBe("HyperPlan review is unavailable. Try again or build the original plan.");
    expect(safeHyperPlanReviewReason(new Error("private detail with token=abc"))).toBe(
      "HyperPlan review is unavailable. Try again or build the original plan.",
    );
  });

  it.each([
    { choice: "revision" as const },
    { choice: "original" as const },
  ])("resolves $choice and exclusively starts its selection once", async ({ choice }) => {
    const api = createApi();
    const operations = createHyperPlanOperations(
      api,
      vi.fn().mockReturnValueOnce("choice-id").mockReturnValueOnce("start-id"),
    );

    await operations.choose(preview, choice);

    expect(api.resolveHyperPlanDraft).toHaveBeenCalledExactlyOnceWith({
      draftId: "draft-1",
      choice,
      requestId: "choice-id",
    });
    expect(api.startPlanBuild).toHaveBeenCalledExactlyOnceWith({
      selectionId: "selection-1",
      requestId: "start-id",
    });
    expect(api.startPlanBuild.mock.calls[0]?.[0]).not.toHaveProperty("plan");
  });

  it("retries an uncertain resolution with the same choice operation ID", async () => {
    const api = createApi();
    api.resolveHyperPlanDraft
      .mockRejectedValueOnce(new Error("private detail"))
      .mockResolvedValueOnce({ selectionId: "selection-1", plan: {}, planFingerprint: "secret" });
    const operations = createHyperPlanOperations(api, () => "stable-id");

    await expect(operations.choose(preview, "revision")).rejects.toMatchObject({ stage: "choice" });
    await operations.choose(preview, "revision");

    expect(api.resolveHyperPlanDraft).toHaveBeenCalledTimes(2);
    expect(api.resolveHyperPlanDraft.mock.calls.map(([input]) => input.requestId)).toEqual([
      "stable-id",
      "stable-id",
    ]);
    expect(api.startPlanBuild).toHaveBeenCalledExactlyOnceWith({
      selectionId: "selection-1",
      requestId: "stable-id",
    });
  });

  it("retries a failed start with the same selection and start request ID", async () => {
    const api = createApi();
    api.startPlanBuild.mockRejectedValueOnce(new Error("private detail"));
    const operations = createHyperPlanOperations(
      api,
      vi.fn().mockReturnValueOnce("choice-id").mockReturnValueOnce("start-id"),
    );

    await expect(operations.choose(preview, "revision")).rejects.toMatchObject({ stage: "start" });
    await operations.choose(preview, "revision");

    expect(api.resolveHyperPlanDraft).toHaveBeenCalledOnce();
    expect(api.startPlanBuild).toHaveBeenNthCalledWith(1, {
      selectionId: "selection-1",
      requestId: "start-id",
    });
    expect(api.startPlanBuild).toHaveBeenNthCalledWith(2, {
      selectionId: "selection-1",
      requestId: "start-id",
    });
  });

  it("allows explicit original build only after review failure and retries that same start", async () => {
    const api = createApi();
    api.startOriginalPlanBuild.mockRejectedValueOnce(new Error("private detail"));
    const operations = createHyperPlanOperations(api, () => "original-request");
    const snapshot = sourceSnapshot(promotedPlan());
    api.createHyperPlanDraft.mockRejectedValueOnce(new Error("private detail"));

    await expect(
      operations.review({ sessionId: "session-1", planId: "plan-1" }),
    ).rejects.toBeDefined();
    await expect(
      operations.buildOriginal({
        sessionId: "session-1",
        planId: "plan-1",
        sourceSnapshot: snapshot,
      }),
    ).rejects.toMatchObject({ stage: "start" });
    await operations.buildOriginal({
      sessionId: "session-1",
      planId: "plan-1",
      sourceSnapshot: { ...snapshot, title: "Changed during retry" },
    });

    expect(api.startOriginalPlanBuild).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      planId: "plan-1",
      sourceSnapshot: snapshot,
      requestId: "original-request",
    });
    expect(api.startOriginalPlanBuild).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      planId: "plan-1",
      sourceSnapshot: snapshot,
      requestId: "original-request",
    });
    expect(api.resolveHyperPlanDraft).not.toHaveBeenCalled();
  });

  it("rejects duplicate pending choices and clears operation identity on reset", async () => {
    const api = createApi();
    let finish: (() => void) | undefined;
    api.resolveHyperPlanDraft.mockImplementation(
      () =>
        new Promise(
          (resolve) =>
            (finish = () =>
              resolve({ selectionId: "selection-1", plan: {}, planFingerprint: "x" })),
        ),
    );
    const operations = createHyperPlanOperations(api, vi.fn().mockReturnValue("new-id"));

    const first = operations.choose(preview, "revision");
    await expect(operations.choose(preview, "revision")).rejects.toMatchObject({
      stage: "pending",
    });
    finish?.();
    await first;
    operations.reset();
    api.resolveHyperPlanDraft.mockResolvedValue({
      selectionId: "selection-2",
      plan: {},
      planFingerprint: "y",
    });
    await operations.choose({ ...preview, draftId: "draft-2" }, "revision");

    expect(api.resolveHyperPlanDraft).toHaveBeenLastCalledWith({
      draftId: "draft-2",
      choice: "revision",
      requestId: "new-id",
    });
  });
});
