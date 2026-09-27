import { describe, expect, it, vi } from "vitest";
import { requestHyperPlanReview } from "./ChatPane";

const summary = {
  critiques: [],
  agreements: ["Keep the changes scoped."],
  disagreements: [],
  risks: [],
  openQuestions: [],
  references: [],
};

describe("requestHyperPlanReview", () => {
  it("calls the review with the selected session and plan and returns its summary", async () => {
    const review = vi.fn().mockResolvedValue(summary);

    await expect(
      requestHyperPlanReview({ sessionId: "session-1", planId: "plan-1" }, review),
    ).resolves.toEqual({ status: "completed", summary });
    expect(review).toHaveBeenCalledWith({ sessionId: "session-1", planId: "plan-1" });
  });

  it("converts failures to a generic error state without exposing raw errors", async () => {
    const review = vi.fn().mockRejectedValue(new Error("secret raw error"));

    await expect(
      requestHyperPlanReview({ sessionId: "session-1", planId: "plan-1" }, review),
    ).resolves.toEqual({ status: "error" });
  });
});
