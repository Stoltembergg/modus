import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HyperPlanRevision, PlanRef } from "../../../shared/contracts";
import { fingerprintPlanSource } from "../../plan/plan-store";
import {
  cancelHyperPlanSelection,
  claimHyperPlanSelection,
  clearHyperPlanDraftsForOwner,
  clearHyperPlanDraftsForSession,
  consumeHyperPlanSelection,
  getHyperPlanChoiceReplay,
  getHyperPlanDraftOwnerEpoch,
  getHyperPlanOwnerEpochIdentity,
  getHyperPlanSelection,
  getHyperPlanStartOperation,
  invalidateHyperPlanDraftOwner,
  isHyperPlanSessionReserved,
  ownsHyperPlanStartReservation,
  peekHyperPlanDraft,
  registerHyperPlanDraftOwner,
  releaseHyperPlanRunReservation,
  releaseHyperPlanSession,
  reserveHyperPlanSession,
  resolveHyperPlanDraftRequest,
  runHyperPlanStartOperation,
  storeHyperPlanDraft,
  takeHyperPlanDraft,
  transferHyperPlanReservationToRun,
} from "./hyperplan-draft-store";

const sourcePlan: PlanRef = {
  id: "plan-1",
  title: "Plan",
  overview: "Overview",
  path: "C:/plans/session-1/plan.md",
  hash: "hash",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  blocks: [{ type: "markdown", content: "# Plan" }],
  content: "# Plan",
  todos: [],
  buildStatus: "not_built",
  createdAt: "created",
  updatedAt: "updated",
  spec: {
    requirements: [],
    acceptanceCriteria: [],
    evidence: [],
    assumptions: [],
    openQuestions: [],
  },
};

const revision: HyperPlanRevision = {
  title: "Revised",
  overview: "Revised overview",
  content: "# Revised",
  todos: [],
  spec: {
    requirements: [],
    acceptanceCriteria: [],
    assumptions: [],
    openQuestions: [],
  },
};

describe("main-owned HyperPlan drafts and choices", () => {
  beforeEach(() => clearHyperPlanDraftsForSession(sourcePlan.sessionId));

  it("stores unpredictable one-use previews bound to owner, source and a 30-minute TTL", () => {
    const first = storeHyperPlanDraft({ ownerId: 4, sourcePlan, revision, now: 100 });
    const second = storeHyperPlanDraft({ ownerId: 4, sourcePlan, revision, now: 100 });
    expect(first.draftId).not.toBe(second.draftId);
    expect(first.draftId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.revision).toEqual(revision);
    expect(takeHyperPlanDraft({ ownerId: 5, draftId: first.draftId, now: 101 })).toBeUndefined();
    expect(takeHyperPlanDraft({ ownerId: 4, draftId: first.draftId, now: 100 })).toMatchObject({
      sessionId: sourcePlan.sessionId,
      workspaceId: sourcePlan.workspaceId,
      planId: sourcePlan.id,
      sourceFingerprint: fingerprintPlanSource(sourcePlan),
      revision,
    });
    expect(takeHyperPlanDraft({ ownerId: 4, draftId: first.draftId, now: 101 })).toBeUndefined();
    expect(
      takeHyperPlanDraft({ ownerId: 4, draftId: second.draftId, now: 1_800_100 }),
    ).toBeUndefined();
  });

  it("scopes draft cleanup and reservation release to the owner incarnation", () => {
    const oldEpoch = registerHyperPlanDraftOwner(44);
    expect(getHyperPlanDraftOwnerEpoch(44)).toBe(oldEpoch);
    expect(
      reserveHyperPlanSession({ sessionId: "old-session", ownerId: 44, ownerEpoch: oldEpoch }),
    ).toBe(true);
    const oldDraft = storeHyperPlanDraft({
      ownerId: 44,
      ownerEpoch: oldEpoch,
      sourcePlan,
      revision,
    });

    expect(invalidateHyperPlanDraftOwner(44, oldEpoch)).toBe(true);
    expect(isHyperPlanSessionReserved("old-session")).toBe(false);
    expect(takeHyperPlanDraft({ ownerId: 44, draftId: oldDraft.draftId })).toBeUndefined();

    const newEpoch = registerHyperPlanDraftOwner(44);
    expect(newEpoch).not.toBe(oldEpoch);
    expect(invalidateHyperPlanDraftOwner(44, oldEpoch)).toBe(false);
    expect(
      reserveHyperPlanSession({ sessionId: "old-session", ownerId: 44, ownerEpoch: newEpoch }),
    ).toBe(true);
    const newDraft = storeHyperPlanDraft({
      ownerId: 44,
      ownerEpoch: newEpoch,
      sourcePlan,
      revision,
    });
    expect(
      releaseHyperPlanSession({ sessionId: "old-session", ownerId: 44, ownerEpoch: oldEpoch }),
    ).toBe(false);
    expect(isHyperPlanSessionReserved("old-session")).toBe(true);

    expect(
      reserveHyperPlanSession({ sessionId: "new-session", ownerId: 44, ownerEpoch: newEpoch }),
    ).toBe(true);
    expect(takeHyperPlanDraft({ ownerId: 44, draftId: newDraft.draftId })).toBeDefined();
    expect(invalidateHyperPlanDraftOwner(44, newEpoch)).toBe(true);
    expect(isHyperPlanSessionReserved("new-session")).toBe(false);
    expect(getHyperPlanDraftOwnerEpoch(44)).toBeUndefined();
  });

  it("cleans a stale owner's resources without touching the replacement incarnation", () => {
    const oldEpoch = registerHyperPlanDraftOwner(45);
    const oldDraft = storeHyperPlanDraft({
      ownerId: 45,
      ownerEpoch: oldEpoch,
      sourcePlan,
      revision,
    });
    expect(
      reserveHyperPlanSession({
        sessionId: sourcePlan.sessionId,
        ownerId: 45,
        ownerEpoch: oldEpoch,
      }),
    ).toBe(true);

    const newEpoch = registerHyperPlanDraftOwner(45);
    const newDraft = storeHyperPlanDraft({
      ownerId: 45,
      ownerEpoch: newEpoch,
      sourcePlan,
      revision,
    });
    expect(invalidateHyperPlanDraftOwner(45, oldEpoch)).toBe(false);

    expect(takeHyperPlanDraft({ ownerId: 45, draftId: oldDraft.draftId })).toBeUndefined();
    expect(takeHyperPlanDraft({ ownerId: 45, draftId: newDraft.draftId })).toBeDefined();
    expect(getHyperPlanDraftOwnerEpoch(45)).toBe(newEpoch);
    expect(
      reserveHyperPlanSession({
        sessionId: sourcePlan.sessionId,
        ownerId: 45,
        ownerEpoch: newEpoch,
      }),
    ).toBe(true);
    expect(
      releaseHyperPlanSession({
        sessionId: sourcePlan.sessionId,
        ownerId: 45,
        ownerEpoch: oldEpoch,
      }),
    ).toBe(false);
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId)).toBe(true);
    expect(invalidateHyperPlanDraftOwner(45, newEpoch)).toBe(true);
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId)).toBe(false);
  });

  it("reconciles only identical choice requests and reserves one selection per session", () => {
    const preview = storeHyperPlanDraft({ ownerId: 4, sourcePlan, revision, now: 1_000 });
    const resolvePlan = vi.fn(() => sourcePlan);
    const input = {
      ownerId: 4,
      draftId: preview.draftId,
      choice: "original" as const,
      requestId: "request-1",
      sourcePlan,
      now: 1_001,
      resolvePlan,
    };
    const result = resolveHyperPlanDraftRequest(input);
    expect(resolveHyperPlanDraftRequest(input)).toEqual(result);
    expect(resolvePlan).toHaveBeenCalledTimes(1);
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId, 1_002)).toBe(true);
    expect(() =>
      resolveHyperPlanDraftRequest({
        ...input,
        choice: "revision",
        draftId: storeHyperPlanDraft({ ownerId: 4, sourcePlan, revision, now: 1_003 }).draftId,
        requestId: "request-2",
      }),
    ).toThrow(/reserved/i);
    expect(() => resolveHyperPlanDraftRequest({ ...input, choice: "revision" })).toThrow(
      /conflict/i,
    );
    expect(
      getHyperPlanSelection({ ownerId: 5, selectionId: result.selectionId, now: 1_004 }),
    ).toBeUndefined();
    expect(
      getHyperPlanSelection({ ownerId: 4, selectionId: result.selectionId, now: 1_004 }),
    ).toMatchObject({
      ownerId: 4,
      planId: sourcePlan.id,
      choice: "original",
    });
  });

  it("rejects a stale source and releases reservations on cancel, consume, expiry and teardown", () => {
    const staleDraft = storeHyperPlanDraft({ ownerId: 4, sourcePlan, revision, now: 2_000 });
    const changed = { ...sourcePlan, title: "Changed" };
    expect(() =>
      resolveHyperPlanDraftRequest({
        ownerId: 4,
        draftId: staleDraft.draftId,
        choice: "original",
        requestId: "stale",
        sourcePlan: changed,
        now: 2_001,
        resolvePlan: () => changed,
      }),
    ).toThrow(/stale|changed/i);
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId, 2_002)).toBe(false);

    const cancelDraft = storeHyperPlanDraft({ ownerId: 4, sourcePlan, revision, now: 3_000 });
    const cancelled = resolveHyperPlanDraftRequest({
      ownerId: 4,
      draftId: cancelDraft.draftId,
      choice: "original",
      requestId: "cancel",
      sourcePlan,
      now: 3_001,
      resolvePlan: () => sourcePlan,
    });
    expect(cancelHyperPlanSelection({ ownerId: 4, selectionId: cancelled.selectionId })).toBe(true);
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId, 3_002)).toBe(false);

    const consumeDraft = storeHyperPlanDraft({ ownerId: 4, sourcePlan, revision, now: 4_000 });
    const consumed = resolveHyperPlanDraftRequest({
      ownerId: 4,
      draftId: consumeDraft.draftId,
      choice: "original",
      requestId: "consume",
      sourcePlan,
      now: 4_001,
      resolvePlan: () => sourcePlan,
    });
    expect(
      consumeHyperPlanSelection({ ownerId: 4, selectionId: consumed.selectionId, now: 4_002 }),
    ).toBeDefined();
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId, 4_003)).toBe(false);

    expect(
      reserveHyperPlanSession({ sessionId: sourcePlan.sessionId, ownerId: 7, now: 5_000 }),
    ).toBe(true);
    expect(releaseHyperPlanSession({ sessionId: sourcePlan.sessionId, ownerId: 7 })).toBe(true);
    expect(
      reserveHyperPlanSession({ sessionId: sourcePlan.sessionId, ownerId: 7, now: 6_000 }),
    ).toBe(true);
    clearHyperPlanDraftsForOwner(7);
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId, 6_001)).toBe(false);

    const sessionDraft = storeHyperPlanDraft({ ownerId: 8, sourcePlan, revision, now: 7_000 });
    const sessionSelection = resolveHyperPlanDraftRequest({
      ownerId: 8,
      draftId: sessionDraft.draftId,
      choice: "original",
      requestId: "session-cleanup",
      sourcePlan,
      now: 7_001,
      resolvePlan: () => sourcePlan,
    });
    clearHyperPlanDraftsForSession(sourcePlan.sessionId);
    expect(
      getHyperPlanSelection({ ownerId: 8, selectionId: sessionSelection.selectionId, now: 7_002 }),
    ).toBeUndefined();
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId, 7_002)).toBe(false);
  });

  it("expires a main-owned selection reservation after five minutes", () => {
    const preview = storeHyperPlanDraft({ ownerId: 9, sourcePlan, revision, now: 10_000 });
    const selection = resolveHyperPlanDraftRequest({
      ownerId: 9,
      draftId: preview.draftId,
      choice: "original",
      requestId: "expires",
      sourcePlan,
      now: 10_001,
      resolvePlan: () => sourcePlan,
    });

    expect(isHyperPlanSessionReserved(sourcePlan.sessionId, 10_002)).toBe(true);
    expect(
      getHyperPlanSelection({
        ownerId: 9,
        selectionId: selection.selectionId,
        now: 310_001,
      }),
    ).toBeUndefined();
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId, 310_001)).toBe(false);
  });

  it("claims a selection without releasing its reservation and releases only its matching run", () => {
    const preview = storeHyperPlanDraft({ ownerId: 12, sourcePlan, revision });
    const selection = resolveHyperPlanDraftRequest({
      ownerId: 12,
      draftId: preview.draftId,
      choice: "original",
      requestId: "claim",
      sourcePlan,
      resolvePlan: () => sourcePlan,
    });

    expect(
      claimHyperPlanSelection({
        ownerId: 12,
        selectionId: selection.selectionId,
        requestId: "start-claim",
      }),
    ).toMatchObject({
      selectionId: selection.selectionId,
      planFingerprint: selection.planFingerprint,
    });
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId)).toBe(true);
    expect(
      transferHyperPlanReservationToRun({
        ownerId: 12,
        selectionId: selection.selectionId,
        requestId: "start-claim",
        sessionId: sourcePlan.sessionId,
        runId: "run-claim",
      }),
    ).toBe(true);
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId)).toBe(true);
    expect(
      releaseHyperPlanRunReservation({ sessionId: sourcePlan.sessionId, runId: "other-run" }),
    ).toBe(false);
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId)).toBe(true);
    expect(
      releaseHyperPlanRunReservation({ sessionId: sourcePlan.sessionId, runId: "run-claim" }),
    ).toBe(true);
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId)).toBe(false);

    const cleanupPreview = storeHyperPlanDraft({ ownerId: 12, sourcePlan, revision });
    const cleanupSelection = resolveHyperPlanDraftRequest({
      ownerId: 12,
      draftId: cleanupPreview.draftId,
      choice: "original",
      requestId: "cleanup-active",
      sourcePlan,
      resolvePlan: () => sourcePlan,
    });
    claimHyperPlanSelection({
      ownerId: 12,
      selectionId: cleanupSelection.selectionId,
      requestId: "cleanup-start",
    });
    transferHyperPlanReservationToRun({
      ownerId: 12,
      selectionId: cleanupSelection.selectionId,
      requestId: "cleanup-start",
      sessionId: sourcePlan.sessionId,
      runId: "cleanup-run",
    });
    clearHyperPlanDraftsForOwner(12);
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId)).toBe(true);
    expect(
      releaseHyperPlanRunReservation({ sessionId: sourcePlan.sessionId, runId: "cleanup-run" }),
    ).toBe(true);
  });

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
    const first = runHyperPlanStartOperation(input);
    const replay = runHyperPlanStartOperation(input);
    expect(start).toHaveBeenCalledTimes(1);
    expect(() => runHyperPlanStartOperation({ ...input, planId: "different-plan" })).toThrow(
      /conflict/i,
    );
    expect(() => runHyperPlanStartOperation({ ...input, requestId: "competing-request" })).toThrow(
      /reserved/i,
    );
    resolveStart(result);
    await expect(replay).resolves.toEqual(result);
    await expect(first).resolves.toEqual(result);
    await expect(runHyperPlanStartOperation(input)).resolves.toEqual(result);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("isolates start idempotency by owner epoch while deduplicating within an epoch", async () => {
    const epochA = registerHyperPlanDraftOwner(46);
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
    await expect(runHyperPlanStartOperation(input)).resolves.toMatchObject({ runId: "run-a" });
    await expect(runHyperPlanStartOperation(input)).resolves.toMatchObject({ runId: "run-a" });
    expect(input.start).toHaveBeenCalledTimes(1);

    const epochB = registerHyperPlanDraftOwner(46);
    const startB = vi.fn(async () => ({
      sessionId: "epoch-b-session",
      planId: sourcePlan.id,
      planFingerprint: "epoch-b",
      runId: "run-b",
    }));
    await expect(
      runHyperPlanStartOperation({
        ...input,
        ownerEpoch: epochB,
        sessionId: "epoch-b-session",
        planFingerprint: "epoch-b",
        start: startB,
      }),
    ).resolves.toMatchObject({ runId: "run-b" });
    expect(startB).toHaveBeenCalledTimes(1);
    expect(invalidateHyperPlanDraftOwner(46, epochA)).toBe(false);
    expect(
      getHyperPlanStartOperation({ ownerId: 46, ownerEpoch: epochA, requestId: input.requestId }),
    ).toBeUndefined();
    expect(
      getHyperPlanStartOperation({ ownerId: 46, ownerEpoch: epochB, requestId: input.requestId }),
    ).toMatchObject({ runId: "run-b" });
    expect(isHyperPlanSessionReserved("epoch-b-session")).toBe(true);
    expect(invalidateHyperPlanDraftOwner(46, epochB)).toBe(true);
    expect(isHyperPlanSessionReserved("epoch-b-session")).toBe(false);
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
    await expect(runHyperPlanStartOperation({ ...input, start })).rejects.toThrow(/preparation/i);
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId)).toBe(false);
    await expect(runHyperPlanStartOperation({ ...input, start })).resolves.toMatchObject({
      runId: "run-retried",
    });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale start reservation claim or transfer a replacement epoch reservation", async () => {
    const epochA = registerHyperPlanDraftOwner(47);
    let markA!: (runId: string) => void;
    let finishA!: (result: {
      sessionId: string;
      planId: string;
      planFingerprint: string;
      runId: string;
    }) => void;
    const startA = runHyperPlanStartOperation({
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
    expect(invalidateHyperPlanDraftOwner(47, epochA)).toBe(true);

    const epochB = registerHyperPlanDraftOwner(47);
    let markB!: (runId: string) => void;
    let finishB!: (result: {
      sessionId: string;
      planId: string;
      planFingerprint: string;
      runId: string;
    }) => void;
    const startB = runHyperPlanStartOperation({
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
      ownsHyperPlanStartReservation({
        ownerId: 47,
        ownerEpoch: epochA,
        requestId: "aba-request",
        sessionId: "aba-session",
      }),
    ).toBe(false);
    expect(() => markA("run-a")).toThrow(/reservation/i);
    expect(isHyperPlanSessionReserved("aba-session")).toBe(true);
    expect(
      ownsHyperPlanStartReservation({
        ownerId: 47,
        ownerEpoch: epochB,
        requestId: "aba-request",
        sessionId: "aba-session",
      }),
    ).toBe(true);
    markB("run-b");
    expect(
      transferHyperPlanReservationToRun({
        ownerId: 47,
        ownerEpoch: epochA,
        requestId: "aba-request",
        sessionId: "aba-session",
        runId: "run-a",
      }),
    ).toBe(false);
    expect(
      ownsHyperPlanStartReservation({
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

  it("scopes drafts, choice replay, and selections to the current owner epoch", () => {
    const epochA = registerHyperPlanDraftOwner(48);
    const preview = storeHyperPlanDraft({ ownerId: 48, ownerEpoch: epochA, sourcePlan, revision });
    const selection = resolveHyperPlanDraftRequest({
      ownerId: 48,
      ownerEpoch: epochA,
      draftId: preview.draftId,
      choice: "original",
      requestId: "epoch-choice",
      sourcePlan,
      resolvePlan: () => sourcePlan,
    });
    const epochB = registerHyperPlanDraftOwner(48);

    expect(
      peekHyperPlanDraft({ ownerId: 48, ownerEpoch: epochB, draftId: preview.draftId }),
    ).toBeUndefined();
    expect(
      getHyperPlanChoiceReplay({
        ownerId: 48,
        ownerEpoch: epochB,
        draftId: preview.draftId,
        choice: "original",
        requestId: "epoch-choice",
      }),
    ).toBeUndefined();
    expect(
      getHyperPlanSelection({
        ownerId: 48,
        ownerEpoch: epochB,
        selectionId: selection.selectionId,
      }),
    ).toBeUndefined();
    expect(
      claimHyperPlanSelection({
        ownerId: 48,
        ownerEpoch: epochB,
        selectionId: selection.selectionId,
        requestId: "epoch-start",
      }),
    ).toBeUndefined();
    expect(
      consumeHyperPlanSelection({
        ownerId: 48,
        ownerEpoch: epochB,
        selectionId: selection.selectionId,
      }),
    ).toBeUndefined();
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId)).toBe(true);
    expect(invalidateHyperPlanDraftOwner(48, epochA)).toBe(false);
    expect(isHyperPlanSessionReserved(sourcePlan.sessionId)).toBe(false);
  });

  it("derives stable UUID idempotency identities for owner epochs", () => {
    const epochA = registerHyperPlanDraftOwner(49);
    const identityA = getHyperPlanOwnerEpochIdentity(epochA);
    const epochB = registerHyperPlanDraftOwner(49);
    const identityB = getHyperPlanOwnerEpochIdentity(epochB);
    expect(identityA).toMatch(/^[0-9a-f-]{36}$/i);
    expect(identityB).toMatch(/^[0-9a-f-]{36}$/i);
    expect(identityA).toBe(getHyperPlanOwnerEpochIdentity(epochA));
    expect(identityB).toBe(getHyperPlanOwnerEpochIdentity(epochB));
    expect(identityA).not.toBe(identityB);
  });

  it("keeps a claimed selection reserved beyond its selection TTL while start is awaiting", async () => {
    const preview = storeHyperPlanDraft({ ownerId: 22, sourcePlan, revision });
    const selection = resolveHyperPlanDraftRequest({
      ownerId: 22,
      draftId: preview.draftId,
      choice: "original",
      requestId: "ttl-choice",
      sourcePlan,
      resolvePlan: () => sourcePlan,
    });
    let resolveStart!: (result: {
      sessionId: string;
      planId: string;
      planFingerprint: string;
      runId: string;
    }) => void;
    const operation = runHyperPlanStartOperation({
      ownerId: 22,
      requestId: "ttl-start",
      kind: "selection",
      selectionId: selection.selectionId,
      sessionId: sourcePlan.sessionId,
      planId: sourcePlan.id,
      planFingerprint: selection.planFingerprint,
      start: () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    });

    expect(isHyperPlanSessionReserved(sourcePlan.sessionId, Date.now() + 6 * 60_000)).toBe(true);
    resolveStart({
      sessionId: sourcePlan.sessionId,
      planId: sourcePlan.id,
      planFingerprint: selection.planFingerprint,
      runId: "run-after-ttl",
    });
    await operation;
  });

  it("does not claim a selection when operation identity does not match it", async () => {
    const preview = storeHyperPlanDraft({ ownerId: 23, sourcePlan, revision });
    const selection = resolveHyperPlanDraftRequest({
      ownerId: 23,
      draftId: preview.draftId,
      choice: "original",
      requestId: "identity-choice",
      sourcePlan,
      resolvePlan: () => sourcePlan,
    });
    const base = {
      ownerId: 23,
      kind: "selection" as const,
      selectionId: selection.selectionId,
      sessionId: sourcePlan.sessionId,
      planId: sourcePlan.id,
      planFingerprint: selection.planFingerprint,
      start: async () => ({
        sessionId: sourcePlan.sessionId,
        planId: sourcePlan.id,
        planFingerprint: selection.planFingerprint,
        runId: "run-identity",
      }),
    };
    expect(() =>
      runHyperPlanStartOperation({
        ...base,
        requestId: "wrong-identity",
        planFingerprint: "wrong",
      }),
    ).toThrow(/selection/i);
    expect(
      ownsHyperPlanStartReservation({
        ownerId: 23,
        requestId: "wrong-identity",
        sessionId: sourcePlan.sessionId,
      }),
    ).toBe(false);
    await expect(
      runHyperPlanStartOperation({ ...base, requestId: "correct-identity" }),
    ).resolves.toMatchObject({ runId: "run-identity" });
  });
});
