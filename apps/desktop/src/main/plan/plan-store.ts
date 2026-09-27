/** Session-scoped Plan Mode persistence. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
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
const MAX_STABLE_ID_LENGTH = 128;
const MAX_ACCEPTANCE_CRITERIA = 100;
const MAX_REQUIRED_CHECK_KINDS = 4;
const MAX_CURRENT_RUN_EVIDENCE = MAX_ACCEPTANCE_CRITERIA * MAX_REQUIRED_CHECK_KINDS;
const MAX_SPEC_EVIDENCE_HISTORY = MAX_CURRENT_RUN_EVIDENCE * 2;
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

function readPlanDir(dir: string): PlanRef | undefined {
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

function resolvePlanDir(rootDir: string, id: string): string | undefined {
  const current = planDir(rootDir, id);
  if (existsSync(join(current, META_FILE))) return current;

  // Historical plans used `<workspaceId>/<slug>` and ids shaped as
  // `${workspaceId}:${slug}`. Keep them readable without preserving that layout
  // for new writes.
  const separator = id.indexOf(":");
  if (separator < 0) return undefined;
  const legacy = join(rootDir, sanitizeSegment(id.slice(0, separator)), id.slice(separator + 1));
  return existsSync(join(legacy, META_FILE)) ? legacy : undefined;
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

export function setPlanBuildStatusById(
  rootDir: string,
  id: string,
  buildStatus: PlanBuildStatus,
): PlanRef | undefined {
  const dir = resolvePlanDir(rootDir, id);
  if (!dir) return undefined;
  const plan = readPlanDir(dir);
  if (!plan) return undefined;
  const { content: _content, ...meta } = plan;
  const next: PlanMeta = { ...meta, buildStatus, updatedAt: new Date().toISOString() };
  writeFileSync(join(dir, META_FILE), JSON.stringify(next, null, 2), "utf8");
  return { ...next, content: plan.content };
}

/** Attach current-run QA references and recompute every criterion with required check kinds. */
export function applyPlanAcceptanceEvidenceById(
  rootDir: string,
  id: string,
  evidence: PlanEvidenceRef[],
): PlanRef | undefined {
  const dir = resolvePlanDir(rootDir, id);
  if (!dir) return undefined;
  const plan = readPlanDir(dir);
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
  return readPlanDir(planDir(rootDir, sessionId));
}

export function readPlanById(rootDir: string, id: string): PlanRef | undefined {
  const dir = resolvePlanDir(rootDir, id);
  return dir ? readPlanDir(dir) : undefined;
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
