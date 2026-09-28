import { describe, expect, it, vi } from "vitest";
import { requestHyperPlanReview } from "./ChatPane";

const summary = {
  critiques: [],
  revisedContent: "# Revised",
  agreements: ["Keep the changes scoped."],
  disagreements: [],
  risks: [],
  openQuestions: [],
  references: [],
};

describe("requestHyperPlanReview", () => {
  it("calls the review once and returns its revised summary", async () => {
    const review = vi.fn().mockResolvedValue(summary);
    const activeRequest = { current: new Set<string>() };

    await expect(
      requestHyperPlanReview(
        { sessionId: "session-1", planId: "plan-1", planHash: "hash-1" },
        activeRequest,
        review,
      ),
    ).resolves.toEqual(summary);
    expect(review).toHaveBeenCalledWith({ sessionId: "session-1", planId: "plan-1" });
    expect(activeRequest.current.size).toBe(0);
  });

  it("blocks duplicate requests for one plan while review is pending", async () => {
    let finishReview!: (value: typeof summary) => void;
    const review = vi.fn(
      () =>
        new Promise<typeof summary>((resolve) => {
          finishReview = resolve;
        }),
    );
    const activeRequest = { current: new Set<string>() };
    const input = { sessionId: "session-1", planId: "plan-1", planHash: "hash-1" };

    const first = requestHyperPlanReview(input, activeRequest, review);
    await expect(requestHyperPlanReview(input, activeRequest, review)).resolves.toBeUndefined();
    expect(review).toHaveBeenCalledTimes(1);

    finishReview(summary);
    await expect(first).resolves.toEqual(summary);
    expect(activeRequest.current.size).toBe(0);
  });

  it("preserves a rejection cause and releases the request lock", async () => {
    const failure = new Error("429: temporary rate limit");
    const review = vi.fn().mockRejectedValue(failure);
    const activeRequest = { current: new Set<string>() };

    await expect(
      requestHyperPlanReview(
        { sessionId: "session-1", planId: "plan-1", planHash: "hash-1" },
        activeRequest,
        review,
      ),
    ).rejects.toBe(failure);
    expect(activeRequest.current.size).toBe(0);
  });
});
