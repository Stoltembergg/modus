import { createHash, randomUUID } from "node:crypto";
import type {
  AdaptiveFailureAttempt,
  AdaptiveFailureAttemptStatus,
  AgentEvent,
} from "../../../shared/contracts";

export const MAX_FAILURE_ATTEMPTS_PER_RUN = 64;
export const MAX_FAILURE_STRATEGY_CODE_LENGTH = 96;
export const MAX_FAILURE_REASON_CODE_LENGTH = 96;
export const MAX_FAILURE_EVIDENCE_REFS = 16;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,95}$/;

export type RecordFailureAttemptInput = {
  sessionId: string;
  runId: string;
  strategyCode: string;
  hypothesisCode?: string;
  status: AdaptiveFailureAttemptStatus;
  reasonCode: string;
  revision?: string;
  evidenceEventIds?: string[];
  createdAt?: string;
};

function normalizeCode(value: string, max: number): string | undefined {
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!trimmed || trimmed.length > max || !SAFE_CODE.test(trimmed)) return undefined;
  return trimmed;
}

function safeIds(ids: string[] | undefined, max: number): string[] {
  if (!ids) return [];
  const out: string[] = [];
  for (const id of ids) {
    if (!SAFE_ID.test(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** Stable fingerprint for equivalent strategy retries (no prompt/command text). */
export function failureAttemptSignature(
  attempt: Pick<AdaptiveFailureAttempt, "strategyCode" | "hypothesisCode" | "revision">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        strategyCode: attempt.strategyCode,
        hypothesisCode: attempt.hypothesisCode ?? null,
        revision: attempt.revision ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

export function createFailureAttempt(input: RecordFailureAttemptInput): AdaptiveFailureAttempt {
  if (!SAFE_ID.test(input.sessionId) || !SAFE_ID.test(input.runId)) {
    throw new Error("Unsafe Failure Intelligence owner identifier");
  }
  const strategyCode = normalizeCode(input.strategyCode, MAX_FAILURE_STRATEGY_CODE_LENGTH);
  const reasonCode = normalizeCode(input.reasonCode, MAX_FAILURE_REASON_CODE_LENGTH);
  if (!strategyCode || !reasonCode) {
    throw new Error("Invalid Failure Intelligence strategy or reason code");
  }
  const hypothesisCode = input.hypothesisCode
    ? normalizeCode(input.hypothesisCode, MAX_FAILURE_STRATEGY_CODE_LENGTH)
    : undefined;
  const revision = input.revision && SAFE_ID.test(input.revision) ? input.revision : undefined;
  return {
    id: randomUUID(),
    sessionId: input.sessionId,
    runId: input.runId,
    strategyCode,
    ...(hypothesisCode ? { hypothesisCode } : {}),
    status: input.status,
    reasonCode,
    ...(revision ? { revision } : {}),
    evidenceEventIds: safeIds(input.evidenceEventIds, MAX_FAILURE_EVIDENCE_REFS),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function isDuplicateFailedAttempt(
  attempts: readonly AdaptiveFailureAttempt[],
  candidate: Pick<AdaptiveFailureAttempt, "strategyCode" | "hypothesisCode" | "revision">,
): boolean {
  const signature = failureAttemptSignature(candidate);
  return attempts.some(
    (attempt) =>
      (attempt.status === "failed" || attempt.status === "discarded") &&
      failureAttemptSignature(attempt) === signature,
  );
}

export function listAvoidedStrategyCodes(
  attempts: readonly AdaptiveFailureAttempt[],
  revision?: string,
): string[] {
  const avoided = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.status !== "failed" && attempt.status !== "discarded") continue;
    if (revision !== undefined && attempt.revision !== undefined && attempt.revision !== revision) {
      continue;
    }
    if (revision !== undefined && attempt.revision === undefined) continue;
    if (revision === undefined && attempt.revision !== undefined) continue;
    avoided.add(attempt.strategyCode);
  }
  return [...avoided].slice(0, MAX_FAILURE_ATTEMPTS_PER_RUN);
}

export function reduceFailureAttemptsFromEvents(
  events: readonly AgentEvent[],
  sessionId: string,
  runId: string,
): AdaptiveFailureAttempt[] {
  const attempts: AdaptiveFailureAttempt[] = [];
  for (const event of events) {
    if (event.type !== "harness.failure") continue;
    if (event.sessionId !== sessionId || event.runId !== runId) continue;
    const attempt = event.attempt;
    if (!SAFE_ID.test(attempt.id) || attempt.sessionId !== sessionId || attempt.runId !== runId) {
      continue;
    }
    attempts.push(attempt);
    if (attempts.length >= MAX_FAILURE_ATTEMPTS_PER_RUN) break;
  }
  return attempts;
}

export type FailureLedger = {
  attempts: AdaptiveFailureAttempt[];
};

export function createFailureLedger(seed: readonly AdaptiveFailureAttempt[] = []): FailureLedger {
  return { attempts: seed.slice(0, MAX_FAILURE_ATTEMPTS_PER_RUN) };
}

export function appendFailureAttempt(
  ledger: FailureLedger,
  attempt: AdaptiveFailureAttempt,
): FailureLedger {
  if (isDuplicateFailedAttempt(ledger.attempts, attempt) && attempt.status === "failed") {
    return ledger;
  }
  return {
    attempts: [...ledger.attempts, attempt].slice(-MAX_FAILURE_ATTEMPTS_PER_RUN),
  };
}
