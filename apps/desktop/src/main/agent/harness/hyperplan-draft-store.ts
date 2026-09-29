import { randomUUID } from "node:crypto";
import type { HyperPlanRevision, PlanRef } from "../../../shared/contracts";
import { fingerprintPlanSource } from "../../plan/plan-store";

const DRAFT_TTL_MS = 30 * 60_000;
const SELECTION_TTL_MS = 5 * 60_000;

export type HyperPlanChoice = "revision" | "original";

export type HyperPlanDraftPreview = {
  draftId: string;
  revision: HyperPlanRevision;
};

export type HyperPlanBuildSelection = {
  selectionId: string;
  plan: PlanRef;
  planFingerprint: string;
};

export type StoredHyperPlanDraft = {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  sessionId: string;
  workspaceId: string;
  planId: string;
  sourceFingerprint: string;
  revision: HyperPlanRevision;
  expiresAt: number;
};

export type HyperPlanDraftOwnerEpoch = symbol;

export type StoredHyperPlanSelection = {
  selectionId: string;
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  sessionId: string;
  workspaceId: string;
  planId: string;
  planFingerprint: string;
  choiceRequestId: string;
  choice: HyperPlanChoice;
  expiresAt: number;
};

export type HyperPlanBuildStart = {
  sessionId: string;
  planId: string;
  planFingerprint: string;
  runId: string;
};

export type HyperPlanStartOperation = {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  requestId: string;
  kind: "selection" | "original";
  selectionId?: string;
  sessionId: string;
  planId: string;
  planFingerprint: string;
  state: "starting" | "run_created" | "started" | "failed_before_run";
  runId?: string;
  result?: HyperPlanBuildStart;
  expiresAt?: number;
};

type SelectionRecord = StoredHyperPlanSelection & {
  plan: PlanRef;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  cancelled?: boolean;
};

type Reservation = {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  kind: "generation" | "selection" | "starting" | "active";
  selectionId?: string;
  requestId?: string;
  runId?: string;
  expiresAt?: number;
};

type ChoiceOperation = {
  ownerId: number;
  draftId: string;
  choice: HyperPlanChoice;
  sourceFingerprint: string;
  selectionId: string;
  selection: HyperPlanBuildSelection;
  expiresAt: number;
  cancelled: boolean;
  published: boolean;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
};

const drafts = new Map<string, StoredHyperPlanDraft>();
const selections = new Map<string, SelectionRecord>();
const reservations = new Map<string, Reservation>();
const choiceOperations = new Map<string, ChoiceOperation>();
const startOperations = new Map<
  string,
  HyperPlanStartOperation & { promise?: Promise<HyperPlanBuildStart> }
>();
const ownerEpochs = new Map<number, HyperPlanDraftOwnerEpoch>();
const epochIds = new Map<HyperPlanDraftOwnerEpoch, string>();

export function registerHyperPlanDraftOwner(ownerId: number): HyperPlanDraftOwnerEpoch {
  const epoch = Symbol(`hyperplan-owner-${ownerId}`);
  epochIds.set(epoch, randomUUID());
  ownerEpochs.set(ownerId, epoch);
  return epoch;
}

export function getHyperPlanDraftOwnerEpoch(ownerId: number): HyperPlanDraftOwnerEpoch | undefined {
  return ownerEpochs.get(ownerId);
}

/** Stable, globally unique identity for durable idempotency keys; never expose to IPC clients. */
export function getHyperPlanOwnerEpochIdentity(
  ownerEpoch: HyperPlanDraftOwnerEpoch,
): string | undefined {
  return epochIds.get(ownerEpoch);
}

function isCurrentEpoch(
  ownerId: number,
  ownerEpoch: HyperPlanDraftOwnerEpoch | undefined,
): boolean {
  return ownerEpoch === undefined || ownerEpochs.get(ownerId) === ownerEpoch;
}

export function invalidateHyperPlanDraftOwner(
  ownerId: number,
  ownerEpoch: HyperPlanDraftOwnerEpoch,
): boolean {
  const wasCurrent = ownerEpochs.get(ownerId) === ownerEpoch;
  if (wasCurrent) ownerEpochs.delete(ownerId);
  for (const [draftId, draft] of drafts) {
    if (draft.ownerId === ownerId && draft.ownerEpoch === ownerEpoch) drafts.delete(draftId);
  }
  for (const [selectionId, selection] of selections) {
    if (selection.ownerId === ownerId && selection.ownerEpoch === ownerEpoch) {
      cancelHyperPlanSelection({ ownerId, selectionId });
    }
  }
  for (const [sessionId, reservation] of reservations) {
    if (
      reservation.ownerId === ownerId &&
      reservation.ownerEpoch === ownerEpoch &&
      reservation.kind !== "active"
    ) {
      reservations.delete(sessionId);
    }
  }
  for (const [key, operation] of choiceOperations) {
    if (operation.ownerId === ownerId && operation.ownerEpoch === ownerEpoch) {
      choiceOperations.delete(key);
    }
  }
  for (const [key, operation] of startOperations) {
    if (operation.ownerId === ownerId && operation.ownerEpoch === ownerEpoch) {
      startOperations.delete(key);
    }
  }
  epochIds.delete(ownerEpoch);
  return wasCurrent;
}

function operationKey(
  ownerId: number,
  requestId: string,
  ownerEpoch?: HyperPlanDraftOwnerEpoch,
): string {
  const epochPart = ownerEpoch ? (epochIds.get(ownerEpoch) ?? "unknown") : null;
  return JSON.stringify([ownerId, epochPart, requestId]);
}

function clearExpired(now: number): void {
  for (const [draftId, draft] of drafts) {
    if (draft.expiresAt <= now) drafts.delete(draftId);
  }
  for (const [selectionId, selection] of selections) {
    if (selection.expiresAt <= now) {
      selections.delete(selectionId);
      const reservation = reservations.get(selection.sessionId);
      if (reservation?.selectionId === selectionId && reservation.kind === "selection") {
        reservations.delete(selection.sessionId);
      }
    }
  }
  for (const [key, operation] of choiceOperations) {
    if (operation.expiresAt <= now) choiceOperations.delete(key);
  }
  for (const [key, operation] of startOperations) {
    if (
      operation.expiresAt !== undefined &&
      operation.expiresAt <= now &&
      operation.state !== "starting" &&
      operation.state !== "run_created"
    ) {
      startOperations.delete(key);
    }
  }
  for (const [sessionId, reservation] of reservations) {
    if (reservation.expiresAt !== undefined && reservation.expiresAt <= now) {
      reservations.delete(sessionId);
    }
  }
}

export function storeHyperPlanDraft(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  sourcePlan: PlanRef;
  revision: HyperPlanRevision;
  now?: number;
}): HyperPlanDraftPreview {
  const now = input.now ?? Date.now();
  clearExpired(now);
  if (input.ownerEpoch !== undefined && ownerEpochs.get(input.ownerId) !== input.ownerEpoch) {
    throw new Error("HyperPlan draft owner incarnation is no longer active.");
  }
  if (!input.sourcePlan.spec) throw new Error("HyperPlan drafts require a Spec plan.");
  const draftId = randomUUID();
  const record: StoredHyperPlanDraft = {
    ownerId: input.ownerId,
    sessionId: input.sourcePlan.sessionId,
    workspaceId: input.sourcePlan.workspaceId,
    planId: input.sourcePlan.id,
    sourceFingerprint: fingerprintPlanSource(input.sourcePlan),
    revision: input.revision,
    expiresAt: now + DRAFT_TTL_MS,
    ...(input.ownerEpoch ? { ownerEpoch: input.ownerEpoch } : {}),
  };
  drafts.set(draftId, record);
  return { draftId, revision: input.revision };
}

export function takeHyperPlanDraft(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  draftId: string;
  now?: number;
}): StoredHyperPlanDraft | undefined {
  const now = input.now ?? Date.now();
  clearExpired(now);
  const draft = drafts.get(input.draftId);
  if (
    !isCurrentEpoch(input.ownerId, input.ownerEpoch) ||
    !draft ||
    draft.ownerId !== input.ownerId ||
    (input.ownerEpoch !== undefined && draft.ownerEpoch !== input.ownerEpoch)
  )
    return undefined;
  drafts.delete(input.draftId);
  return draft;
}

export function peekHyperPlanDraft(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  draftId: string;
  now?: number;
}): StoredHyperPlanDraft | undefined {
  const now = input.now ?? Date.now();
  clearExpired(now);
  const draft = drafts.get(input.draftId);
  return isCurrentEpoch(input.ownerId, input.ownerEpoch) &&
    draft?.ownerId === input.ownerId &&
    (input.ownerEpoch === undefined || draft.ownerEpoch === input.ownerEpoch) &&
    draft.expiresAt > now
    ? draft
    : undefined;
}

export function getHyperPlanChoiceReplay(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  draftId: string;
  choice: HyperPlanChoice;
  requestId: string;
  now?: number;
}): HyperPlanBuildSelection | undefined {
  const now = input.now ?? Date.now();
  clearExpired(now);
  if (!isCurrentEpoch(input.ownerId, input.ownerEpoch)) return undefined;
  const operation = choiceOperations.get(
    operationKey(input.ownerId, input.requestId, input.ownerEpoch),
  );
  if (!operation) return undefined;
  if (
    operation.draftId !== input.draftId ||
    operation.choice !== input.choice ||
    (input.ownerEpoch !== undefined && operation.ownerEpoch !== input.ownerEpoch)
  ) {
    throw new Error("HyperPlan choice request conflict.");
  }
  if (operation.cancelled || operation.expiresAt <= now) {
    throw new Error("HyperPlan selection was cancelled or expired.");
  }
  return operation.selection;
}

export function isHyperPlanChoicePublished(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  draftId: string;
  choice: HyperPlanChoice;
  requestId: string;
}): boolean {
  if (!isCurrentEpoch(input.ownerId, input.ownerEpoch)) return false;
  const operation = choiceOperations.get(
    operationKey(input.ownerId, input.requestId, input.ownerEpoch),
  );
  if (!operation) return false;
  if (
    operation.draftId !== input.draftId ||
    operation.choice !== input.choice ||
    (input.ownerEpoch !== undefined && operation.ownerEpoch !== input.ownerEpoch)
  ) {
    throw new Error("HyperPlan choice request conflict.");
  }
  return operation.published;
}

export function markHyperPlanChoicePublished(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  draftId: string;
  choice: HyperPlanChoice;
  requestId: string;
}): void {
  const operation = choiceOperations.get(
    operationKey(input.ownerId, input.requestId, input.ownerEpoch),
  );
  if (
    !isCurrentEpoch(input.ownerId, input.ownerEpoch) ||
    !operation ||
    operation.draftId !== input.draftId ||
    operation.choice !== input.choice ||
    (input.ownerEpoch !== undefined && operation.ownerEpoch !== input.ownerEpoch)
  ) {
    throw new Error("HyperPlan choice operation was not found.");
  }
  operation.published = true;
}

export function reserveHyperPlanSession(input: {
  sessionId: string;
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  clearExpired(now);
  if (input.ownerEpoch !== undefined && ownerEpochs.get(input.ownerId) !== input.ownerEpoch)
    return false;
  if (reservations.has(input.sessionId)) return false;
  reservations.set(input.sessionId, {
    ownerId: input.ownerId,
    ...(input.ownerEpoch ? { ownerEpoch: input.ownerEpoch } : {}),
    kind: "generation",
  });
  return true;
}

export function releaseHyperPlanSession(input: {
  sessionId: string;
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
}): boolean {
  const reservation = reservations.get(input.sessionId);
  if (
    !reservation ||
    reservation.ownerId !== input.ownerId ||
    reservation.kind !== "generation" ||
    (input.ownerEpoch !== undefined && reservation.ownerEpoch !== input.ownerEpoch)
  ) {
    return false;
  }
  reservations.delete(input.sessionId);
  return true;
}

export function isHyperPlanSessionReserved(sessionId: string, now = Date.now()): boolean {
  clearExpired(now);
  return reservations.has(sessionId);
}

export function resolveHyperPlanDraftRequest(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  draftId: string;
  choice: HyperPlanChoice;
  requestId: string;
  sourcePlan: PlanRef;
  resolvePlan: (draft: StoredHyperPlanDraft) => PlanRef;
  now?: number;
}): HyperPlanBuildSelection {
  const now = input.now ?? Date.now();
  clearExpired(now);
  if (!isCurrentEpoch(input.ownerId, input.ownerEpoch))
    throw new Error("HyperPlan draft owner incarnation is no longer active.");
  const key = operationKey(input.ownerId, input.requestId, input.ownerEpoch);
  const previous = choiceOperations.get(key);
  if (previous) {
    if (
      previous.draftId !== input.draftId ||
      previous.choice !== input.choice ||
      (input.ownerEpoch !== undefined && previous.ownerEpoch !== input.ownerEpoch)
    ) {
      throw new Error("HyperPlan choice request conflict.");
    }
    if (previous.cancelled) throw new Error("HyperPlan selection was cancelled or expired.");
    if (fingerprintPlanSource(input.sourcePlan) !== previous.selection.planFingerprint) {
      throw new Error("Plan source changed after the HyperPlan choice.");
    }
    return previous.selection;
  }

  const draft = drafts.get(input.draftId);
  if (
    !draft ||
    draft.ownerId !== input.ownerId ||
    draft.expiresAt <= now ||
    (input.ownerEpoch !== undefined && draft.ownerEpoch !== input.ownerEpoch)
  ) {
    throw new Error("HyperPlan draft is missing, expired, or belongs to another owner.");
  }
  if (
    input.sourcePlan.id !== draft.planId ||
    input.sourcePlan.sessionId !== draft.sessionId ||
    input.sourcePlan.workspaceId !== draft.workspaceId ||
    fingerprintPlanSource(input.sourcePlan) !== draft.sourceFingerprint
  ) {
    throw new Error("HyperPlan draft source is stale or belongs to another plan.");
  }
  if (reservations.has(draft.sessionId)) {
    throw new Error("HyperPlan session is already reserved.");
  }

  const selectionId = randomUUID();
  reservations.set(draft.sessionId, {
    ownerId: input.ownerId,
    ...(draft.ownerEpoch ? { ownerEpoch: draft.ownerEpoch } : {}),
    ...(draft.ownerEpoch ? { ownerEpoch: draft.ownerEpoch } : {}),
    kind: "selection",
    selectionId,
    expiresAt: now + SELECTION_TTL_MS,
  });
  let selectedPlan: PlanRef;
  try {
    selectedPlan = input.resolvePlan(draft);
    if (!isCurrentEpoch(input.ownerId, input.ownerEpoch)) {
      throw new Error("HyperPlan draft owner incarnation is no longer active.");
    }
    if (
      selectedPlan.id !== draft.planId ||
      selectedPlan.sessionId !== draft.sessionId ||
      selectedPlan.workspaceId !== draft.workspaceId
    ) {
      throw new Error("Resolved HyperPlan choice does not match its source plan owner.");
    }
  } catch (error) {
    const reservation = reservations.get(draft.sessionId);
    if (
      reservation?.ownerId === input.ownerId &&
      reservation.ownerEpoch === draft.ownerEpoch &&
      reservation.kind === "selection" &&
      reservation.selectionId === selectionId
    ) {
      reservations.delete(draft.sessionId);
    }
    throw error;
  }

  const planFingerprint = fingerprintPlanSource(selectedPlan);
  const selection: HyperPlanBuildSelection = {
    selectionId,
    plan: selectedPlan,
    planFingerprint,
  };
  const storedSelection: SelectionRecord = {
    selectionId,
    ownerId: input.ownerId,
    ...(draft.ownerEpoch ? { ownerEpoch: draft.ownerEpoch } : {}),
    sessionId: draft.sessionId,
    workspaceId: draft.workspaceId,
    planId: draft.planId,
    planFingerprint,
    choiceRequestId: input.requestId,
    choice: input.choice,
    expiresAt: now + SELECTION_TTL_MS,
    plan: selectedPlan,
    ...(draft.ownerEpoch ? { ownerEpoch: draft.ownerEpoch } : {}),
  };
  selections.set(selectionId, storedSelection);
  choiceOperations.set(key, {
    ownerId: input.ownerId,
    draftId: input.draftId,
    choice: input.choice,
    sourceFingerprint: draft.sourceFingerprint,
    selectionId,
    selection,
    expiresAt: now + SELECTION_TTL_MS,
    cancelled: false,
    published: input.choice === "original",
    ...(draft.ownerEpoch ? { ownerEpoch: draft.ownerEpoch } : {}),
  });
  drafts.delete(input.draftId);
  return selection;
}

export function getHyperPlanSelection(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  selectionId: string;
  now?: number;
}): StoredHyperPlanSelection | undefined {
  const now = input.now ?? Date.now();
  clearExpired(now);
  const selection = selections.get(input.selectionId);
  if (
    !isCurrentEpoch(input.ownerId, input.ownerEpoch) ||
    !selection ||
    selection.ownerId !== input.ownerId ||
    selection.expiresAt <= now ||
    (input.ownerEpoch !== undefined && selection.ownerEpoch !== input.ownerEpoch)
  ) {
    return undefined;
  }
  return selection;
}

export function consumeHyperPlanSelection(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  selectionId: string;
  now?: number;
}): StoredHyperPlanSelection | undefined {
  const selection = getHyperPlanSelection(input);
  if (!selection) return undefined;
  selections.delete(input.selectionId);
  const reservation = reservations.get(selection.sessionId);
  if (reservation?.selectionId === input.selectionId && reservation.kind === "selection") {
    reservations.delete(selection.sessionId);
  }
  const operation = choiceOperations.get(
    operationKey(input.ownerId, selection.choiceRequestId, selection.ownerEpoch),
  );
  if (operation?.selectionId === input.selectionId) operation.cancelled = true;
  return selection;
}

/** Claim a selection while retaining the session reservation for exclusive start. */
export function claimHyperPlanSelection(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  selectionId: string;
  requestId?: string;
}): StoredHyperPlanSelection | undefined {
  const selection = getHyperPlanSelection(input);
  if (!selection) return undefined;
  const reservation = reservations.get(selection.sessionId);
  if (
    !reservation ||
    reservation.ownerId !== input.ownerId ||
    (input.ownerEpoch !== undefined && reservation.ownerEpoch !== input.ownerEpoch) ||
    reservation.kind !== "selection" ||
    reservation.selectionId !== input.selectionId
  ) {
    return undefined;
  }
  reservations.set(selection.sessionId, {
    ownerId: input.ownerId,
    ...(reservation.ownerEpoch ? { ownerEpoch: reservation.ownerEpoch } : {}),
    kind: "starting",
    selectionId: input.selectionId,
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return selection;
}

/** Transfer the start reservation to the run; terminal cleanup must match its runId. */
export function transferHyperPlanReservationToRun(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  selectionId?: string;
  sessionId: string;
  requestId: string;
  runId: string;
}): boolean {
  const reservation = reservations.get(input.sessionId);
  if (
    !reservation ||
    reservation.ownerId !== input.ownerId ||
    (input.ownerEpoch !== undefined &&
      (reservation.ownerEpoch !== input.ownerEpoch ||
        !isCurrentEpoch(input.ownerId, input.ownerEpoch))) ||
    reservation.kind !== "starting" ||
    reservation.requestId !== input.requestId ||
    (input.selectionId !== undefined && reservation.selectionId !== input.selectionId)
  )
    return false;
  reservations.set(input.sessionId, {
    ownerId: input.ownerId,
    kind: "active",
    ...(reservation.ownerEpoch ? { ownerEpoch: reservation.ownerEpoch } : {}),
    ...(reservation.selectionId ? { selectionId: reservation.selectionId } : {}),
    requestId: input.requestId,
    runId: input.runId,
  });
  return true;
}

export function releaseHyperPlanRunReservation(input: {
  sessionId: string;
  runId: string;
}): boolean {
  const reservation = reservations.get(input.sessionId);
  if (reservation?.kind !== "active" || reservation.runId !== input.runId) return false;
  reservations.delete(input.sessionId);
  return true;
}

export function ownsHyperPlanStartReservation(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  requestId: string;
  sessionId: string;
  runId?: string;
}): boolean {
  const reservation = reservations.get(input.sessionId);
  return Boolean(
    isCurrentEpoch(input.ownerId, input.ownerEpoch) &&
      reservation &&
      reservation.ownerId === input.ownerId &&
      (input.ownerEpoch === undefined || reservation.ownerEpoch === input.ownerEpoch) &&
      reservation.requestId === input.requestId &&
      (input.runId === undefined
        ? reservation.kind === "starting"
        : reservation.kind === "active" && reservation.runId === input.runId),
  );
}

export function getHyperPlanStartOperation(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  requestId: string;
  now?: number;
}): HyperPlanStartOperation | undefined {
  clearExpired(input.now ?? Date.now());
  const operation = startOperations.get(
    operationKey(input.ownerId, input.requestId, input.ownerEpoch),
  );
  if (!operation) return undefined;
  const { promise: _promise, ...snapshot } = operation;
  return snapshot;
}

/** Main-owned idempotency ledger for a fresh HyperPlan build start. */
export function runHyperPlanStartOperation(input: {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  requestId: string;
  kind: "selection" | "original";
  selectionId?: string;
  sessionId: string;
  planId: string;
  planFingerprint: string;
  start: (
    operation: HyperPlanStartOperation,
    markRunCreated: (runId: string) => void,
  ) => Promise<HyperPlanBuildStart>;
}): Promise<HyperPlanBuildStart> {
  clearExpired(Date.now());
  if (input.ownerEpoch !== undefined && ownerEpochs.get(input.ownerId) !== input.ownerEpoch) {
    throw new Error("HyperPlan draft owner incarnation is no longer active.");
  }
  const key = operationKey(input.ownerId, input.requestId, input.ownerEpoch);
  const existing = startOperations.get(key);
  const matches = (operation: HyperPlanStartOperation): boolean =>
    operation.kind === input.kind &&
    operation.selectionId === input.selectionId &&
    operation.sessionId === input.sessionId &&
    operation.planId === input.planId &&
    operation.planFingerprint === input.planFingerprint;
  if (existing && !matches(existing)) throw new Error("HyperPlan build start request conflict.");
  if (existing?.promise) return existing.promise;
  if (existing?.state === "started" && existing.result) return Promise.resolve(existing.result);

  let operation = existing;
  if (!operation) {
    if (input.kind === "selection") {
      const selectionId = input.selectionId;
      if (!selectionId)
        throw new Error("HyperPlan selection is missing, stale, or already claimed.");
      const candidate = getHyperPlanSelection({
        ownerId: input.ownerId,
        ...(input.ownerEpoch ? { ownerEpoch: input.ownerEpoch } : {}),
        selectionId,
      });
      if (
        !candidate ||
        candidate.sessionId !== input.sessionId ||
        candidate.planId !== input.planId ||
        candidate.planFingerprint !== input.planFingerprint
      ) {
        throw new Error("HyperPlan selection is missing, stale, or already claimed.");
      }
      const selection = claimHyperPlanSelection({
        ownerId: input.ownerId,
        ...(input.ownerEpoch ? { ownerEpoch: input.ownerEpoch } : {}),
        selectionId,
        requestId: input.requestId,
      });
      if (!selection) throw new Error("HyperPlan selection is missing, stale, or already claimed.");
    } else {
      if (reservations.has(input.sessionId))
        throw new Error("HyperPlan session is already reserved.");
      reservations.set(input.sessionId, {
        ownerId: input.ownerId,
        ...(input.ownerEpoch ? { ownerEpoch: input.ownerEpoch } : {}),
        kind: "starting",
        requestId: input.requestId,
      });
    }
    operation = {
      ownerId: input.ownerId,
      ...(input.ownerEpoch ? { ownerEpoch: input.ownerEpoch } : {}),
      requestId: input.requestId,
      kind: input.kind,
      ...(input.selectionId ? { selectionId: input.selectionId } : {}),
      sessionId: input.sessionId,
      planId: input.planId,
      planFingerprint: input.planFingerprint,
      state: "starting",
      expiresAt: Date.now() + DRAFT_TTL_MS,
    };
    startOperations.set(key, operation);
  } else if (operation.state === "failed_before_run") {
    const reservation = reservations.get(input.sessionId);
    if (reservation) throw new Error("HyperPlan session is already reserved.");
    reservations.set(input.sessionId, {
      ownerId: input.ownerId,
      ...(input.ownerEpoch ? { ownerEpoch: input.ownerEpoch } : {}),
      kind: "starting",
      ...(input.selectionId ? { selectionId: input.selectionId } : {}),
      requestId: input.requestId,
    });
    operation.state = "starting";
  }

  const current = operation;
  const markRunCreated = (runId: string): void => {
    if (
      !transferHyperPlanReservationToRun({
        ownerId: input.ownerId,
        ...(input.ownerEpoch ? { ownerEpoch: input.ownerEpoch } : {}),
        ...(input.selectionId ? { selectionId: input.selectionId } : {}),
        sessionId: input.sessionId,
        requestId: input.requestId,
        runId,
      })
    )
      throw new Error("The HyperPlan start reservation is no longer owned by this request.");
    current.runId = runId;
    current.state = "run_created";
  };
  let startPromise: Promise<HyperPlanBuildStart>;
  try {
    startPromise = input.start(current, markRunCreated);
  } catch (error) {
    current.state = current.runId ? "run_created" : "failed_before_run";
    if (!current.runId) {
      const reservation = reservations.get(input.sessionId);
      if (
        reservation?.ownerId === input.ownerId &&
        reservation.ownerEpoch === input.ownerEpoch &&
        reservation.requestId === input.requestId
      ) {
        reservations.delete(input.sessionId);
      }
    }
    throw error;
  }
  current.promise = startPromise
    .then((result) => {
      current.result = result;
      current.runId = result.runId;
      current.state = "started";
      current.expiresAt = Date.now() + DRAFT_TTL_MS;
      return result;
    })
    .catch((error: unknown) => {
      delete current.promise;
      if (!current.runId) {
        current.state = "failed_before_run";
        const reservation = reservations.get(input.sessionId);
        if (
          reservation?.ownerId === input.ownerId &&
          reservation.ownerEpoch === input.ownerEpoch &&
          reservation.requestId === input.requestId
        ) {
          reservations.delete(input.sessionId);
        }
      } else {
        current.state = "run_created";
      }
      throw error;
    });
  return current.promise;
}

export function cancelHyperPlanSelection(input: { ownerId: number; selectionId: string }): boolean {
  const selection = selections.get(input.selectionId);
  if (!selection || selection.ownerId !== input.ownerId) return false;
  selections.delete(input.selectionId);
  const reservation = reservations.get(selection.sessionId);
  if (reservation?.selectionId === input.selectionId && reservation.kind === "selection") {
    reservations.delete(selection.sessionId);
  }
  const operation = choiceOperations.get(
    operationKey(input.ownerId, selection.choiceRequestId, selection.ownerEpoch),
  );
  if (operation?.selectionId === input.selectionId) operation.cancelled = true;
  return true;
}

export function clearHyperPlanDraftsForOwner(ownerId: number): void {
  for (const [draftId, draft] of drafts) {
    if (draft.ownerId === ownerId) drafts.delete(draftId);
  }
  for (const [selectionId, selection] of selections) {
    if (selection.ownerId === ownerId) cancelHyperPlanSelection({ ownerId, selectionId });
  }
  for (const [sessionId, reservation] of reservations) {
    if (
      reservation.ownerId === ownerId &&
      (reservation.kind === "generation" || reservation.kind === "selection")
    ) {
      reservations.delete(sessionId);
    }
  }
  for (const [key, operation] of choiceOperations) {
    if (operation.ownerId === ownerId) choiceOperations.delete(key);
  }
}

export function clearHyperPlanDraftsForSession(sessionId: string): void {
  for (const [draftId, draft] of drafts) {
    if (draft.sessionId === sessionId) drafts.delete(draftId);
  }
  for (const [selectionId, selection] of selections) {
    if (selection.sessionId === sessionId) {
      cancelHyperPlanSelection({ ownerId: selection.ownerId, selectionId });
    }
  }
  reservations.delete(sessionId);
  for (const [key, operation] of choiceOperations) {
    if (operation.selection.plan.sessionId === sessionId) choiceOperations.delete(key);
  }
  for (const [key, operation] of startOperations) {
    if (operation.sessionId === sessionId) startOperations.delete(key);
  }
}
