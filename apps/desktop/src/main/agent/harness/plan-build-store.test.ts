import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPlanBuildStateForSession,
  getPlanBuildOwnerEpochIdentity,
  getPlanBuildStartOperation,
  invalidatePlanBuildOwner,
  isPlanBuildSessionReserved,
  ownsPlanBuildStartReservation,
  registerPlanBuildOwner,
  runPlanBuildStartOperation,
  transferPlanBuildReservationToRun,
} from "./plan-build-store";

const sourcePlan = { sessionId: "source-session", id: "source-plan" };
describe("main-owned plan build starts", () => {
  beforeEach(() => clearPlanBuildStateForSession(sourcePlan.sessionId));
  it("shares an identical in-flight start request and rejects conflicting parameters", async () => {
    let resolveStart!: (result: {
      sessionId: string;
      planId: string;
      planFingerprint: string;
      runId: string;
    }) => void;
    const result = {
      sessionId: sourcePlan.sessionId,
      planId: sourcePlan.id,
      planFingerprint: "fp",
      runId: "run-shared",
    };
    const start = vi.fn(
      () =>
        new Promise<typeof result>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const input = {
      ownerId: 20,
      requestId: "same-request",
      kind: "original" as const,
      sessionId: sourcePlan.sessionId,
      planId: sourcePlan.id,
      planFingerprint: "fp",
      start,
    };
    const first = runPlanBuildStartOperation(input);
    const replay = runPlanBuildStartOperation(input);
    expect(start).toHaveBeenCalledTimes(1);
    expect(() => runPlanBuildStartOperation({ ...input, planId: "different-plan" })).toThrow(
      /conflict/i,
    );
    expect(() => runPlanBuildStartOperation({ ...input, requestId: "competing-request" })).toThrow(
      /reserved/i,
    );
    resolveStart(result);
    await expect(replay).resolves.toEqual(result);
    await expect(first).resolves.toEqual(result);
    await expect(runPlanBuildStartOperation(input)).resolves.toEqual(result);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("isolates start idempotency by owner epoch while deduplicating within an epoch", async () => {
    const epochA = registerPlanBuildOwner(46);
    const input = {
      ownerId: 46,
      ownerEpoch: epochA,
      requestId: "reused-request",
      kind: "original" as const,
      sessionId: "epoch-a-session",
      planId: sourcePlan.id,
      planFingerprint: "epoch-a",
      start: vi.fn(async () => ({
        sessionId: "epoch-a-session",
        planId: sourcePlan.id,
        planFingerprint: "epoch-a",
        runId: "run-a",
      })),
    };
    await expect(runPlanBuildStartOperation(input)).resolves.toMatchObject({ runId: "run-a" });
    await expect(runPlanBuildStartOperation(input)).resolves.toMatchObject({ runId: "run-a" });
    expect(input.start).toHaveBeenCalledTimes(1);

    const epochB = registerPlanBuildOwner(46);
    const startB = vi.fn(async () => ({
      sessionId: "epoch-b-session",
      planId: sourcePlan.id,
      planFingerprint: "epoch-b",
      runId: "run-b",
    }));
    await expect(
      runPlanBuildStartOperation({
        ...input,
        ownerEpoch: epochB,
        sessionId: "epoch-b-session",
        planFingerprint: "epoch-b",
        start: startB,
      }),
    ).resolves.toMatchObject({ runId: "run-b" });
    expect(startB).toHaveBeenCalledTimes(1);
    expect(invalidatePlanBuildOwner(46, epochA)).toBe(false);
    expect(
      getPlanBuildStartOperation({ ownerId: 46, ownerEpoch: epochA, requestId: input.requestId }),
    ).toBeUndefined();
    expect(
      getPlanBuildStartOperation({ ownerId: 46, ownerEpoch: epochB, requestId: input.requestId }),
    ).toMatchObject({ runId: "run-b" });
    expect(isPlanBuildSessionReserved("epoch-b-session")).toBe(true);
    expect(invalidatePlanBuildOwner(46, epochB)).toBe(true);
    expect(isPlanBuildSessionReserved("epoch-b-session")).toBe(false);
  });
  it("releases a pre-run failure and allows an identical request to retry", async () => {
    const input = {
      ownerId: 21,
      requestId: "retry-before-run",
      kind: "original" as const,
      sessionId: sourcePlan.sessionId,
      planId: sourcePlan.id,
      planFingerprint: "fp-retry",
    };
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error("preparation failed"))
      .mockResolvedValueOnce({
        sessionId: sourcePlan.sessionId,
        planId: sourcePlan.id,
        planFingerprint: "fp-retry",
        runId: "run-retried",
      });
    await expect(runPlanBuildStartOperation({ ...input, start })).rejects.toThrow(/preparation/i);
    expect(isPlanBuildSessionReserved(sourcePlan.sessionId)).toBe(false);
    await expect(runPlanBuildStartOperation({ ...input, start })).resolves.toMatchObject({
      runId: "run-retried",
    });
    expect(start).toHaveBeenCalledTimes(2);
  });
  it("does not let a stale start reservation claim or transfer a replacement epoch reservation", async () => {
    const epochA = registerPlanBuildOwner(47);
    let markA!: (runId: string) => void;
    let finishA!: (result: {
      sessionId: string;
      planId: string;
      planFingerprint: string;
      runId: string;
    }) => void;
    const startA = runPlanBuildStartOperation({
      ownerId: 47,
      ownerEpoch: epochA,
      requestId: "aba-request",
      kind: "original",
      sessionId: "aba-session",
      planId: "plan-a",
      planFingerprint: "fp-a",
      start: (_operation, markRunCreated) => {
        markA = markRunCreated;
        return new Promise((resolve) => {
          finishA = resolve;
        });
      },
    });
    expect(invalidatePlanBuildOwner(47, epochA)).toBe(true);

    const epochB = registerPlanBuildOwner(47);
    let markB!: (runId: string) => void;
    let finishB!: (result: {
      sessionId: string;
      planId: string;
      planFingerprint: string;
      runId: string;
    }) => void;
    const startB = runPlanBuildStartOperation({
      ownerId: 47,
      ownerEpoch: epochB,
      requestId: "aba-request",
      kind: "original",
      sessionId: "aba-session",
      planId: "plan-b",
      planFingerprint: "fp-b",
      start: (_operation, markRunCreated) => {
        markB = markRunCreated;
        return new Promise((resolve) => {
          finishB = resolve;
        });
      },
    });
    expect(
      ownsPlanBuildStartReservation({
        ownerId: 47,
        ownerEpoch: epochA,
        requestId: "aba-request",
        sessionId: "aba-session",
      }),
    ).toBe(false);
    expect(() => markA("run-a")).toThrow(/reservation/i);
    expect(isPlanBuildSessionReserved("aba-session")).toBe(true);
    expect(
      ownsPlanBuildStartReservation({
        ownerId: 47,
        ownerEpoch: epochB,
        requestId: "aba-request",
        sessionId: "aba-session",
      }),
    ).toBe(true);
    markB("run-b");
    expect(
      transferPlanBuildReservationToRun({
        ownerId: 47,
        ownerEpoch: epochA,
        requestId: "aba-request",
        sessionId: "aba-session",
        runId: "run-a",
      }),
    ).toBe(false);
    expect(
      ownsPlanBuildStartReservation({
        ownerId: 47,
        ownerEpoch: epochB,
        requestId: "aba-request",
        sessionId: "aba-session",
        runId: "run-b",
      }),
    ).toBe(true);
    finishA({
      sessionId: "aba-session",
      planId: "plan-a",
      planFingerprint: "fp-a",
      runId: "run-a",
    });
    finishB({
      sessionId: "aba-session",
      planId: "plan-b",
      planFingerprint: "fp-b",
      runId: "run-b",
    });
    await expect(startA).resolves.toMatchObject({ runId: "run-a" });
    await expect(startB).resolves.toMatchObject({ runId: "run-b" });
  });
  it("derives stable UUID idempotency identities for owner epochs", () => {
    const epochA = registerPlanBuildOwner(49);
    const identityA = getPlanBuildOwnerEpochIdentity(epochA);
    const epochB = registerPlanBuildOwner(49);
    const identityB = getPlanBuildOwnerEpochIdentity(epochB);
    expect(identityA).toMatch(/^[0-9a-f-]{36}$/i);
    expect(identityB).toMatch(/^[0-9a-f-]{36}$/i);
    expect(identityA).toBe(getPlanBuildOwnerEpochIdentity(epochA));
    expect(identityB).toBe(getPlanBuildOwnerEpochIdentity(epochB));
    expect(identityA).not.toBe(identityB);
  });
});
