/** Session-scoped Plan Mode persistence. */

import { createHash, randomUUID } from "node:crypto";
import fs, {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  HyperPlanRevision,
  HyperPlanSourceSnapshot,
  PlanAcceptanceCriterion,
  PlanBlock,
  PlanBuildStatus,
  PlanEvidenceRef,
  PlanRef,
  PlanSpec,
  PlanTodo,
} from "../../shared/contracts";

const PLAN_FILE = "plan.md";
const META_FILE = "plan.json";
const TRANSACTION_FILE = ".plan-transaction.json";
const REVISION_IN_DOUBT_FILE = "hyperplan-revision-in-doubt";
const MAX_STABLE_ID_LENGTH = 128;
const MAX_ACCEPTANCE_CRITERIA = 100;
const MAX_REQUIRED_CHECK_KINDS = 4;
const MAX_CURRENT_RUN_EVIDENCE = MAX_ACCEPTANCE_CRITERIA * MAX_REQUIRED_CHECK_KINDS;
const MAX_SPEC_EVIDENCE_HISTORY = MAX_CURRENT_RUN_EVIDENCE * 2;
const revisionInDoubtDirs = new Set<string>();
const REQUIRED_CHECK_KINDS = new Set(["tests", "typecheck", "lint", "build"]);
const CHECK_LABELS: Record<"tests" | "typecheck" | "lint" | "build", string> = {
  tests: "Tests",
  typecheck: "Typecheck",
  lint: "Lint",
  build: "Build",
};

type PlanTodoInput = {
  id?: string;
  content: string;
  acceptanceCriterionIds?: string[];
};

export type PlanSpecWriteInput = Omit<PlanSpec, "evidence">;

export function isPlanCriterionLinkedToTodos(
  criterion: Pick<PlanAcceptanceCriterion, "id" | "todoIds">,
  todos: ReadonlyArray<Pick<PlanTodo, "id" | "acceptanceCriterionIds">>,
): boolean {
  const todoIds = new Set(todos.map((todo) => todo.id));
  return (
    criterion.todoIds.some((todoId) => todoIds.has(todoId)) ||
    todos.some((todo) => todo.acceptanceCriterionIds?.includes(criterion.id))
  );
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/** One temporary plan per session; rewrites update this directory in place. */
export function planDir(rootDir: string, sessionId: string): string {
  return join(rootDir, sanitizeSegment(sessionId));
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

type PlanMeta = Omit<PlanRef, "content">;

type PlanTransaction = {
  state: "prepared" | "committed";
  backupMarkdown: string;
  backupMeta: string;
  stagedMarkdown: string;
  stagedMeta: string;
};

function transactionNames(suffix: string): PlanTransaction {
  return {
    state: "prepared",
    backupMarkdown: `.plan.md.${suffix}.backup`,
    backupMeta: `.plan.json.${suffix}.backup`,
    stagedMarkdown: `.plan.md.${suffix}.stage`,
    stagedMeta: `.plan.json.${suffix}.stage`,
  };
}

function assertRegularOrMissing(path: string, optional = false): void {
  try {
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Unsafe plan transaction path (symlink or non-file): ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) return;
    throw error;
  }
}

function validateTransaction(value: unknown): PlanTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid plan transaction marker; recovery was not attempted.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "backupMarkdown,backupMeta,stagedMarkdown,stagedMeta,state") {
    throw new Error("Invalid plan transaction marker; recovery was not attempted.");
  }
  if (record.state !== "prepared" && record.state !== "committed") {
    throw new Error("Invalid plan transaction state; recovery was not attempted.");
  }
  const names = [
    record.backupMarkdown,
    record.backupMeta,
    record.stagedMarkdown,
    record.stagedMeta,
  ];
  const suffixes = names.map((name) =>
    typeof name === "string"
      ? name.match(
          /^\.plan\.(?:md|json)\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(?:backup|stage)$/,
        )?.[1]
      : undefined,
  );
  if (
    suffixes.some((suffix) => !suffix) ||
    new Set(suffixes).size !== 1 ||
    record.backupMarkdown !== `.plan.md.${suffixes[0]}.backup` ||
    record.backupMeta !== `.plan.json.${suffixes[0]}.backup` ||
    record.stagedMarkdown !== `.plan.md.${suffixes[0]}.stage` ||
    record.stagedMeta !== `.plan.json.${suffixes[0]}.stage`
  ) {
    throw new Error("Invalid plan transaction artifact names; recovery was not attempted.");
  }
  return record as PlanTransaction;
}

function atomicWriteMarker(dir: string, transaction: PlanTransaction, suffix: string): void {
  const markerPath = join(dir, TRANSACTION_FILE);
  const temporaryMarker = join(dir, `.plan-transaction.${suffix}.tmp`);
  assertRegularOrMissing(markerPath, true);
  assertRegularOrMissing(temporaryMarker, true);
  writeFileSync(temporaryMarker, JSON.stringify(transaction), { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporaryMarker, markerPath);
}

function removeRegularFile(path: string): void {
  assertRegularOrMissing(path, true);
  if (existsSync(path)) fs.unlinkSync(path);
}

function cleanupTransaction(dir: string, transaction: PlanTransaction, suffix: string): void {
  // The marker is the sole instruction to recovery. Remove it atomically before deleting
  // any backup that a prepared transaction might still need.
  removeRegularFile(join(dir, TRANSACTION_FILE));
  for (const name of [
    transaction.backupMarkdown,
    transaction.backupMeta,
    transaction.stagedMarkdown,
    transaction.stagedMeta,
    `.plan.md.${suffix}.restore`,
    `.plan.json.${suffix}.restore`,
    `.plan-transaction.${suffix}.tmp`,
  ]) {
    removeRegularFile(join(dir, name));
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprint every authoritative source field, independent of object key order. */
export function fingerprintPlanSource(
  plan:
    | Pick<PlanRef, "title" | "overview" | "content" | "todos" | "spec">
    | HyperPlanSourceSnapshot,
): string {
  const source = {
    title: plan.title,
    overview: plan.overview,
    content: plan.content,
    todos: plan.todos.map((todo) => ({
      id: todo.id,
      content: todo.content,
      acceptanceCriterionIds: todo.acceptanceCriterionIds ?? [],
    })),
    spec: plan.spec
      ? {
          requirements: plan.spec.requirements,
          acceptanceCriteria: plan.spec.acceptanceCriteria,
          assumptions: plan.spec.assumptions,
          openQuestions: plan.spec.openQuestions,
          evidence: plan.spec.evidence ?? [],
        }
      : null,
  };
  return createHash("sha256").update(stableSerialize(source), "utf8").digest("hex");
}

function assertRecoveryDirectoryWithinRoot(rootDir: string, dir: string): boolean {
  const rootPath = resolve(rootDir);
  const targetPath = resolve(dir);
  const lexicalRelative = relative(rootPath, targetPath);
  if (
    !lexicalRelative ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new Error("Unsafe plan recovery directory; target must be below its root.");
  }

  let cursor = rootPath;
  try {
    for (const component of lexicalRelative.split(sep)) {
      cursor = join(cursor, component);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`Unsafe plan recovery directory (symlink): ${cursor}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Unsafe plan recovery directory (not a directory): ${cursor}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  const canonicalRoot = fs.realpathSync(rootDir);
  const canonicalTarget = fs.realpathSync(dir);
  const canonicalRelative = relative(canonicalRoot, canonicalTarget);
  if (
    !canonicalRelative ||
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelative)
  ) {
    throw new Error("Unsafe plan recovery directory; canonical target is outside its root.");
  }
  return true;
}

function recoverPlanTransaction(dir: string, rootDir: string): void {
  if (!assertRecoveryDirectoryWithinRoot(rootDir, dir)) return;
  const markerPath = join(dir, TRANSACTION_FILE);
  if (!existsSync(markerPath)) return;
  assertRegularOrMissing(markerPath);
  let transaction: PlanTransaction;
  try {
    transaction = validateTransaction(JSON.parse(readFileSync(markerPath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Malformed plan transaction marker; files were left untouched.", {
        cause: error,
      });
    }
    throw error;
  }
  const suffix = transaction.backupMarkdown.match(/^\.plan\.md\.([0-9a-f-]+)\.backup$/)?.[1];
  if (!suffix)
    throw new Error("Invalid plan transaction artifact suffix; recovery was not attempted.");
  const markdownPath = join(dir, PLAN_FILE);
  const metaPath = join(dir, META_FILE);
  const backupMarkdown = join(dir, transaction.backupMarkdown);
  const backupMeta = join(dir, transaction.backupMeta);
  const stageMarkdown = join(dir, transaction.stagedMarkdown);
  const stageMeta = join(dir, transaction.stagedMeta);
  for (const path of [markdownPath, metaPath]) {
    assertRegularOrMissing(path);
  }
  assertRegularOrMissing(backupMarkdown, transaction.state === "committed");
  assertRegularOrMissing(backupMeta, transaction.state === "committed");
  assertRegularOrMissing(stageMarkdown, true);
  assertRegularOrMissing(stageMeta, true);
  if (transaction.state === "prepared") {
    const restoreMarkdown = join(dir, `.plan.md.${suffix}.restore`);
    const restoreMeta = join(dir, `.plan.json.${suffix}.restore`);
    assertRegularOrMissing(restoreMarkdown, true);
    assertRegularOrMissing(restoreMeta, true);
    fs.rmSync(restoreMarkdown, { force: true });
    fs.rmSync(restoreMeta, { force: true });
    copyFileSync(backupMarkdown, restoreMarkdown, fs.constants.COPYFILE_EXCL);
    copyFileSync(backupMeta, restoreMeta, fs.constants.COPYFILE_EXCL);
    fs.renameSync(restoreMarkdown, markdownPath);
    fs.renameSync(restoreMeta, metaPath);
  }
  cleanupTransaction(dir, transaction, suffix);
}

/** Historical plan.json may still store visual blocks; project them to Markdown. */
type LegacyPlanBlock =
  | PlanBlock
  | {
      type: "visual";
      title?: string;
      kind?: string;
      content?: string;
      fallback?: string;
    };

function buildTodos(items: ReadonlyArray<PlanTodoInput>): PlanTodo[] {
  return items.map((item, index) => ({
    id: item.id ?? hashContent(`${index}:${item.content}`),
    content: item.content,
    ...(item.acceptanceCriterionIds
      ? { acceptanceCriterionIds: [...item.acceptanceCriterionIds] }
      : {}),
    status: "pending",
  }));
}

function assertStableIds(label: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.trim().length === 0 || id.length > MAX_STABLE_ID_LENGTH) {
      throw new Error(
        `${label} IDs must be nonempty strings of at most ${MAX_STABLE_ID_LENGTH} characters.`,
      );
    }
    if (seen.has(id)) throw new Error(`${label} IDs must be unique.`);
    seen.add(id);
  }
}

function validateSpec(spec: PlanSpec, todos: PlanTodo[]): void {
  if (spec.acceptanceCriteria.length > MAX_ACCEPTANCE_CRITERIA) {
    throw new Error(`A Spec may contain at most ${MAX_ACCEPTANCE_CRITERIA} acceptance criteria.`);
  }
  const requirementIds = spec.requirements.map((requirement) => requirement.id);
  const criterionIds = spec.acceptanceCriteria.map((criterion) => criterion.id);
  const evidenceIds = spec.evidence.map((evidence) => evidence.id);
  const todoIds = todos.map((todo) => todo.id);
  assertStableIds("Requirement", requirementIds);
  assertStableIds("Acceptance criterion", criterionIds);
  assertStableIds("Evidence", evidenceIds);

  const requirementSet = new Set(requirementIds);
  const criterionSet = new Set(criterionIds);
  const todoSet = new Set(todoIds);
  for (const criterion of spec.acceptanceCriteria) {
    if (!requirementSet.has(criterion.requirementId)) {
      throw new Error(`Acceptance criterion ${criterion.id} references an unknown requirement.`);
    }
    if (criterion.status !== "pending") {
      throw new Error("New acceptance criteria must have pending status.");
    }
    assertStableIds(`Todo link for acceptance criterion ${criterion.id}`, criterion.todoIds);
    if (criterion.todoIds.some((id) => !todoSet.has(id))) {
      throw new Error(`Acceptance criterion ${criterion.id} references an unknown todo.`);
    }
    if (criterion.requiredCheckKinds?.some((kind) => !REQUIRED_CHECK_KINDS.has(kind))) {
      throw new Error(
        `Acceptance criterion ${criterion.id} has an unsupported required check kind.`,
      );
    }
    if (
      criterion.requiredCheckKinds &&
      (criterion.requiredCheckKinds.length > MAX_REQUIRED_CHECK_KINDS ||
        new Set(criterion.requiredCheckKinds).size !== criterion.requiredCheckKinds.length)
    ) {
      throw new Error(
        `Acceptance criterion ${criterion.id} must have at most ${MAX_REQUIRED_CHECK_KINDS} unique required check kinds.`,
      );
    }
  }
  for (const todo of todos) {
    const links = todo.acceptanceCriterionIds ?? [];
    assertStableIds(`Acceptance criterion link for todo ${todo.id}`, links);
    if (links.some((id) => !criterionSet.has(id))) {
      throw new Error(`Todo ${todo.id} references an unknown acceptance criterion.`);
    }
  }
  for (const evidence of spec.evidence) {
    if (!criterionSet.has(evidence.criterionId)) {
      throw new Error(`Evidence ${evidence.id} references an unknown acceptance criterion.`);
    }
  }
}

function blockToMarkdown(block: LegacyPlanBlock): string {
  if (block.type === "markdown") return block.content.trim();
  const title = typeof block.title === "string" ? block.title.trim() : "";
  const fallback = typeof block.fallback === "string" ? block.fallback.trim() : "";
  return [title ? `### ${title}` : "", fallback].filter(Boolean).join("\n\n");
}

/** Coerce stored blocks (including legacy visual) into markdown-only PlanBlocks. */
function normalizeBlocks(
  rawBlocks: readonly LegacyPlanBlock[] | undefined,
  content: string,
): PlanBlock[] {
  if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) {
    return [{ type: "markdown", content }];
  }
  return rawBlocks.map((block) =>
    block.type === "markdown"
      ? block
      : { type: "markdown" as const, content: blockToMarkdown(block) },
  );
}

function readMeta(dir: string): Partial<PlanMeta> | undefined {
  const metaPath = join(dir, META_FILE);
  if (!existsSync(metaPath)) return undefined;
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as Partial<PlanMeta>;
  } catch {
    return undefined;
  }
}

function readPlanDir(dir: string, rootDir: string): PlanRef | undefined {
  recoverPlanTransaction(dir, rootDir);
  const raw = readMeta(dir);
  const path = typeof raw?.path === "string" ? raw.path : join(dir, PLAN_FILE);
  if (!raw || !existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8");
  const blocks = normalizeBlocks(raw.blocks as LegacyPlanBlock[] | undefined, content);
  return {
    id: raw.id ?? raw.sessionId ?? "legacy-plan",
    title: raw.title ?? "Plan",
    overview: raw.overview ?? "",
    path,
    hash: raw.hash ?? hashContent(content),
    workspaceId: raw.workspaceId ?? "",
    sessionId: raw.sessionId ?? raw.id ?? "legacy-plan",
    blocks,
    content,
    todos: raw.todos ?? [],
    ...(raw.spec ? { spec: raw.spec } : {}),
    buildStatus: raw.buildStatus ?? "not_built",
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
  };
}

/** Read the source fingerprint without invoking recovery; used at the synchronous publish boundary. */
function fingerprintPlanFiles(dir: string): string | undefined {
  const raw = readMeta(dir);
  if (!raw) return undefined;
  const path = typeof raw.path === "string" ? raw.path : join(dir, PLAN_FILE);
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8");
  return fingerprintPlanSource({
    title: raw.title ?? "Plan",
    overview: raw.overview ?? "",
    content,
    todos: raw.todos ?? [],
    ...(raw.spec ? { spec: raw.spec } : {}),
  });
}

function resolvePlanDir(rootDir: string, id: string): string | undefined {
  const current = planDir(rootDir, id);
  if (assertRecoveryDirectoryWithinRoot(rootDir, current) && existsSync(join(current, META_FILE))) {
    return current;
  }

  // Historical plans used `<workspaceId>/<slug>` and ids shaped as
  // `${workspaceId}:${slug}`. Keep them readable without preserving that layout
  // for new writes.
  const separator = id.indexOf(":");
  if (separator < 0) return undefined;
  const legacy = join(rootDir, sanitizeSegment(id.slice(0, separator)), id.slice(separator + 1));
  return assertRecoveryDirectoryWithinRoot(rootDir, legacy) && existsSync(join(legacy, META_FILE))
    ? legacy
    : undefined;
}

export function writePlan(
  rootDir: string,
  input: {
    workspaceId: string;
    sessionId: string;
    title: string;
    overview: string;
    content: string;
    todos: ReadonlyArray<PlanTodoInput>;
    spec?: PlanSpecWriteInput;
  },
): PlanRef {
  const dir = planDir(rootDir, input.sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, PLAN_FILE);
  const content = input.content.trim();
  const blocks: PlanBlock[] = [{ type: "markdown", content }];
  const todos = buildTodos(input.todos);
  assertStableIds(
    "Todo",
    todos.map((todo) => todo.id),
  );
  const spec: PlanSpec | undefined = input.spec ? { ...input.spec, evidence: [] } : undefined;
  if (spec) validateSpec(spec, todos);
  else if (todos.some((todo) => todo.acceptanceCriterionIds?.length)) {
    throw new Error("Todo acceptance-criterion links require Spec Mode metadata.");
  }
  writeFileSync(path, content, "utf8");

  const now = new Date().toISOString();
  const existing = readMeta(dir);
  const meta: PlanMeta = {
    id: input.sessionId,
    title: input.title,
    overview: input.overview,
    path,
    hash: hashContent(content),
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    blocks,
    todos,
    ...(spec ? { spec } : {}),
    buildStatus: "not_built",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeFileSync(join(dir, META_FILE), JSON.stringify(meta, null, 2), "utf8");
  return { ...meta, content };
}

/**
 * Atomically promote a validated HyperPlan revision, rolling back interrupted writes on read.
 * Revalidation assumes synchronous, single-process writers; it detects in-operation changes but
 * does not provide locking or protection against concurrent external-process writers.
 */
export function promotePlanRevision(
  rootDir: string,
  input: { planId: string; expectedFingerprint: string; revision: HyperPlanRevision },
): PlanRef {
  const current = readPlanById(rootDir, input.planId);
  if (!current) throw new Error(`Plan ${input.planId} was not found.`);
  if (fingerprintPlanSource(current) !== input.expectedFingerprint) {
    throw new Error("Plan source changed since the revision was generated.");
  }
  const dir = resolvePlanDir(rootDir, input.planId);
  if (!dir) throw new Error(`Plan ${input.planId} was not found.`);

  const content = input.revision.content.trim();
  const todos = buildTodos(input.revision.todos);
  assertStableIds(
    "Todo",
    todos.map((todo) => todo.id),
  );
  const spec: PlanSpec = {
    ...input.revision.spec,
    acceptanceCriteria: input.revision.spec.acceptanceCriteria.map((criterion) => ({
      ...criterion,
      status: "pending",
    })),
    evidence: [],
  };
  validateSpec(spec, todos);

  const path = join(dir, PLAN_FILE);
  const now = new Date().toISOString();
  const meta: PlanMeta = {
    id: current.id,
    title: input.revision.title,
    overview: input.revision.overview,
    path,
    hash: hashContent(content),
    workspaceId: current.workspaceId,
    sessionId: current.sessionId,
    blocks: [{ type: "markdown", content }],
    todos,
    spec,
    buildStatus: "not_built",
    createdAt: current.createdAt,
    updatedAt: now,
  };
  const suffix = randomUUID();
  const transaction = transactionNames(suffix);
  const metaPath = join(dir, META_FILE);
  let markerWritten = false;
  let publicationStarted = false;
  try {
    for (const target of [path, metaPath]) assertRegularOrMissing(target);
    for (const artifact of [
      transaction.backupMarkdown,
      transaction.backupMeta,
      transaction.stagedMarkdown,
      transaction.stagedMeta,
    ]) {
      assertRegularOrMissing(join(dir, artifact), true);
    }
    copyFileSync(path, join(dir, transaction.backupMarkdown), fs.constants.COPYFILE_EXCL);
    copyFileSync(metaPath, join(dir, transaction.backupMeta), fs.constants.COPYFILE_EXCL);
    writeFileSync(join(dir, transaction.stagedMarkdown), content, { encoding: "utf8", flag: "wx" });
    writeFileSync(join(dir, transaction.stagedMeta), JSON.stringify(meta, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    atomicWriteMarker(dir, transaction, suffix);
    markerWritten = true;

    // Writers in this process are synchronous; re-read authoritative bytes immediately before
    // publication so an in-operation source change is rejected. This is not cross-process locking.
    if (fingerprintPlanFiles(dir) !== input.expectedFingerprint) {
      throw new Error("Plan source changed since the revision was generated.");
    }

    publicationStarted = true;
    fs.renameSync(join(dir, transaction.stagedMarkdown), path);
    fs.renameSync(join(dir, transaction.stagedMeta), metaPath);
    atomicWriteMarker(dir, { ...transaction, state: "committed" }, suffix);
    // Commit point is the atomic prepared->committed marker rename. Cleanup is recoverable and
    // must not turn a committed promotion into an ambiguous reported failure.
    try {
      cleanupTransaction(dir, { ...transaction, state: "committed" }, suffix);
    } catch {
      // The committed marker remains whenever cleanup is incomplete; reads finish cleanup.
    }
  } catch (error) {
    let rollbackError: unknown;
    try {
      if (publicationStarted) {
        assertRegularOrMissing(join(dir, transaction.backupMarkdown));
        assertRegularOrMissing(join(dir, transaction.backupMeta));
        assertRegularOrMissing(path);
        assertRegularOrMissing(metaPath);
        copyFileSync(join(dir, transaction.backupMarkdown), path);
        copyFileSync(join(dir, transaction.backupMeta), metaPath);
      }
      if (markerWritten) cleanupTransaction(dir, transaction, suffix);
      else {
        for (const artifact of [
          transaction.backupMarkdown,
          transaction.backupMeta,
          transaction.stagedMarkdown,
          transaction.stagedMeta,
        ]) {
          const artifactPath = join(dir, artifact);
          assertRegularOrMissing(artifactPath, true);
          fs.rmSync(artifactPath, { force: true });
        }
      }
    } catch (failure) {
      rollbackError = failure;
    }
    if (rollbackError) {
      throw new Error(
        "Plan revision failed and rollback could not be completed; recovery artifacts were preserved.",
        {
          cause: rollbackError,
        },
      );
    }
    throw error;
  }
  return { ...meta, content };
}

export function setPlanBuildStatusById(
  rootDir: string,
  id: string,
  buildStatus: PlanBuildStatus,
): PlanRef | undefined {
  const dir = resolvePlanDir(rootDir, id);
  if (!dir) return undefined;
  const plan = readPlanDir(dir, rootDir);
  if (!plan) return undefined;
  const { content: _content, ...meta } = plan;
  const next: PlanMeta = { ...meta, buildStatus, updatedAt: new Date().toISOString() };
  writeFileSync(join(dir, META_FILE), JSON.stringify(next, null, 2), "utf8");
  return { ...next, content: plan.content };
}

/** Replace only the Markdown body of the plan identified by its current content hash. */
export function updatePlanContentById(
  rootDir: string,
  id: string,
  expectedHash: string,
  content: string,
  afterPersist?: (updated: PlanRef) => void,
): PlanRef | undefined {
  const dir = resolvePlanDir(rootDir, id);
  if (!dir) return undefined;
  if (revisionInDoubtDirs.has(dir) || existsSync(join(dir, REVISION_IN_DOUBT_FILE))) {
    throw new Error(
      "Plan revision state is indeterminate; manual repair is required before updating.",
    );
  }
  const plan = readPlanDir(dir, rootDir);
  if (!plan) return undefined;
  if (plan.hash !== expectedHash || hashContent(plan.content) !== expectedHash) {
    throw new Error("Plan changed since review; reload it before applying this revision.");
  }

  const revisedContent = content.trim();
  if (!revisedContent) throw new Error("Revised plan content cannot be empty.");
  const blocks: PlanBlock[] = [{ type: "markdown", content: revisedContent }];
  const { content: _content, ...meta } = plan;
  const next: PlanMeta = {
    ...readMeta(dir),
    ...meta,
    hash: hashContent(revisedContent),
    blocks,
    updatedAt: new Date().toISOString(),
  };
  const metaPath = join(dir, META_FILE);
  const oldBody = readFileSync(plan.path);
  const oldMeta = readFileSync(metaPath);
  const updated = { ...next, content: revisedContent };
  try {
    replaceFileContents(plan.path, Buffer.from(revisedContent, "utf8"));
    replaceFileContents(metaPath, Buffer.from(JSON.stringify(next, null, 2), "utf8"));
    afterPersist?.(updated);
    return updated;
  } catch (cause) {
    let restorationFailure: unknown;
    try {
      replaceFileContents(plan.path, oldBody);
    } catch (error) {
      restorationFailure = error;
    }
    try {
      replaceFileContents(metaPath, oldMeta);
    } catch (error) {
      restorationFailure ??= error;
    }
    if (restorationFailure) {
      revisionInDoubtDirs.add(dir);
      try {
        writeFileSync(
          join(dir, REVISION_IN_DOUBT_FILE),
          `Manual repair required. Update failure: ${String(cause)}. Restoration failure: ${String(restorationFailure)}\n`,
          "utf8",
        );
        revisionInDoubtDirs.delete(dir);
      } catch (markerFailure) {
        throw new Error(
          `Plan revision state is indeterminate; restoration and marker creation failed: ${String(markerFailure)}`,
          { cause },
        );
      }
      throw new Error(
        `Plan revision state is indeterminate; manual repair is required. ${String(restorationFailure)}`,
        { cause },
      );
    }
    throw cause;
  }
}

function replaceFileContents(path: string, content: Buffer): void {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temporaryPath, content);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/** Attach current-run QA references and recompute every criterion with required check kinds. */
export function applyPlanAcceptanceEvidenceById(
  rootDir: string,
  id: string,
  evidence: PlanEvidenceRef[],
): PlanRef | undefined {
  const dir = resolvePlanDir(rootDir, id);
  if (!dir) return undefined;
  const plan = readPlanDir(dir, rootDir);
  if (!plan?.spec) return plan;
  if (evidence.length > MAX_CURRENT_RUN_EVIDENCE) {
    throw new Error(
      `A Build QA update may contain at most ${MAX_CURRENT_RUN_EVIDENCE} references.`,
    );
  }

  const eligible = new Map(
    plan.spec.acceptanceCriteria
      .filter(
        (criterion) =>
          isPlanCriterionLinkedToTodos(criterion, plan.todos) &&
          criterion.requiredCheckKinds?.length,
      )
      .map((criterion) => [criterion.id, criterion]),
  );
  const criterionIds = new Set(plan.spec.acceptanceCriteria.map((criterion) => criterion.id));
  const existingIds = new Set(plan.spec.evidence.map((reference) => reference.id));
  const incomingIds = new Set<string>();
  for (const reference of evidence) {
    if (!criterionIds.has(reference.criterionId)) {
      throw new Error(`Evidence ${reference.id} references an unknown acceptance criterion.`);
    }
    assertStableIds("Plan QA evidence", [reference.id]);
    if (existingIds.has(reference.id) || incomingIds.has(reference.id)) {
      throw new Error("Plan QA evidence IDs must be unique.");
    }
    incomingIds.add(reference.id);
  }

  const nextEvidence = evidence.filter((reference) => eligible.has(reference.criterionId));
  const nextCriteria = plan.spec.acceptanceCriteria.map((criterion) => {
    const requiredKinds = criterion.requiredCheckKinds ?? [];
    if (!eligible.has(criterion.id) || requiredKinds.length === 0) return criterion;
    const references = nextEvidence.filter((reference) => reference.criterionId === criterion.id);
    const statuses = requiredKinds.map((kind) => {
      const expectedLabel = CHECK_LABELS[kind];
      return (
        [...references].reverse().find((reference) => reference.label === expectedLabel)?.status ??
        "missing"
      );
    });
    const status: PlanAcceptanceCriterion["status"] = statuses.every((item) => item === "passed")
      ? "passed"
      : statuses.includes("failed")
        ? "failed"
        : statuses.some(
              (item) => item === "missing" || item === "unavailable" || item === "user_confirmed",
            )
          ? "blocked"
          : statuses.includes("skipped")
            ? "skipped"
            : "blocked";
    return { ...criterion, status };
  });
  const spec: PlanSpec = {
    ...plan.spec,
    acceptanceCriteria: nextCriteria,
    evidence: [...plan.spec.evidence, ...nextEvidence].slice(-MAX_SPEC_EVIDENCE_HISTORY),
  };
  const { content: _content, ...meta } = plan;
  const next: PlanMeta = { ...meta, spec, updatedAt: new Date().toISOString() };
  writeFileSync(join(dir, META_FILE), JSON.stringify(next, null, 2), "utf8");
  return { ...next, content: plan.content };
}

export function readPlan(rootDir: string, sessionId: string): PlanRef | undefined {
  return readPlanDir(planDir(rootDir, sessionId), rootDir);
}

export function readPlanById(rootDir: string, id: string): PlanRef | undefined {
  const dir = resolvePlanDir(rootDir, id);
  return dir ? readPlanDir(dir, rootDir) : undefined;
}

export function deleteSessionPlan(rootDir: string, sessionId: string): void {
  rmSync(planDir(rootDir, sessionId), { recursive: true, force: true });
  if (!existsSync(rootDir)) return;
  for (const owner of readdirSync(rootDir, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    const ownerDir = join(rootDir, owner.name);
    for (const entry of readdirSync(ownerDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const legacyDir = join(ownerDir, entry.name);
      if (readMeta(legacyDir)?.sessionId === sessionId) {
        rmSync(legacyDir, { recursive: true, force: true });
      }
    }
  }
}
