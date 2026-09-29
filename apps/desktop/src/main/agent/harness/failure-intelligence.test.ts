import { describe, expect, it } from "vitest";
import {
  appendFailureAttempt,
  createFailureAttempt,
  createFailureLedger,
  failureAttemptSignature,
  isDuplicateFailedAttempt,
  listAvoidedStrategyCodes,
  reduceFailureAttemptsFromEvents,
} from "./failure-intelligence";

describe("failure-intelligence", () => {
  it("records bounded attempts without raw error text fields", () => {
    const attempt = createFailureAttempt({
      sessionId: "session-1",
      runId: "run-1",
      strategyCode: "same_edit_retry",
      hypothesisCode: "stale_import",
      status: "failed",
      reasonCode: "qa_failed",
      revision: "abc123",
      evidenceEventIds: ["evt-1", "evt-1", "bad id"],
    });
    expect(attempt.strategyCode).toBe("same_edit_retry");
    expect(attempt.evidenceEventIds).toEqual(["evt-1"]);
    expect(attempt).not.toHaveProperty("message");
    expect(attempt).not.toHaveProperty("command");
  });

  it("detects duplicate failed strategies at the same revision", () => {
    const first = createFailureAttempt({
      sessionId: "s",
      runId: "r",
      strategyCode: "blind_retry",
      status: "failed",
      reasonCode: "tests_failed",
      revision: "rev-a",
    });
    const ledger = appendFailureAttempt(createFailureLedger(), first);
    expect(
      isDuplicateFailedAttempt(ledger.attempts, {
        strategyCode: "blind_retry",
        revision: "rev-a",
      }),
    ).toBe(true);
    expect(
      isDuplicateFailedAttempt(ledger.attempts, {
        strategyCode: "blind_retry",
        revision: "rev-b",
      }),
    ).toBe(false);
    expect(listAvoidedStrategyCodes(ledger.attempts, "rev-a")).toEqual(["blind_retry"]);
    expect(listAvoidedStrategyCodes(ledger.attempts, "rev-b")).toEqual([]);
  });

  it("shares signatures only for equivalent strategy fingerprints", () => {
    const a = failureAttemptSignature({
      strategyCode: "patch_and_hope",
      hypothesisCode: "null_guard",
      revision: "1",
    });
    const b = failureAttemptSignature({
      strategyCode: "patch_and_hope",
      hypothesisCode: "null_guard",
      revision: "1",
    });
    const c = failureAttemptSignature({
      strategyCode: "patch_and_hope",
      hypothesisCode: "other",
      revision: "1",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("rehydrates only matching harness.failure events", () => {
    const attempt = createFailureAttempt({
      sessionId: "s1",
      runId: "r1",
      strategyCode: "retry",
      status: "failed",
      reasonCode: "lint_failed",
    });
    const attempts = reduceFailureAttemptsFromEvents(
      [
        { type: "harness.failure", sessionId: "s1", runId: "r1", attempt },
        {
          type: "harness.failure",
          sessionId: "s1",
          runId: "other",
          attempt: { ...attempt, runId: "other", id: "x" },
        },
        { type: "run.completed", sessionId: "s1", runId: "r1" },
      ],
      "s1",
      "r1",
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.strategyCode).toBe("retry");
  });

  it("rejects unsafe owner ids", () => {
    expect(() =>
      createFailureAttempt({
        sessionId: "../escape",
        runId: "r",
        strategyCode: "x",
        status: "failed",
        reasonCode: "y",
      }),
    ).toThrow(/Unsafe/);
  });
});
