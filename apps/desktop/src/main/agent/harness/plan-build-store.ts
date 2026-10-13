import { randomUUID } from "node:crypto";

const START_TTL_MS = 30 * 60_000;
export type PlanBuildOwnerEpoch = symbol;
export type PlanBuildStart = {
  sessionId: string;
  planId: string;
  planFingerprint: string;
  runId: string;
};
export type PlanBuildStartOperation = {
  ownerId: number;
  ownerEpoch?: PlanBuildOwnerEpoch;
  requestId: string;
  kind: "original";
  sessionId: string;
  planId: string;
  planFingerprint: string;
  state: "starting" | "run_created" | "started" | "failed_before_run";
  runId?: string;
  result?: PlanBuildStart;
  expiresAt?: number;
};
type Reservation = {
  ownerId: number;
  ownerEpoch?: PlanBuildOwnerEpoch;
  kind: "generation" | "starting" | "active";
  requestId?: string;
  runId?: string;
  expiresAt?: number;
};
const reservations = new Map<string, Reservation>();
const startOperations = new Map<
  string,
  PlanBuildStartOperation & { promise?: Promise<PlanBuildStart> }
>();
const ownerEpochs = new Map<number, PlanBuildOwnerEpoch>();
const epochIds = new Map<PlanBuildOwnerEpoch, string>();

export function registerPlanBuildOwner(ownerId: number): PlanBuildOwnerEpoch {
  const epoch = Symbol(`plan-build-owner-${ownerId}`);
  epochIds.set(epoch, randomUUID());
  ownerEpochs.set(ownerId, epoch);
  return epoch;
}

export function getPlanBuildOwnerEpoch(ownerId: number): PlanBuildOwnerEpoch | undefined {
  return ownerEpochs.get(ownerId);
}

/** Stable, globally unique identity for durable idempotency keys; never expose to IPC clients. */
export function getPlanBuildOwnerEpochIdentity(
  ownerEpoch: PlanBuildOwnerEpoch,
): string | undefined {
  return epochIds.get(ownerEpoch);
}

function isCurrentEpoch(ownerId: number, ownerEpoch: PlanBuildOwnerEpoch | undefined): boolean {
  return ownerEpoch === undefined || ownerEpochs.get(ownerId) === ownerEpoch;
}

function operationKey(
  ownerId: number,
  requestId: string,
  ownerEpoch?: PlanBuildOwnerEpoch,
): string {
  const epochPart = ownerEpoch ? (epochIds.get(ownerEpoch) ?? "unknown") : null;
  return JSON.stringify([ownerId, epochPart, requestId]);
}

export function invalidatePlanBuildOwner(
  ownerId: number,
  ownerEpoch: PlanBuildOwnerEpoch,
): boolean {
  const wasCurrent = ownerEpochs.get(ownerId) === ownerEpoch;
  if (wasCurrent) ownerEpochs.delete(ownerId);
  for (const [sessionId, reservation] of reservations) {
    if (
      reservation.ownerId === ownerId &&
      reservation.ownerEpoch === ownerEpoch &&
      reservation.kind !== "active"
    )
      reservations.delete(sessionId);
  }
  for (const [key, operation] of startOperations) {
    if (operation.ownerId === ownerId && operation.ownerEpoch === ownerEpoch)
      startOperations.delete(key);
  }
  epochIds.delete(ownerEpoch);
  return wasCurrent;
}
function clearExpired(now: number): void {
  for (const [key, operation] of startOperations) {
    if (
      operation.expiresAt !== undefined &&
      operation.expiresAt <= now &&
      operation.state !== "starting" &&
      operation.state !== "run_created"
    )
      startOperations.delete(key);
  }
  for (const [sessionId, reservation] of reservations) {
    if (reservation.expiresAt !== undefined && reservation.expiresAt <= now)
      reservations.delete(sessionId);
  }
}

export function isPlanBuildSessionReserved(sessionId: string, now = Date.now()): boolean {
  clearExpired(now);
  return reservations.has(sessionId);
}

/** Transfer the start reservation to the run; terminal cleanup must match its runId. */
export function transferPlanBuildReservationToRun(input: {
  ownerId: number;
  ownerEpoch?: PlanBuildOwnerEpoch;
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
    reservation.requestId !== input.requestId
  )
    return false;
  reservations.set(input.sessionId, {
    ownerId: input.ownerId,
    kind: "active",
    ...(reservation.ownerEpoch ? { ownerEpoch: reservation.ownerEpoch } : {}),
    requestId: input.requestId,
    runId: input.runId,
  });
  return true;
}

export function releasePlanBuildRunReservation(input: {
  sessionId: string;
  runId: string;
}): boolean {
  const reservation = reservations.get(input.sessionId);
  if (reservation?.kind !== "active" || reservation.runId !== input.runId) return false;
  reservations.delete(input.sessionId);
  return true;
}

export function ownsPlanBuildStartReservation(input: {
  ownerId: number;
  ownerEpoch?: PlanBuildOwnerEpoch;
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

export function getPlanBuildStartOperation(input: {
  ownerId: number;
  ownerEpoch?: PlanBuildOwnerEpoch;
  requestId: string;
  now?: number;
}): PlanBuildStartOperation | undefined {
  clearExpired(input.now ?? Date.now());
  const operation = startOperations.get(
    operationKey(input.ownerId, input.requestId, input.ownerEpoch),
  );
  if (!operation) return undefined;
  const { promise: _promise, ...snapshot } = operation;
  return snapshot;
}

/** Main-owned idempotency ledger for a fresh PlanBuild build start. */
export function runPlanBuildStartOperation(input: {
  ownerId: number;
  ownerEpoch?: PlanBuildOwnerEpoch;
  requestId: string;
  kind: "original";
  sessionId: string;
  planId: string;
  planFingerprint: string;
  start: (
    operation: PlanBuildStartOperation,
    markRunCreated: (runId: string) => void,
  ) => Promise<PlanBuildStart>;
}): Promise<PlanBuildStart> {
  clearExpired(Date.now());
  if (input.ownerEpoch !== undefined && ownerEpochs.get(input.ownerId) !== input.ownerEpoch) {
    throw new Error("PlanBuild build owner incarnation is no longer active.");
  }
  const key = operationKey(input.ownerId, input.requestId, input.ownerEpoch);
  const existing = startOperations.get(key);
  const matches = (operation: PlanBuildStartOperation): boolean =>
    operation.kind === input.kind &&
    operation.sessionId === input.sessionId &&
    operation.planId === input.planId &&
    operation.planFingerprint === input.planFingerprint;
  if (existing && !matches(existing)) throw new Error("PlanBuild build start request conflict.");
  if (existing?.promise) return existing.promise;
  if (existing?.state === "started" && existing.result) return Promise.resolve(existing.result);

  let operation = existing;
  if (!operation) {
    if (!reservePlanBuildSession(input)) throw new Error("Plan build session is already reserved.");
    operation = {
      ownerId: input.ownerId,
      ...(input.ownerEpoch ? { ownerEpoch: input.ownerEpoch } : {}),
      requestId: input.requestId,
      kind: input.kind,
      sessionId: input.sessionId,
      planId: input.planId,
      planFingerprint: input.planFingerprint,
      state: "starting",
      expiresAt: Date.now() + START_TTL_MS,
    };
    startOperations.set(key, operation);
  } else if (operation.state === "failed_before_run") {
    const reservation = reservations.get(input.sessionId);
    if (reservation) throw new Error("Plan build session is already reserved.");
    reservations.set(input.sessionId, {
      ownerId: input.ownerId,
      ...(input.ownerEpoch ? { ownerEpoch: input.ownerEpoch } : {}),
      kind: "starting",
      requestId: input.requestId,
    });
    operation.state = "starting";
  }

  const current = operation;
  const markRunCreated = (runId: string): void => {
    if (
      !transferPlanBuildReservationToRun({
        ownerId: input.ownerId,
        ...(input.ownerEpoch ? { ownerEpoch: input.ownerEpoch } : {}),
        sessionId: input.sessionId,
        requestId: input.requestId,
        runId,
      })
    )
      throw new Error("The PlanBuild start reservation is no longer owned by this request.");
    current.runId = runId;
    current.state = "run_created";
  };
  let startPromise: Promise<PlanBuildStart>;
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
      current.expiresAt = Date.now() + START_TTL_MS;
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
export function clearPlanBuildStateForSession(sessionId: string): void {
  reservations.delete(sessionId);
  for (const [key, operation] of startOperations) {
    if (operation.sessionId === sessionId) startOperations.delete(key);
  }
}

/** Host-owned pre-run reservation; reused by approved build starts. */
export function reservePlanBuildSession(input: {
  sessionId: string;
  ownerId: number;
  ownerEpoch?: PlanBuildOwnerEpoch;
  requestId?: string;
  now?: number;
}): boolean {
  clearExpired(input.now ?? Date.now());
  if (!isCurrentEpoch(input.ownerId, input.ownerEpoch) || reservations.has(input.sessionId))
    return false;
  reservations.set(input.sessionId, {
    ownerId: input.ownerId,
    ...(input.ownerEpoch ? { ownerEpoch: input.ownerEpoch } : {}),
    kind: input.requestId ? "starting" : "generation",
    ...(input.requestId ? { requestId: input.requestId } : {}),
    expiresAt: (input.now ?? Date.now()) + START_TTL_MS,
  });
  return true;
}
export function releasePlanBuildSession(input: {
  sessionId: string;
  ownerId: number;
  ownerEpoch?: PlanBuildOwnerEpoch;
}): void {
  const reservation = reservations.get(input.sessionId);
  if (
    reservation?.ownerId === input.ownerId &&
    (input.ownerEpoch === undefined || reservation.ownerEpoch === input.ownerEpoch) &&
    reservation.kind !== "active"
  )
    reservations.delete(input.sessionId);
}
