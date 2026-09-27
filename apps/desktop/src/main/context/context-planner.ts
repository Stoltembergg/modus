import {
  CHATS_WORKSPACE_ID,
  type ProjectMemoryCategory,
  type ProjectMemoryDigest,
  type ProjectMemoryEvidence,
  type ProjectMemoryRecord,
  type ProjectMemoryScope,
  type ProjectMemoryVerification,
} from "../../shared/contracts";
import {
  getProjectMemoriesForPlanning,
  type ProjectMemoryRetrievalInput,
} from "../memory/project-memory-service";

export type ContextCandidate = {
  id: string;
  sourceId: string;
  scope: ProjectMemoryScope;
  text: string;
  score: number;
  trust: "local-memory" | "code-map" | "external-reference";
  evidence: ProjectMemoryEvidence[];
  verifiedAt?: string;
};

export interface ContextCandidateSource {
  readonly sourceId: string;
  retrieve(input: ContextPlannerInput): Promise<ContextCandidate[]>;
}

export type ContextPlannerInput = ProjectMemoryRetrievalInput & {
  sessionId: string;
  runId?: string;
};

export type ContextPlanDiagnostics = {
  rankedIds: string[];
  ranked: Array<{ id: string; sourceId: string; score: number; reasons: string[] }>;
  selectedIds: string[];
  estimatedTokens: number;
};

export const CONTEXT_PLANNER_OPTIONAL_SOURCE_TIMEOUT_MS = 75;

/** Query at most this many active local memories before deterministic scoring. */
export const CONTEXT_PLANNER_LOCAL_RESULT_LIMIT = 160;
/** Optional sources are bounded too; they are discovery hints, never turn dependencies. */
const OPTIONAL_SOURCE_RESULT_LIMIT = 80;
const DEFAULT_TOKEN_BUDGET = 1200;
const MAX_TOKEN_BUDGET = 1200;
const STOP_TERMS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "because",
  "before",
  "between",
  "from",
  "have",
  "into",
  "more",
  "most",
  "only",
  "should",
  "that",
  "their",
  "then",
  "there",
  "these",
  "this",
  "those",
  "through",
  "with",
  "would",
  "your",
  "the",
  "for",
  "you",
  "use",
  "using",
  "used",
  "when",
  "where",
  "what",
  "which",
]);
const CATEGORY_VALUE: Record<ProjectMemoryCategory, number> = {
  decision: 9,
  architecture: 8,
  convention: 7,
  constraint: 12,
  known_issue: 6,
  solution: 10,
  failed_attempt: 4,
  task_result: 5,
  preference: 6,
};
const VERIFICATION_VALUE: Record<ProjectMemoryVerification, number> = {
  user_explicit: 14,
  agent_observed: 9,
  tests_passed: 18,
  parent_verified: 20,
  unverified: 0,
};
const EVIDENCE_VALUE: Record<ProjectMemoryEvidence["kind"], number> = {
  user_message: 6,
  run: 2,
  task: 7,
  subagent: 3,
  commit: 6,
  file: 8,
  symbol: 10,
  external_reference: 0,
};

type LocalCandidate = ContextCandidate & {
  [LOCAL_MEMORY_ORIGIN]: true;
  category: ProjectMemoryCategory;
  status: "active";
  verification: ProjectMemoryVerification;
  updatedAt: string;
};
type RankedCandidate = {
  candidate: ContextCandidate;
  score: number;
  reasons: string[];
  localMetadata?: {
    category: ProjectMemoryCategory;
    status: "active";
    verification: ProjectMemoryVerification;
  };
};

/** Only the local SQLite adapter can attach this private origin marker. */
const LOCAL_MEMORY_ORIGIN: unique symbol = Symbol("local-memory-origin");

function localCandidate(record: ProjectMemoryRecord): LocalCandidate {
  return {
    [LOCAL_MEMORY_ORIGIN]: true,
    id: record.id,
    sourceId: "local-memory",
    scope: record.scope,
    text: `${record.title}: ${record.claim}`,
    score: 0,
    trust: "local-memory",
    evidence: record.evidence,
    ...(record.lastVerifiedAt ? { verifiedAt: record.lastVerifiedAt } : {}),
    category: record.category,
    status: "active",
    verification: record.verification,
    updatedAt: record.updatedAt,
  };
}

function normalizedTerms(value: string): Set<string> {
  return new Set(
    (
      value
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []
    ).filter((term) => term.length > 1 && !STOP_TERMS.has(term)),
  );
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function ageDays(timestamp: string | undefined, nowMs: number): number | undefined {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, (nowMs - parsed) / 86_400_000) : undefined;
}

function candidateTerms(candidate: ContextCandidate): Set<string> {
  const evidenceText = candidate.evidence
    .flatMap((item) => [item.path, item.symbol, item.branch, item.taskRef, item.commitSha])
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return normalizedTerms(`${candidate.text} ${evidenceText}`);
}

function scoreCandidate(
  candidate: ContextCandidate,
  input: ContextPlannerInput,
  nowMs: number,
): RankedCandidate {
  let score = Number.isFinite(candidate.score) ? candidate.score : 0;
  const reasons: string[] = [];
  const local = LOCAL_MEMORY_ORIGIN in candidate ? (candidate as LocalCandidate) : undefined;
  const category = local?.category;
  const verification = local?.verification;
  if (category) {
    score += CATEGORY_VALUE[category];
    reasons.push(`category:${category}`);
  }
  if (verification) {
    score += VERIFICATION_VALUE[verification];
    reasons.push(`verification:${verification}`);
  }

  const queryTerms = normalizedTerms(input.query);
  const terms = candidateTerms(candidate);
  const overlap = [...queryTerms].filter((term) => terms.has(term));
  if (overlap.length > 0) {
    score +=
      overlap.length * 5 +
      (queryTerms.size > 0 ? Math.round((overlap.length / queryTerms.size) * 20) : 0);
    reasons.push(`task-term-overlap:${overlap.length}/${queryTerms.size}`);
  }

  const expectedPaths = new Set(
    [...input.contextPaths, ...input.git.changedPaths].map(normalizeRelativePath),
  );
  const evidencePaths = candidate.evidence
    .map((item) => item.path)
    .filter((value): value is string => Boolean(value));
  const exactPath = evidencePaths.find((path) => expectedPaths.has(normalizeRelativePath(path)));
  if (exactPath) {
    score += 80;
    reasons.push(`exact-path:${normalizeRelativePath(exactPath)}`);
  }
  if (
    input.git.changedPaths.some((changed) =>
      evidencePaths.some((path) => normalizeRelativePath(changed) === normalizeRelativePath(path)),
    )
  ) {
    score += 24;
    reasons.push("git:changed-path");
  }

  const exactSymbol = candidate.evidence
    .map((item) => item.symbol)
    .find((symbol) => symbol !== undefined && input.contextSymbols.includes(symbol));
  if (exactSymbol) {
    score += 90;
    reasons.push(`exact-symbol:${exactSymbol}`);
  }
  if (input.git.branch && candidate.evidence.some((item) => item.branch === input.git.branch)) {
    score += 16;
    reasons.push("git:branch");
  }
  if (input.git.head && candidate.evidence.some((item) => item.commitSha === input.git.head)) {
    score += 20;
    reasons.push("git:head");
  }

  const quality = Math.max(0, ...candidate.evidence.map((item) => EVIDENCE_VALUE[item.kind]));
  if (quality > 0) {
    score += quality;
    reasons.push(`evidence-quality:${quality}`);
  }
  const localUpdatedAt = local?.updatedAt;
  const days = ageDays(candidate.verifiedAt ?? localUpdatedAt, nowMs);
  if (days !== undefined) {
    const recency = days <= 1 ? 14 : days <= 7 ? 11 : days <= 30 ? 8 : days <= 180 ? 4 : 0;
    if (recency > 0) {
      score += recency;
      reasons.push(
        days <= 7
          ? "recent:verified-or-updated-within-week"
          : "recent:verified-or-updated-within-month",
      );
    }
  }
  if (local) {
    score += 2;
    reasons.push("trust:local-memory");
  }
  return {
    candidate,
    score,
    reasons,
    ...(local
      ? {
          localMetadata: {
            category: local.category,
            status: "active" as const,
            verification: local.verification,
          },
        }
      : {}),
  };
}

function candidateApplies(candidate: ContextCandidate, input: ContextPlannerInput): boolean {
  const inbox = input.inbox || !input.workspaceId || input.workspaceId === CHATS_WORKSPACE_ID;
  if (candidate.scope.kind === "global") return true;
  return !inbox && candidate.scope.workspaceId === input.workspaceId;
}

function dedupeRanked(
  candidates: ContextCandidate[],
  input: ContextPlannerInput,
  nowMs: number,
): RankedCandidate[] {
  const byId = new Map<string, RankedCandidate>();
  for (const candidate of candidates) {
    if (!candidate.id || !candidateApplies(candidate, input)) continue;
    const scored = scoreCandidate(candidate, input, nowMs);
    const existing = byId.get(candidate.id);
    if (
      !existing ||
      scored.score > existing.score ||
      (scored.score === existing.score && scored.candidate.sourceId < existing.candidate.sourceId)
    ) {
      byId.set(candidate.id, scored);
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      b.score - a.score ||
      a.candidate.id.localeCompare(b.candidate.id) ||
      a.candidate.sourceId.localeCompare(b.candidate.sourceId),
  );
}

function tokenBudgetFor(input: ContextPlannerInput): number {
  const requested = input.tokenBudget;
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_TOKEN_BUDGET;
  return Math.min(MAX_TOKEN_BUDGET, Math.max(0, Math.floor(requested)));
}

/** UTF-8 byte count conservatively upper-bounds ordinary subword token counts. */
function estimateTokens(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function citations(evidence: ProjectMemoryEvidence[]): string {
  const priority = {
    file: 0,
    symbol: 1,
    commit: 2,
    branch: 3,
    task: 4,
    subagent: 5,
    user_message: 6,
    run: 7,
  } as const;
  const references = evidence
    .map((item, index) => {
      let text: string;
      if (item.kind === "external_reference" && item.externalReference) {
        text = `untrusted external reference:${item.externalReference.sourceLabel} ${item.externalReference.url}`;
      } else if (item.path) text = `file:${normalizeRelativePath(item.path)}`;
      else if (item.symbol) text = `symbol:${item.symbol}`;
      else if (item.commitSha) text = `commit:${item.commitSha}`;
      else if (item.branch) text = `branch:${item.branch}`;
      else if (item.taskRef) text = `task:${item.taskRef}`;
      else text = item.kind;
      return {
        text,
        priority: item.kind === "external_reference" ? 8 : priority[item.kind],
        index,
      };
    })
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 3)
    .map((item) => item.text);
  return references.length > 0 ? `; evidence ${references.join(", ")}` : "";
}

function packCandidates(ranked: RankedCandidate[], budget: number): ProjectMemoryDigest {
  let text = "";
  let estimatedTokens = 0;
  const memoryIds: string[] = [];
  for (const { candidate, localMetadata } of ranked) {
    const reference = citations(candidate.evidence);
    const line = localMetadata
      ? `- ${candidate.text.trim()} [category:${localMetadata.category}; status:${localMetadata.status}; verification:${localMetadata.verification}; memory:${candidate.id}${reference}]`
      : `- [${candidate.trust} source:${candidate.sourceId}] ${candidate.text.trim()} [source-id:${candidate.id}${reference}]`;
    const separator = text ? "\n" : "";
    const nextTokens = estimateTokens(`${text}${separator}${line}`);
    if (nextTokens > budget) continue;
    text += `${separator}${line}`;
    estimatedTokens = nextTokens;
    memoryIds.push(candidate.id);
  }
  return { text, memoryIds, estimatedTokens };
}

function canonicalizeOptionalCandidate(
  source: ContextCandidateSource,
  candidate: ContextCandidate,
): ContextCandidate {
  const sourceNamespace =
    source.sourceId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "source";
  return {
    id: `source:${sourceNamespace}:${candidate.id}`,
    sourceId: `optional:${sourceNamespace}`,
    scope: candidate.scope,
    text: candidate.text,
    score: candidate.score,
    trust: candidate.trust === "local-memory" ? "external-reference" : candidate.trust,
    evidence: candidate.evidence,
    ...(candidate.verifiedAt ? { verifiedAt: candidate.verifiedAt } : {}),
  };
}

async function retrieveOptionalSource(
  source: ContextCandidateSource,
  input: ContextPlannerInput,
): Promise<ContextCandidate[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<ContextCandidate[]>((resolve) => {
      timer = setTimeout(() => resolve([]), CONTEXT_PLANNER_OPTIONAL_SOURCE_TIMEOUT_MS);
    });
    const candidates = await Promise.race([source.retrieve(input), timedOut]);
    return candidates
      .slice(0, OPTIONAL_SOURCE_RESULT_LIMIT)
      .map((candidate) => canonicalizeOptionalCandidate(source, candidate));
  } catch {
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function rankedCandidates(
  input: ContextPlannerInput,
  sources: ContextCandidateSource[],
): Promise<RankedCandidate[]> {
  let local: ProjectMemoryRecord[] = [];
  try {
    local = getProjectMemoriesForPlanning({
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      inbox: input.inbox,
      contextPaths: input.contextPaths,
      changedPaths: input.git.changedPaths,
      contextSymbols: input.contextSymbols,
    });
  } catch {
    // SQLite and optional context sources are best-effort; empty memory is safe.
  }
  const optional = await Promise.all(
    sources.map((source) => retrieveOptionalSource(source, input)),
  );
  const localCandidates = local.map(localCandidate);
  const candidates = [...localCandidates, ...optional.flat()];
  return dedupeRanked(candidates, input, Date.now());
}

/** Shadow-only metadata for fixed-corpus relevance tests; never changes digest/prompt shape. */
export async function diagnoseTurnContext(
  input: ContextPlannerInput,
  sources: ContextCandidateSource[] = [],
): Promise<ContextPlanDiagnostics> {
  const ranked = await rankedCandidates(input, sources);
  const digest = packCandidates(ranked, tokenBudgetFor(input));
  return {
    rankedIds: ranked.map(({ candidate }) => candidate.id),
    ranked: ranked.map(({ candidate, score, reasons }) => ({
      id: candidate.id,
      sourceId: candidate.sourceId,
      score,
      reasons,
    })),
    selectedIds: digest.memoryIds,
    estimatedTokens: digest.estimatedTokens,
  };
}

export async function planTurnContext(
  input: ContextPlannerInput,
  sources: ContextCandidateSource[] = [],
): Promise<ProjectMemoryDigest> {
  const ranked = await rankedCandidates(input, sources);
  return packCandidates(ranked, tokenBudgetFor(input));
}
