import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { planTurnContext } from "../../src/main/context/context-planner";
import { getDatabase } from "../../src/main/db/database";
import type { ProjectMemoryDigest } from "../../src/shared/contracts";
import type { QualityFixture } from "./fixtures";

const QUERY = "partial refund webhook first delivery before settlement idempotency reversal status";

const EXPECTED_ANSWER = {
  status: "pending",
  reversalCreated: false,
  idempotencyKey: "provider_event_id",
};

function seedRecord(input: {
  id: string;
  workspaceId: string;
  title: string;
  claim: string;
  createdAt: string;
}): void {
  getDatabase()
    .prepare(`insert into project_memory_records
      (id, scope, workspace_id, category, title, claim, status, verification,
       created_at, updated_at, last_verified_at, dedupe_key)
      values (?, 'project', ?, 'decision', ?, ?, 'active', 'parent_verified', ?, ?, ?, ?)`)
    .run(
      input.id,
      input.workspaceId,
      input.title,
      input.claim,
      input.createdAt,
      input.createdAt,
      input.createdAt,
      input.id,
    );
}

/** Seeds two isolated workspace records; only the current workspace may enter the digest. */
export function seedScopedRecallEvaluationMemories(input: {
  workspaceId: string;
  decoyWorkspaceId: string;
}): { expectedMemoryId: string; decoyMemoryId: string } {
  const now = new Date().toISOString();
  const expectedMemoryId = `quality-recall-${randomUUID()}`;
  const decoyMemoryId = `quality-recall-${randomUUID()}`;
  seedRecord({
    id: expectedMemoryId,
    workspaceId: input.workspaceId,
    title: "Partial refund webhook decision",
    claim:
      "For the first delivery of a partial refund webhook before settlement, persist status as pending; do not create a reversal or mark the refund complete. Reconcile later using provider_event_id as the idempotency key.",
    createdAt: now,
  });
  seedRecord({
    id: decoyMemoryId,
    workspaceId: input.decoyWorkspaceId,
    title: "Cross-workspace decoy for partial refund webhook",
    claim:
      "Wrong prior decision: mark the partial refund complete immediately and create a reversal before settlement.",
    createdAt: now,
  });
  return { expectedMemoryId, decoyMemoryId };
}

/** Uses the production project-memory retrieval and context planner in local isolated storage. */
export function buildScopedRecallContext(
  workspaceId: string,
  sessionId: string,
): Promise<ProjectMemoryDigest> {
  return planTurnContext({
    workspaceId,
    inbox: false,
    query: QUERY,
    contextPaths: [],
    contextSymbols: [],
    git: { changedPaths: [] },
    sessionId,
    runId: "quality-evaluation",
  });
}

function verifiesAnswer(files: Record<string, string>): boolean {
  try {
    const parsed: unknown = JSON.parse(files["answer.json"] ?? "");
    return isDeepStrictEqual(parsed, EXPECTED_ANSWER);
  } catch {
    return false;
  }
}

export const SCOPED_RECALL_FIXTURE: QualityFixture = {
  id: "scoped-refund-recall-en",
  language: "en",
  prompt:
    "Use the relevant local project context to write answer.json with exactly the established status, whether a reversal is created, and the idempotency key for a partial refund webhook received before settlement. Do not infer a different policy from unrelated projects.",
  files: { "answer.json": "{}\n" },
  writable: ["answer.json"],
  verify: ({ files }) => [
    {
      name: "answer matches the current project's recorded decision",
      passed: verifiesAnswer(files),
    },
  ],
};

export const SCOPED_RECALL_PROMPT_QUERY = QUERY;
