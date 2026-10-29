import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type {
  ProjectMemoryCategory,
  ProjectMemoryDigest,
  ProjectMemoryEvidence,
  ProjectMemoryRecord,
  ProjectMemoryScope,
  ProjectMemorySnapshot,
  ProjectMemoryStatus,
  ProjectMemoryVerification,
} from "../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";
import { resolveMcpCitation } from "../agent/harness/mcp-citation-registry";
import { getDatabase } from "../db/database";
import { canonicalizeExternalReferenceUrl } from "./external-reference-url";

export type ProjectMemoryProposalInput = {
  scope: "global" | "project";
  category: ProjectMemoryCategory;
  title: string;
  claim: string;
  evidence: Array<ProjectMemoryEvidence | { kind: "external_reference"; citationId: string }>;
  supersedesId?: string;
};

export type ProjectMemoryContext = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  userMessageId?: string;
  cwd: string;
  parentSessionId?: string;
  subagentWorktree?: boolean;
};

export type ProjectMemoryRetrievalInput = {
  workspaceId?: string;
  inbox: boolean;
  query: string;
  contextPaths: string[];
  contextSymbols: string[];
  git: { branch?: string; head?: string; changedPaths: string[] };
  tokenBudget?: number;
};

export type ProjectMemorySessionSummary = {
  id: string;
  category: ProjectMemoryCategory;
  claim: string;
};

export const PROJECT_MEMORY_SESSION_SUMMARY_LIMIT = 8;
export const PROJECT_MEMORY_SESSION_SUMMARY_CLAIM_CHARS = 320;

export const PROJECT_MEMORY_LIMITS = {
  titleChars: 160,
  claimChars: 1200,
  evidenceItems: 32,
  evidenceStringChars: 1024,
} as const;

/** Per-record evidence cap for renderer-facing memory DTOs; the database retains all provenance rows. */
export const PROJECT_MEMORY_EVIDENCE_DTO_LIMIT = 32;

/** Maximum active local memories admitted to one Context Planner scoring pass. */
export const PROJECT_MEMORY_PLANNING_RESULT_LIMIT = 160;
/** Reserve one quarter of the planner feed for exact file/symbol-linked memories. */
export const PROJECT_MEMORY_PLANNING_EXACT_EVIDENCE_RESERVE = 40;
/** Limit evidence path hints independently so Git paths cannot be crowded out. */
export const PROJECT_MEMORY_PLANNING_PATH_HINT_LIMIT = 32;
export const PROJECT_MEMORY_PLANNING_SYMBOL_HINT_LIMIT = 64;

const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key|api[_-]?key|api[_-]?token|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|private[_-]?key|authorization|token)\s*[:=]\s*["']?([A-Za-z0-9_./+=:-]{8,})/gi;
const SECRET_MATERIAL_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,}/i,
  /\b(?:sk-(?:proj|svcacct|admin|ant|live|test)-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/i,
];

const NON_SECRET_ASSIGNMENT_VALUES = new Set([
  "redacted",
  "placeholder",
  "example",
  "changeme",
  "change-me",
  "your_api_key",
  "your-token",
  "none",
  "null",
]);

function containsSecretLikeContent(value: string): boolean {
  if (SECRET_MATERIAL_PATTERNS.some((pattern) => pattern.test(value))) return true;
  CREDENTIAL_ASSIGNMENT_PATTERN.lastIndex = 0;
  for (
    let match = CREDENTIAL_ASSIGNMENT_PATTERN.exec(value);
    match;
    match = CREDENTIAL_ASSIGNMENT_PATTERN.exec(value)
  ) {
    const assignedValue = (match[1] ?? "").replace(/^['"]|['"]$/g, "").toLowerCase();
    if (!NON_SECRET_ASSIGNMENT_VALUES.has(assignedValue)) return true;
  }
  return false;
}

function validateProposalContent(input: ProjectMemoryProposalInput): void {
  if (
    typeof input.title !== "string" ||
    input.title.trim().length < 2 ||
    input.title.length > PROJECT_MEMORY_LIMITS.titleChars ||
    typeof input.claim !== "string" ||
    input.claim.trim().length < 8 ||
    input.claim.length > PROJECT_MEMORY_LIMITS.claimChars
  ) {
    throw new Error("Project memory title or claim is outside allowed bounds");
  }
  if (containsSecretLikeContent(input.title) || containsSecretLikeContent(input.claim)) {
    throw new Error("Project memory contains secret-like credential material");
  }
  if (
    !Array.isArray(input.evidence) ||
    input.evidence.length > PROJECT_MEMORY_LIMITS.evidenceItems
  ) {
    throw new Error(`Project memory evidence count exceeds ${PROJECT_MEMORY_LIMITS.evidenceItems}`);
  }
  for (const item of input.evidence) {
    if (!item || typeof item !== "object")
      throw new Error("Project memory evidence metadata must be an object");
    const metadata =
      item.kind === "external_reference" && "externalReference" in item
        ? item.externalReference
        : undefined;
    const fields = metadata ? [metadata.url, metadata.title] : Object.values(item);
    for (const value of fields) {
      if (typeof value !== "string") continue;
      if (value.length > PROJECT_MEMORY_LIMITS.evidenceStringChars) {
        throw new Error(
          `Project memory evidence metadata exceeds ${PROJECT_MEMORY_LIMITS.evidenceStringChars} characters`,
        );
      }
      if (containsSecretLikeContent(value))
        throw new Error("Project memory evidence contains secret-like credential material");
    }
  }
}

type RecordRow = {
  id: string;
  scope: "global" | "project";
  workspace_id: string | null;
  category: ProjectMemoryCategory;
  title: string;
  claim: string;
  status: ProjectMemoryStatus;
  verification: ProjectMemoryVerification;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  supersedes_id: string | null;
};
type EvidenceRow = {
  kind: ProjectMemoryEvidence["kind"];
  session_id: string | null;
  run_id: string | null;
  user_message_id: string | null;
  task_ref: string | null;
  commit_sha: string | null;
  branch: string | null;
  path: string | null;
  symbol: string | null;
  detached: number;
  external_reference_json?: string | null;
};

function evidenceToDtos(evidence: EvidenceRow[]): ProjectMemoryEvidence[] {
  return evidence.map((item) =>
    item.kind === "external_reference"
      ? {
          kind: "external_reference" as const,
          externalReference: JSON.parse(item.external_reference_json ?? "{}"),
          ...(item.session_id ? { sessionId: item.session_id } : {}),
          ...(item.run_id ? { runId: item.run_id } : {}),
          ...(item.detached ? { detached: true } : {}),
        }
      : {
          kind: item.kind,
          ...(item.session_id ? { sessionId: item.session_id } : {}),
          ...(item.run_id ? { runId: item.run_id } : {}),
          ...(item.user_message_id ? { userMessageId: item.user_message_id } : {}),
          ...(item.task_ref ? { taskRef: item.task_ref } : {}),
          ...(item.commit_sha ? { commitSha: item.commit_sha } : {}),
          ...(item.branch ? { branch: item.branch } : {}),
          ...(item.path ? { path: item.path } : {}),
          ...(item.symbol ? { symbol: item.symbol } : {}),
          ...(item.detached ? { detached: true } : {}),
        },
  );
}

function canonicalExternalUrl(raw: string): string {
  const canonical = canonicalizeExternalReferenceUrl(
    raw,
    PROJECT_MEMORY_LIMITS.evidenceStringChars,
  );
  if (!canonical) throw new Error("External reference URL is malformed, unsafe, or oversized");
  return canonical;
}

function toRecord(row: RecordRow, evidenceOverride?: EvidenceRow[]): ProjectMemoryRecord {
  const evidence =
    evidenceOverride ??
    (
      getDatabase()
        .prepare(`select * from project_memory_evidence where memory_id = ?
    order by rowid desc limit ?`)
        .all(row.id, PROJECT_MEMORY_EVIDENCE_DTO_LIMIT) as EvidenceRow[]
    ).reverse();
  return {
    id: row.id,
    scope:
      row.scope === "global"
        ? { kind: "global" }
        : { kind: "project", workspaceId: row.workspace_id as string },
    category: row.category,
    title: row.title,
    claim: row.claim,
    status: row.status,
    verification: row.verification,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_verified_at ? { lastVerifiedAt: row.last_verified_at } : {}),
    ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
    evidence: evidenceToDtos(evidence),
  };
}

function keyFor(input: ProjectMemoryProposalInput, workspaceId?: string): string {
  return createHash("sha256")
    .update(
      `${input.category}\0${input.title.trim().toLowerCase()}\0${input.claim.trim().toLowerCase()}\0${workspaceId ?? "global"}`,
    )
    .digest("hex");
}

function normalizeEvidence(
  evidence: ProjectMemoryProposalInput["evidence"],
  context: ProjectMemoryContext,
  owningMessageId: string | null,
): ProjectMemoryEvidence[] {
  return evidence.map((item) => {
    if (item.kind === "external_reference") {
      if ("citationId" in item) {
        const citation = resolveMcpCitation(context.sessionId, context.runId, item.citationId);
        if (!citation) throw new Error("External citation ID was not resolved by the main process");
        if (citation.sessionId !== context.sessionId || citation.runId !== context.runId) {
          throw new Error("External citation provenance does not match the owning session and run");
        }
        const url = canonicalExternalUrl(citation.url);
        const title = citation.title?.trim();
        if (
          title &&
          (title.length > PROJECT_MEMORY_LIMITS.evidenceStringChars ||
            containsSecretLikeContent(title))
        ) {
          throw new Error("External citation title is outside allowed metadata bounds");
        }
        if (
          !citation.serverName.trim() ||
          citation.serverName.length > PROJECT_MEMORY_LIMITS.evidenceStringChars
        ) {
          throw new Error("External citation source label is outside allowed metadata bounds");
        }
        if (
          !Number.isFinite(Date.parse(citation.retrievedAt)) ||
          citation.retrievedAt.length > PROJECT_MEMORY_LIMITS.evidenceStringChars
        ) {
          throw new Error("External citation retrieval time is invalid");
        }
        return {
          kind: "external_reference",
          sessionId: context.sessionId,
          runId: context.runId,
          externalReference: {
            url,
            ...(title ? { title } : {}),
            sourceLabel: citation.serverName.trim(),
            retrievedAt: citation.retrievedAt,
            origin: "mcp_attested",
          },
        };
      }
      const external = item.externalReference;
      if (!external || typeof external.url !== "string")
        throw new Error("External reference URL is required");
      const url = canonicalExternalUrl(external.url);
      const title = external.title?.trim();
      if (title && title.length > PROJECT_MEMORY_LIMITS.evidenceStringChars)
        throw new Error("External reference title exceeds metadata bounds");
      if (title && containsSecretLikeContent(title))
        throw new Error("External reference metadata contains secret-like credential material");
      return {
        kind: "external_reference",
        sessionId: item.sessionId ?? context.sessionId,
        runId: item.runId ?? context.runId,
        ...(item.detached ? { detached: true } : {}),
        externalReference: {
          url,
          ...(title ? { title } : {}),
          sourceLabel: "Agent-supplied",
          retrievedAt: new Date().toISOString(),
          origin: "agent_supplied_unverified",
        },
      };
    }
    if (
      (item.sessionId && item.sessionId !== context.sessionId) ||
      (item.runId && item.runId !== context.runId)
    ) {
      throw new Error("Evidence provenance does not match the owning session and run");
    }
    if (item.userMessageId !== undefined && item.userMessageId !== owningMessageId) {
      throw new Error("User message evidence does not belong to the owning session and run");
    }
    if (
      item.kind === "user_message" &&
      (!owningMessageId || item.userMessageId !== owningMessageId)
    ) {
      throw new Error("User message evidence must belong to the owning session and run");
    }
    const normalized: ProjectMemoryEvidence = {
      ...item,
      ...(item.sessionId ? {} : { sessionId: context.sessionId }),
      ...(item.runId ? {} : { runId: context.runId }),
    };
    if (item.path !== undefined) {
      if (
        !item.path ||
        isAbsolute(item.path) ||
        win32.isAbsolute(item.path) ||
        /^[a-z]:/i.test(item.path)
      ) {
        throw new Error("Evidence path must be workspace-relative, not absolute");
      }
      const absolute = resolve(context.cwd, item.path);
      const pathFromRoot = relative(context.cwd, absolute);
      if (
        pathFromRoot === ".." ||
        pathFromRoot.startsWith(`..${sep}`) ||
        resolve(absolute) === resolve(context.cwd)
      ) {
        throw new Error("Evidence path must remain inside the owning workspace");
      }
      normalized.path = pathFromRoot.split(sep).join("/");
    }
    return normalized;
  });
}

function addEvent(
  id: string,
  from: ProjectMemoryStatus | null,
  to: ProjectMemoryStatus,
  actor: string,
  reason: string,
  idempotencyKey?: string,
): void {
  getDatabase()
    .prepare(`insert or ignore into project_memory_events
    (id, memory_id, from_status, to_status, actor, reason, idempotency_key, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(),
      id,
      from,
      to,
      actor,
      reason,
      idempotencyKey ?? null,
      new Date().toISOString(),
    );
}

function attachEvidenceToMemory(memoryId: string, evidence: ProjectMemoryEvidence[]): void {
  const db = getDatabase();
  const find = db.prepare(`select 1 from project_memory_evidence where memory_id = ? and kind = ?
    and session_id is ? and run_id is ? and user_message_id is ? and task_ref is ? and commit_sha is ?
    and branch is ? and path is ? and symbol is ? and detached = ?
    and (kind != 'external_reference' or json_extract(external_reference_json, '$.url') = ?)`);
  const insert = db.prepare(`insert into project_memory_evidence
    (id, memory_id, kind, session_id, run_id, user_message_id, task_ref, commit_sha, branch, path, symbol, detached, external_reference_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const item of evidence) {
    const values = [
      item.kind,
      item.sessionId ?? null,
      item.runId ?? null,
      item.userMessageId ?? null,
      item.taskRef ?? null,
      item.commitSha ?? null,
      item.branch ?? null,
      item.path ?? null,
      item.symbol ?? null,
      item.detached ? 1 : 0,
      item.kind === "external_reference" ? (item.externalReference?.url ?? null) : null,
    ];
    if (!find.get(memoryId, ...values))
      insert.run(
        randomUUID(),
        memoryId,
        ...values.slice(0, 10),
        item.kind === "external_reference" ? JSON.stringify(item.externalReference) : null,
      );
  }
}

function transition(
  memoryId: string,
  to: ProjectMemoryStatus,
  actor: string,
  reason: string,
  allowedFrom: ProjectMemoryStatus[],
  verified = false,
): boolean {
  const db = getDatabase();
  const row = db.prepare("select status from project_memory_records where id = ?").get(memoryId) as
    | { status: ProjectMemoryStatus }
    | undefined;
  if (!row) return false;
  if (!allowedFrom.includes(row.status))
    throw new Error(`Illegal project memory transition: ${row.status} → ${to}`);
  const now = new Date().toISOString();
  if (verified) {
    db.prepare(
      "update project_memory_records set status = ?, verification = 'parent_verified', updated_at = ?, last_verified_at = ? where id = ?",
    ).run(to, now, now, memoryId);
  } else {
    db.prepare("update project_memory_records set status = ?, updated_at = ? where id = ?").run(
      to,
      now,
      memoryId,
    );
  }
  addEvent(memoryId, row.status, to, actor, reason);
  return true;
}

export function proposeProjectMemory(
  input: ProjectMemoryProposalInput,
  context: ProjectMemoryContext,
): ProjectMemoryRecord {
  validateProposalContent(input);
  const title = input.title.trim();
  const claim = input.claim.trim();
  const db = getDatabase();
  const owner = db
    .prepare(`select s.workspace_id, s.cwd, s.parent_session_id, s.subagent_worktree_path, r.user_message_id
    from agent_sessions s join agent_runs r on r.session_id = s.id where s.id = ? and r.id = ?`)
    .get(context.sessionId, context.runId) as
    | {
        workspace_id: string;
        cwd: string;
        parent_session_id: string | null;
        subagent_worktree_path: string | null;
        user_message_id: string | null;
      }
    | undefined;
  if (
    !owner ||
    owner.workspace_id !== context.workspaceId ||
    (resolve(owner.cwd) !== resolve(context.cwd) &&
      (!owner.subagent_worktree_path ||
        resolve(owner.subagent_worktree_path) !== resolve(context.cwd)))
  ) {
    throw new Error("Proposal context does not match a persisted owning session and run");
  }
  if (input.scope === "project" && owner.workspace_id === CHATS_WORKSPACE_ID) {
    throw new Error("Inbox sessions cannot create project-scoped memories");
  }
  if (input.scope === "global" && owner.parent_session_id !== null) {
    throw new Error("Child sessions cannot create global project memories");
  }
  if (context.userMessageId && context.userMessageId !== owner.user_message_id) {
    throw new Error("Proposal user message does not belong to the owning run");
  }
  const containsExternal = input.evidence.some((item) => item.kind === "external_reference");
  if (input.scope === "global") {
    if (containsExternal)
      throw new Error("External-reference evidence cannot support global memories");
    if (input.category !== "preference" && input.category !== "convention")
      throw new Error("Global memories must be preferences or conventions");
    if (
      !input.evidence.some(
        (item) =>
          item.kind === "user_message" &&
          typeof item.userMessageId === "string" &&
          item.userMessageId === owner.user_message_id,
      )
    ) {
      throw new Error("Global memories require user-origin message evidence");
    }
  }
  const workspaceId = input.scope === "project" ? context.workspaceId : undefined;
  if (!settingEnabled(input.scope, workspaceId))
    throw new Error(`${input.scope} project memory is disabled`);
  const evidence = normalizeEvidence(input.evidence, context, owner.user_message_id);
  const dedupeKey = keyFor({ ...input, title, claim }, workspaceId);
  const prior = db
    .prepare(
      "select * from project_memory_records where scope = ? and ifnull(workspace_id, '') = ? and dedupe_key = ?",
    )
    .get(input.scope, workspaceId ?? "", dedupeKey) as RecordRow | undefined;
  if (prior) {
    db.exec("begin");
    try {
      attachEvidenceToMemory(prior.id, evidence);
      db.prepare("update project_memory_records set updated_at = ? where id = ?").run(
        new Date().toISOString(),
        prior.id,
      );
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
    return toRecord(
      db.prepare("select * from project_memory_records where id = ?").get(prior.id) as RecordRow,
    );
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const externalOnly =
    evidence.length > 0 && evidence.every((item) => item.kind === "external_reference");
  const status: ProjectMemoryStatus = externalOnly
    ? "needs_review"
    : owner.subagent_worktree_path
      ? "provisional"
      : "candidate";
  db.exec("begin");
  try {
    if (input.supersedesId) {
      const old = db
        .prepare("select status, scope, workspace_id from project_memory_records where id = ?")
        .get(input.supersedesId) as
        | { status: ProjectMemoryStatus; scope: string; workspace_id: string | null }
        | undefined;
      if (
        !old ||
        old.scope !== input.scope ||
        (input.scope === "project" && old.workspace_id !== workspaceId)
      )
        throw new Error("Superseded memory must belong to the same scope");
      if (!["candidate", "active", "provisional", "needs_review"].includes(old.status))
        throw new Error("Memory cannot be superseded from its current state");
    }
    db.prepare(`insert into project_memory_records
      (id, scope, workspace_id, category, title, claim, status, verification, created_at, updated_at, supersedes_id, dedupe_key)
      values (?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, ?)`).run(
      id,
      input.scope,
      workspaceId ?? null,
      input.category,
      title,
      claim,
      status,
      now,
      now,
      input.supersedesId ?? null,
      dedupeKey,
    );
    const addEvidence = db.prepare(`insert into project_memory_evidence
      (id, memory_id, kind, session_id, run_id, user_message_id, task_ref, commit_sha, branch, path, symbol, detached, external_reference_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of evidence)
      addEvidence.run(
        randomUUID(),
        id,
        item.kind,
        item.sessionId ?? null,
        item.runId ?? null,
        item.userMessageId ?? null,
        item.taskRef ?? null,
        item.commitSha ?? null,
        item.branch ?? null,
        item.path ?? null,
        item.symbol ?? null,
        item.detached ? 1 : 0,
        item.kind === "external_reference" ? JSON.stringify(item.externalReference) : null,
      );
    addEvent(id, null, status, "agent", "Candidate proposed", `proposal:${dedupeKey}`);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return toRecord(
    db.prepare("select * from project_memory_records where id = ?").get(id) as RecordRow,
  );
}

export function finalizeProjectMemoryRun(input: {
  sessionId: string;
  runId: string;
  outcome: "completed" | "failed" | "cancelled";
}): void {
  const db = getDatabase();
  const run = db
    .prepare("select status from agent_runs where id = ? and session_id = ?")
    .get(input.runId, input.sessionId) as { status: string } | undefined;
  if (!run || run.status !== input.outcome) return;
  const rows = db
    .prepare(`select distinct r.* from project_memory_records r
    join project_memory_evidence e on e.memory_id = r.id
    join agent_runs a on a.id = e.run_id and a.session_id = e.session_id
    join agent_sessions s on s.id = a.session_id
    where e.session_id = ? and e.run_id = ? and s.subagent_worktree_path is null
      and r.status in ('candidate','needs_review')
      and exists (select 1 from project_memory_evidence local_e where local_e.memory_id = r.id and local_e.kind != 'external_reference')`)
    .all(input.sessionId, input.runId) as RecordRow[];
  db.exec("begin");
  try {
    for (const row of rows) {
      if (input.outcome === "completed" || row.category === "failed_attempt") {
        if (row.supersedes_id) {
          transition(row.supersedes_id, "superseded", "run", `Superseded by ${row.id}`, [
            "candidate",
            "active",
            "provisional",
            "needs_review",
          ]);
        }
        const now = new Date().toISOString();
        db.prepare(
          "update project_memory_records set status = 'active', verification = ?, updated_at = ?, last_verified_at = ? where id = ?",
        ).run(
          input.outcome === "completed" ? "agent_observed" : "unverified",
          now,
          input.outcome === "completed" ? now : null,
          row.id,
        );
        addEvent(
          row.id,
          row.status,
          "active",
          "run",
          `Run ${input.outcome}`,
          `finalize:${input.sessionId}:${input.runId}:${row.id}`,
        );
      }
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function recordProjectMemoryCompaction(input: {
  sessionId: string;
  runId: string;
  aborted: boolean;
  willRetry: boolean;
}): void {
  if (input.aborted || input.willRetry) return;
  const db = getDatabase();
  const run = db
    .prepare("select 1 as found from agent_runs where id = ? and session_id = ?")
    .get(input.runId, input.sessionId);
  if (!run) return;
  const rows = db
    .prepare(`select distinct r.id, r.status from project_memory_records r
    join project_memory_evidence e on e.memory_id = r.id
    where e.session_id = ? and e.run_id = ? and r.status in ('candidate','provisional','needs_review')`)
    .all(input.sessionId, input.runId) as Array<{ id: string; status: ProjectMemoryStatus }>;
  const idempotencyKey = `compaction:${input.sessionId}:${input.runId}`;
  db.exec("begin");
  try {
    for (const row of rows) {
      addEvent(
        row.id,
        row.status,
        row.status,
        "main",
        "Successful compaction bookkeeping",
        idempotencyKey,
      );
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function retrieveProjectMemory(input: ProjectMemoryRetrievalInput): ProjectMemoryDigest {
  const db = getDatabase();
  const workspaceId =
    input.inbox || input.workspaceId === CHATS_WORKSPACE_ID ? undefined : input.workspaceId;
  const globalEnabled = settingEnabled("global");
  const projectEnabled = !!workspaceId && settingEnabled("project", workspaceId);
  const scopes = globalEnabled ? ["global"] : [];
  if (workspaceId && projectEnabled) scopes.push("project");
  if (!scopes.length) return { text: "", memoryIds: [], estimatedTokens: 0 };
  const rows = db
    .prepare(`select * from project_memory_records where status = 'active' and
    ((scope = 'global' and ? = 1) or (scope = 'project' and workspace_id = ? and ? = 1))
    order by coalesce(last_verified_at, created_at) desc`)
    .all(globalEnabled ? 1 : 0, workspaceId ?? "", projectEnabled ? 1 : 0) as RecordRow[];
  const budget = Math.max(0, input.tokenBudget ?? 1200);
  const selected: ProjectMemoryRecord[] = [];
  let text = "";
  for (const row of rows) {
    const record = toRecord(row);
    const line = `- ${record.title}: ${record.claim} [${record.category}; ${record.id}]`;
    if (Math.ceil(`${text}${text ? "\n" : ""}${line}`.length / 4) > budget) continue;
    selected.push(record);
    text += `${text ? "\n" : ""}${line}`;
  }
  return {
    text,
    memoryIds: selected.map((record) => record.id),
    estimatedTokens: Math.ceil(text.length / 4),
  };
}

type PlanningEvidenceRow = EvidenceRow & { evidence_rowid: number };

function planningEvidenceForMemory(
  memoryId: string,
  paths: string[],
  symbols: string[],
): EvidenceRow[] {
  const db = getDatabase();
  const clauses: string[] = [];
  const matchParams: string[] = [];
  if (paths.length > 0) {
    clauses.push(`path in (${paths.map(() => "?").join(",")})`);
    matchParams.push(...paths);
  }
  if (symbols.length > 0) {
    clauses.push(`symbol in (${symbols.map(() => "?").join(",")})`);
    matchParams.push(...symbols);
  }
  if (clauses.length === 0) {
    return (
      db
        .prepare(
          `select * from project_memory_evidence where memory_id = ? order by rowid desc limit ?`,
        )
        .all(memoryId, PROJECT_MEMORY_EVIDENCE_DTO_LIMIT) as EvidenceRow[]
    ).reverse();
  }

  const exact = db
    .prepare(`select rowid as evidence_rowid, * from project_memory_evidence
    where memory_id = ? and (${clauses.join(" or ")}) order by rowid desc limit ?`)
    .all(memoryId, ...matchParams, PROJECT_MEMORY_EVIDENCE_DTO_LIMIT) as PlanningEvidenceRow[];
  const remaining = PROJECT_MEMORY_EVIDENCE_DTO_LIMIT - exact.length;
  let recent: PlanningEvidenceRow[] = [];
  if (remaining > 0) {
    const exactRowIds = exact.map((row) => row.evidence_rowid);
    const exclude =
      exactRowIds.length > 0 ? `and rowid not in (${exactRowIds.map(() => "?").join(",")})` : "";
    recent = db
      .prepare(`select rowid as evidence_rowid, * from project_memory_evidence
      where memory_id = ? ${exclude} order by rowid desc limit ?`)
      .all(memoryId, ...exactRowIds, remaining) as PlanningEvidenceRow[];
  }
  return [...exact, ...recent]
    .sort((a, b) => a.evidence_rowid - b.evidence_rowid)
    .map(({ evidence_rowid: _rowId, ...row }) => row);
}

/** Bounded, settings/scope-filtered active-memory feed for local Context Planner scoring. */
export function getProjectMemoriesForPlanning(
  input: Pick<ProjectMemoryRetrievalInput, "workspaceId" | "inbox"> & {
    contextPaths?: string[];
    changedPaths?: string[];
    contextSymbols?: string[];
  },
): ProjectMemoryRecord[] {
  const db = getDatabase();
  const workspaceId = input.workspaceId;
  const inbox = input.inbox || !workspaceId || workspaceId === CHATS_WORKSPACE_ID;
  const scopeAndSettingsSql = `r.status = 'active'
    and (
      (r.scope = 'global' and coalesce((
        select enabled from project_memory_settings where scope = 'global' and workspace_id is null
      ), 1) = 1)
      or (
        ? = 0 and r.scope = 'project' and r.workspace_id = ?
        and coalesce((
          select enabled from project_memory_settings where scope = 'project' and workspace_id = ?
        ), 1) = 1
      )
    )`;
  const scopeParams = [inbox ? 1 : 0, workspaceId ?? "", workspaceId ?? ""];
  const normalizePath = (path: string): string =>
    path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const paths = [
    ...new Set(
      [
        ...(input.contextPaths ?? []).slice(0, PROJECT_MEMORY_PLANNING_PATH_HINT_LIMIT),
        ...(input.changedPaths ?? []).slice(0, PROJECT_MEMORY_PLANNING_PATH_HINT_LIMIT),
      ]
        .map(normalizePath)
        .filter(Boolean),
    ),
  ];
  const symbols = [
    ...new Set(
      (input.contextSymbols ?? [])
        .slice(0, PROJECT_MEMORY_PLANNING_SYMBOL_HINT_LIMIT)
        .map((symbol) => symbol.trim())
        .filter(Boolean),
    ),
  ];
  const exactClauses: string[] = [];
  const exactParams: string[] = [];
  if (paths.length > 0) {
    exactClauses.push(
      `exists (select 1 from project_memory_evidence pe where pe.memory_id = r.id and pe.path in (${paths.map(() => "?").join(",")}))`,
    );
    exactParams.push(...paths);
  }
  if (symbols.length > 0) {
    exactClauses.push(
      `exists (select 1 from project_memory_evidence pe where pe.memory_id = r.id and pe.symbol in (${symbols.map(() => "?").join(",")}))`,
    );
    exactParams.push(...symbols);
  }

  const exactRows =
    exactClauses.length > 0
      ? (db
          .prepare(`select r.* from project_memory_records r where ${scopeAndSettingsSql}
      and (${exactClauses.join(" or ")})
      order by coalesce(r.last_verified_at, r.created_at) desc, r.id asc limit ?`)
          .all(
            ...scopeParams,
            ...exactParams,
            PROJECT_MEMORY_PLANNING_EXACT_EVIDENCE_RESERVE,
          ) as RecordRow[])
      : [];
  const remaining = Math.max(0, PROJECT_MEMORY_PLANNING_RESULT_LIMIT - exactRows.length);
  const excludedIds = exactRows.map((row) => row.id);
  const excludeSql =
    excludedIds.length > 0 ? `and r.id not in (${excludedIds.map(() => "?").join(",")})` : "";
  const recentRows =
    remaining > 0
      ? (db
          .prepare(`select r.* from project_memory_records r where ${scopeAndSettingsSql} ${excludeSql}
      order by coalesce(r.last_verified_at, r.created_at) desc, r.id asc limit ?`)
          .all(...scopeParams, ...excludedIds, remaining) as RecordRow[])
      : [];
  return [...exactRows, ...recentRows].map((row) =>
    toRecord(row, planningEvidenceForMemory(row.id, paths, symbols)),
  );
}

function settingEnabled(scope: "global" | "project", workspaceId?: string): boolean {
  const row = getDatabase()
    .prepare("select enabled from project_memory_settings where scope = ? and workspace_id is ?")
    .get(scope, workspaceId ?? null) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : true;
}

export function getProjectMemorySnapshot(workspaceId?: string): ProjectMemorySnapshot {
  const db = getDatabase();
  const rows = workspaceId
    ? db
        .prepare(
          "select * from project_memory_records where scope = 'global' or (scope = 'project' and workspace_id = ?) order by created_at desc",
        )
        .all(workspaceId)
    : db
        .prepare(
          "select * from project_memory_records where scope = 'global' order by created_at desc",
        )
        .all();
  return {
    globalEnabled: settingEnabled("global"),
    projectEnabled: workspaceId ? settingEnabled("project", workspaceId) : true,
    memories: (rows as RecordRow[]).map((row) => toRecord(row)),
  };
}

/** Bounded wait-tool summaries sourced from all internal evidence rows, not the DTO's evidence projection. */
export function getProjectMemorySessionSummaries(sessionId: string): ProjectMemorySessionSummary[] {
  const rows = getDatabase()
    .prepare(`select distinct r.id, r.category, r.claim from project_memory_records r
    join project_memory_evidence e on e.memory_id = r.id
    where e.session_id = ? and r.status in ('candidate','active','provisional')
    order by r.updated_at desc, r.id limit ?`)
    .all(sessionId, PROJECT_MEMORY_SESSION_SUMMARY_LIMIT) as Array<{
    id: string;
    category: ProjectMemoryCategory;
    claim: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    claim: row.claim.slice(0, PROJECT_MEMORY_SESSION_SUMMARY_CLAIM_CHARS),
  }));
}

export function setProjectMemoryEnabled(input: {
  scope: ProjectMemoryScope;
  enabled: boolean;
}): ProjectMemorySnapshot {
  const db = getDatabase();
  const scope = input.scope.kind;
  const workspaceId = input.scope.kind === "project" ? input.scope.workspaceId : null;
  const existing = db
    .prepare("select 1 as found from project_memory_settings where scope = ? and workspace_id is ?")
    .get(scope, workspaceId);
  if (existing) {
    db.prepare(
      "update project_memory_settings set enabled = ?, updated_at = ? where scope = ? and workspace_id is ?",
    ).run(input.enabled ? 1 : 0, new Date().toISOString(), scope, workspaceId);
  } else {
    db.prepare(
      "insert into project_memory_settings(scope, workspace_id, enabled, updated_at) values (?, ?, ?, ?)",
    ).run(scope, workspaceId, input.enabled ? 1 : 0, new Date().toISOString());
  }
  return getProjectMemorySnapshot(workspaceId ?? undefined);
}

export function verifyProjectMemory(memoryId: string): ProjectMemorySnapshot {
  const row = getDatabase()
    .prepare("select scope, workspace_id from project_memory_records where id = ?")
    .get(memoryId) as { scope: string; workspace_id: string | null } | undefined;
  if (!row) return getProjectMemorySnapshot();
  const db = getDatabase();
  db.exec("begin");
  try {
    const record = db
      .prepare("select status, supersedes_id from project_memory_records where id = ?")
      .get(memoryId) as { status: ProjectMemoryStatus; supersedes_id: string | null };
    if (!["candidate", "provisional", "needs_review"].includes(record.status))
      throw new Error(`Illegal project memory transition: ${record.status} → active`);
    if (record.supersedes_id)
      transition(record.supersedes_id, "superseded", "user", `Superseded by ${memoryId}`, [
        "candidate",
        "active",
        "provisional",
        "needs_review",
      ]);
    transition(
      memoryId,
      "active",
      "user",
      "Explicitly verified",
      ["candidate", "provisional", "needs_review"],
      true,
    );
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return getProjectMemorySnapshot(row.workspace_id ?? undefined);
}

export function markProjectMemoryObsolete(memoryId: string): ProjectMemorySnapshot {
  const db = getDatabase();
  const row = db
    .prepare("select workspace_id from project_memory_records where id = ?")
    .get(memoryId) as { workspace_id: string | null } | undefined;
  if (!row) return getProjectMemorySnapshot();
  db.exec("begin");
  try {
    transition(memoryId, "obsolete", "user", "Marked obsolete", [
      "candidate",
      "active",
      "provisional",
      "needs_review",
    ]);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return getProjectMemorySnapshot(row.workspace_id ?? undefined);
}

export function deleteProjectMemory(memoryId: string): ProjectMemorySnapshot {
  const db = getDatabase();
  const row = db
    .prepare("select workspace_id from project_memory_records where id = ?")
    .get(memoryId) as { workspace_id: string | null } | undefined;
  db.exec("begin");
  try {
    db.prepare("delete from project_memory_records where id = ?").run(memoryId);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return getProjectMemorySnapshot(row?.workspace_id ?? undefined);
}

export function detachProjectMemoryEvidenceForSession(sessionId: string): void {
  getDatabase()
    .prepare(
      `update project_memory_evidence set session_id = null, run_id = null, user_message_id = null, detached = 1 where session_id = ?`,
    )
    .run(sessionId);
}

export function invalidateProjectMemoriesForRuns(sessionId: string, runIds: string[]): void {
  if (!runIds.length) return;
  const db = getDatabase();
  const placeholders = runIds.map(() => "?").join(",");
  const rows = db
    .prepare(`select distinct r.id, r.status, r.supersedes_id from project_memory_records r join project_memory_evidence e on e.memory_id = r.id
    where e.session_id = ? and e.run_id in (${placeholders})`)
    .all(sessionId, ...runIds) as Array<{
    id: string;
    status: ProjectMemoryStatus;
    supersedes_id: string | null;
  }>;
  const savepoint = `project_memory_rollback_${randomUUID().replaceAll("-", "")}`;
  db.exec(`savepoint ${savepoint}`);
  try {
    const now = new Date().toISOString();
    const invalidatedIds = new Set(rows.map((row) => row.id));
    for (const row of rows) {
      if (row.status === "obsolete") continue;
      db.prepare(
        "update project_memory_records set status = 'needs_review', updated_at = ? where id = ?",
      ).run(now, row.id);
      addEvent(
        row.id,
        row.status,
        "needs_review",
        "rollback",
        "Evidence run was rolled back",
        `rollback:${sessionId}:${runIds.join(",")}:${row.id}`,
      );
    }
    for (const row of rows) {
      if (row.status === "obsolete" || !row.supersedes_id || invalidatedIds.has(row.supersedes_id))
        continue;
      const replacement = db
        .prepare(
          "select 1 as found from project_memory_records where supersedes_id = ? and status = 'active' limit 1",
        )
        .get(row.supersedes_id);
      const predecessor = db
        .prepare("select status from project_memory_records where id = ?")
        .get(row.supersedes_id) as { status: ProjectMemoryStatus } | undefined;
      const priorTransition = db
        .prepare(`select from_status from project_memory_events
        where memory_id = ? and to_status = 'superseded' and reason = ? order by rowid desc limit 1`)
        .get(row.supersedes_id, `Superseded by ${row.id}`) as
        | { from_status: ProjectMemoryStatus | null }
        | undefined;
      const priorStatus = priorTransition?.from_status;
      if (
        !replacement &&
        predecessor?.status === "superseded" &&
        (priorStatus === "candidate" ||
          priorStatus === "active" ||
          priorStatus === "provisional" ||
          priorStatus === "needs_review")
      ) {
        db.prepare("update project_memory_records set status = ?, updated_at = ? where id = ?").run(
          priorStatus,
          now,
          row.supersedes_id,
        );
        addEvent(
          row.supersedes_id,
          "superseded",
          priorStatus,
          "rollback",
          `Replacement ${row.id} was rolled back`,
          `rollback-restore:${sessionId}:${runIds.join(",")}:${row.supersedes_id}`,
        );
      }
    }
    db.exec(`release savepoint ${savepoint}`);
  } catch (error) {
    db.exec(`rollback to savepoint ${savepoint}`);
    db.exec(`release savepoint ${savepoint}`);
    throw error;
  }
}
