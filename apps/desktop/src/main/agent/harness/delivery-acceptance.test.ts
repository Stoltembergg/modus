import { describe, expect, it } from "vitest";
import type {
  HarnessQAResult,
  HarnessTaskCriterionState,
  TodoItem,
} from "../../../shared/contracts";
import { assessDeliveryAcceptance } from "./delivery-acceptance";

const notRequired: HarnessQAResult = {
  required: false,
  status: "not_required",
  reasonCode: "qa_not_required",
  evidence: [],
};

function assess(
  input: {
    qa?: HarnessQAResult;
    todos?: Pick<TodoItem, "status">[];
    criteria?: Pick<HarnessTaskCriterionState, "status">[];
    verificationRequired?: boolean;
  } = {},
) {
  return assessDeliveryAcceptance({
    qa: input.qa ?? notRequired,
    todos: input.todos ?? [],
    criteria: input.criteria ?? [],
    ...(input.verificationRequired !== undefined
      ? { verificationRequired: input.verificationRequired }
      : {}),
  });
}

describe("assessDeliveryAcceptance", () => {
  it.each([
    "not_required",
    "passed",
    "user_confirmed",
  ] as const)("requires actual passing evidence for a verification gate despite %s aggregate QA", (status) => {
    const result = assess({
      verificationRequired: true,
      qa: { ...notRequired, status },
      todos: [{ status: "completed" }],
    });
    expect(result.status).toBe("unverified");
    expect(result.reasonCodes).toContain("verification_gate_unverified");
  });

  it("accepts the explicit verification gate with actual passing check evidence", () => {
    expect(
      assess({
        verificationRequired: true,
        qa: {
          ...notRequired,
          status: "passed",
          evidence: [{ kind: "check", status: "passed", label: "Tests", eventId: "check-end" }],
        },
        todos: [{ status: "completed" }],
      }).status,
    ).toBe("accepted");
  });

  it("retains verification failure priority when the gate has no passing evidence", () => {
    expect(
      assess({
        verificationRequired: true,
        qa: { ...notRequired, status: "failed" },
        todos: [{ status: "completed" }],
      }),
    ).toEqual({
      status: "verification_failed",
      reasonCodes: ["qa_failed", "verification_gate_unverified"],
    });
  });

  it("accepts fulfilled tracked work with no QA obligation", () => {
    expect(
      assess({ todos: [{ status: "completed" }], criteria: [{ status: "verified" }] }),
    ).toEqual({ status: "accepted", reasonCodes: ["tracked_requirements_satisfied"] });
  });

  it("does not infer delivery from the absence of tracked requirements", () => {
    expect(assess()).toEqual({ status: "unverified", reasonCodes: ["no_tracked_requirements"] });
    expect(assess({ qa: { ...notRequired, status: "passed" } }).status).toBe("unverified");
  });

  it.each([
    "pending",
    "in_progress",
    "cancelled",
  ] as const)("keeps %s todo work incomplete despite passing checks", (status) => {
    expect(assess({ qa: { ...notRequired, status: "passed" }, todos: [{ status }] })).toEqual({
      status: "incomplete",
      reasonCodes: ["todo_incomplete"],
    });
  });

  it("keeps unresolved task criteria incomplete", () => {
    expect(assess({ criteria: [{ status: "pending" }] })).toEqual({
      status: "incomplete",
      reasonCodes: ["criterion_incomplete"],
    });
  });

  it.each(["todo", "criterion"] as const)("preserves blocked %s work", (source) => {
    expect(
      assess(
        source === "todo"
          ? { todos: [{ status: "blocked" }] }
          : { criteria: [{ status: "blocked" }] },
      ),
    ).toEqual({ status: "blocked", reasonCodes: [`${source}_blocked`] });
  });

  it("fails delivery when a task criterion failed", () => {
    expect(assess({ criteria: [{ status: "failed" }] })).toEqual({
      status: "verification_failed",
      reasonCodes: ["criterion_failed"],
    });
  });

  it.each([
    "failed",
    "timed_out",
  ] as const)("preserves an observed %s check even without QA requirements", (status) => {
    expect(
      assess({
        qa: { ...notRequired, status },
        todos: [{ status: "completed" }],
      }),
    ).toEqual({ status: "verification_failed", reasonCodes: ["qa_failed"] });
  });

  it("preserves failed optional evidence even when required QA passed", () => {
    expect(
      assess({
        qa: {
          ...notRequired,
          required: true,
          status: "passed",
          evidence: [{ kind: "check", label: "Lint", status: "failed" }],
        },
        todos: [{ status: "completed" }],
      }),
    ).toEqual({ status: "verification_failed", reasonCodes: ["qa_failed"] });
  });

  it.each([
    "missing",
    "unavailable",
    "cancelled",
    "skipped",
    "user_confirmed",
  ] as const)("keeps %s QA unverified after tracked work completes", (status) => {
    expect(
      assess({
        qa: { ...notRequired, status },
        todos: [{ status: "completed" }],
      }),
    ).toEqual({ status: "unverified", reasonCodes: ["qa_unverified"] });
  });

  it("keeps unknown task criteria unverified", () => {
    expect(assess({ criteria: [{ status: "unknown" }] })).toEqual({
      status: "unverified",
      reasonCodes: ["criterion_unverified"],
    });
  });

  it("allows explicit user confirmation of tracked criteria", () => {
    expect(assess({ criteria: [{ status: "user_confirmed" }] }).status).toBe("accepted");
  });

  it("reports all reasons and prioritizes failed verification over blocked or incomplete work", () => {
    expect(
      assess({
        qa: { ...notRequired, status: "failed" },
        todos: [{ status: "blocked" }, { status: "pending" }],
        criteria: [{ status: "unknown" }],
      }),
    ).toEqual({
      status: "verification_failed",
      reasonCodes: ["qa_failed", "todo_blocked", "todo_incomplete", "criterion_unverified"],
    });
  });
});
