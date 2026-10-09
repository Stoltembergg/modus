import type { HarnessEvidenceRef } from "./contracts-part-01";
import type {
  JsonObject,
  ModelCompatibilityInput,
  ModelCost,
  ModelInputKind,
  ThinkingLevel,
} from "./contracts-part-05";

export type CustomProviderModelConfig = {
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  reasoning: boolean;
  input: ModelInputKind[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
  compat?: JsonObject;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

export type CustomProviderConfig = {
  provider: string;
  name: string;
  baseUrl: string;
  api: string;
  authHeader: boolean;
  headers?: Record<string, string>;
  compat?: JsonObject;
  models: CustomProviderModelConfig[];
};

export type UpdateModelConfigInput = {
  model: string;
  enabled?: boolean | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  thinkingVariant?: string | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
};

/**
 * One-shot connectivity probe for the custom provider form: sends a tiny
 * prompt straight through the same pi-ai driver the chat would use, so it
 * validates endpoint + key + protocol + (optionally) the thinking setup
 * before anything is saved.
 */
export type TestCustomProviderInput = {
  /** Existing provider id — lets an edit session reuse the stored API key. */
  provider?: string | undefined;
  baseUrl: string;
  api?: string | undefined;
  /** Blank while editing keeps the stored credential. */
  apiKey?: string | undefined;
  authHeader?: boolean | undefined;
  headers?: Record<string, string> | undefined;
  model: {
    id: string;
    api?: string | undefined;
    baseUrl?: string | undefined;
    headers?: Record<string, string> | undefined;
    reasoning?: boolean | undefined;
    contextWindow?: number | undefined;
    maxTokens?: number | undefined;
    compat?: JsonObject | undefined;
    compatibility?: ModelCompatibilityInput | undefined;
    thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> | undefined;
  };
};

export type TestCustomProviderResult = {
  ok: boolean;
  /** Round-trip time of the probe request. */
  latencyMs: number;
  /** Reply snippet on success; the provider/transport error on failure. */
  message: string;
  /** True when the probe saw thinking deltas (reasoning models only). */
  sawThinking: boolean;
};

/* ── MCP (Model Context Protocol) ──────────────────────────────────────── */

export type McpTransportKind = "stdio" | "http";

export type McpServerStatus = "connecting" | "connected" | "failed" | "disabled";

export type McpToolInfo = {
  /** Tool name as exposed by the server. */
  name: string;
  /** Namespaced name the agent calls (mcp_<server>_<tool>). */
  registeredName: string;
  description?: string | undefined;
};

export type McpServerInfo = {
  name: string;
  transport: McpTransportKind;
  /** Config file this server came from (project beats user on conflicts). */
  source: string;
  status: McpServerStatus;
  error?: string | undefined;
  tools: McpToolInfo[];
};

/** Settings-form payload for creating/updating a server entry. */
export type McpServerUpsertInput = {
  name: string;
  /** Existing name when editing (handles renames). */
  originalName?: string | undefined;
  /** New servers land in the selected config scope; existing servers write back to source. */
  scope?: "user" | "project" | undefined;
  transport: McpTransportKind;
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  url?: string | undefined;
  headers?: Record<string, string> | undefined;
  /** Exact MCP tool names explicitly allowlisted as read-only by the user. */
  readOnlyToolAllowlist?: string[] | undefined;
  enabled: boolean;
};

/** Raw (un-interpolated) mcp.json entry + the file it lives in. */
export type RawMcpEntry = {
  source: string;
  entry: Record<string, unknown>;
};

export type AgentReviewDepth = "fast" | "standard" | "deep";

export type AgentReviewIssue = {
  id: string;
  severity: "low" | "medium" | "high";
  title: string;
  file?: string;
  line?: number;
  detail: string;
};

export type AgentReviewResult = {
  id: string;
  sessionId?: string;
  workspaceId?: string;
  cwd: string;
  depth: AgentReviewDepth;
  status: "completed" | "failed";
  summary: string;
  issues: AgentReviewIssue[];
  createdAt: string;
};

/* ── Workspace files (file panel) ──────────────────────────────────────── */

/** One entry in a directory listing for the file panel's lazy tree. */
export type FileEntry = {
  name: string;
  /** Absolute path. */
  path: string;
  /** Workspace-root-relative path with forward slashes (stable id + label). */
  relativePath: string;
  kind: "file" | "directory";
};

/** Result of reading a workspace file for preview / edit. */
export type FileReadResult = {
  path: string;
  relativePath: string;
  size: number;
  /** True when the file is binary (no text preview); `content` is empty. */
  binary: boolean;
  /** True when the file exceeded the read cap and `content` is a prefix. */
  truncated: boolean;
  content: string;
};

/**
 * Structured preview capability from authoritative byte inspection (magic /
 * OOXML part peek). UI routes on this enum — never on filename extensions.
 */
export type PreviewKind = "pdf" | "docx" | "xlsx" | "pptx" | "image" | "unsupported";

/** Result of reading workspace file bytes for in-app document/image preview. */
export type PreviewReadResult = {
  path: string;
  relativePath: string;
  size: number;
  previewKind: PreviewKind;
  mime: string;
  /** Raw file bytes (structured-cloneable over IPC). */
  bytes: Uint8Array;
};

/** Result of writing a workspace text file from the file panel editor. */
export type FileWriteResult = {
  path: string;
  relativePath: string;
  size: number;
};

/**
 * Broadcast when a watched workspace changes on disk (agent / terminal /
 * external editor). Drives live refresh of the Files panel. `paths` are
 * absolute; an empty array means the burst had no filenames (full refresh).
 * Conflict policy: disk / AI wins over unsaved local drafts.
 */
export type FilesChangeEvent = {
  cwd: string;
  paths: string[];
  /** Present and false when the workspace watcher can no longer observe changes. */
  watching?: boolean;
};

/* ── Plan Mode ─────────────────────────────────────────────────────────── */

/**
 * A Plan Mode review artifact. It is scoped to one session, survives an app
 * restart, and is deleted with that session.
 */
/**
 * A single plan task. Authored by the planner via `plan_write` (structured, not
 * parsed from markdown), so it is the authoritative source for execution's
 * ordered steps. `status` is `pending` until the
 * v2 runtime binds live `todo_write` progress; v1 never fakes completion.
 */
export type PlanTodo = {
  id: string;
  content: string;
  status: "pending" | "completed";
  acceptanceCriterionIds?: string[];
};

export type PlanRequirement = { id: string; text: string };

export type PlanAcceptanceCriterion = {
  id: string;
  requirementId: string;
  description: string;
  todoIds: string[];
  requiredCheckKinds?: Array<"tests" | "typecheck" | "lint" | "build">;
  status: "pending" | "passed" | "failed" | "skipped" | "blocked";
};

export type PlanEvidenceRef = Omit<HarnessEvidenceRef, "id"> & { id: string; criterionId: string };

export type PlanSpec = {
  requirements: PlanRequirement[];
  acceptanceCriteria: PlanAcceptanceCriterion[];
  evidence: PlanEvidenceRef[];
  assumptions: string[];
  openQuestions: string[];
};

export type HyperPlanCriticId = "architecture" | "risk" | "simplicity" | "failure";

export type HyperPlanCriticResult = {
  critic: HyperPlanCriticId;
  status: "completed" | "unavailable";
  findings: string[];
  references: string[];
};

export type HyperPlanSummary = {
  critiques: HyperPlanCriticResult[];
  revisedContent: string;
  agreements: string[];
  disagreements: string[];
  risks: string[];
  openQuestions: string[];
  references: string[];
};

/** A validated, non-persisted full-plan proposal produced by HyperPlan. */
export type HyperPlanRevision = {
  title: string;
  overview: string;
  content: string;
  todos: Array<Pick<PlanTodo, "id" | "content" | "acceptanceCriterionIds">>;
  spec: {
    requirements: PlanRequirement[];
    acceptanceCriteria: Array<Omit<PlanAcceptanceCriterion, "status">>;
    assumptions: string[];
    openQuestions: string[];
  };
};

/** Complete plan source supplied to the isolated review/revision harness. */
export type HyperPlanReviewInput = Pick<PlanRef, "title" | "overview" | "content" | "todos"> & {
  spec: PlanSpec;
};

/** Exact source projection captured by the renderer before starting a fallback build. */
export type HyperPlanSourceSnapshot = Pick<PlanRef, "title" | "overview" | "content"> & {
  todos: Array<Pick<PlanTodo, "id" | "content" | "acceptanceCriterionIds">>;
  spec: Pick<
    PlanSpec,
    "requirements" | "acceptanceCriteria" | "assumptions" | "openQuestions" | "evidence"
  >;
};

/**
 * Build lifecycle of a plan, driven authoritatively by the build turn's run
 * lifecycle (run.started → building, run.completed → built, failure/cancel/
 * disconnect → not_built). The Review card shows only while `not_built`.
 */
export type PlanBuildStatus = "not_built" | "building" | "built";

/** Markdown segment of a plan body. New writes store a single markdown block. */
export type PlanBlock = { type: "markdown"; content: string };

export type PlanRef = {
  /** Stable id of the owning session. */
  id: string;
  title: string;
  /** One-paragraph summary (Review card subtitle). */
  overview: string;
  /** Absolute path to the active `plan.md`. */
  path: string;
  /** Content fingerprint. */
  hash: string;
  workspaceId: string;
  sessionId: string;
  /** Markdown presentation blocks (normalized; legacy visual blocks are projected to text). */
  blocks: PlanBlock[];
  /** Markdown plan body — executor source of truth (`plan.md`). */
  content: string;
  /** Structured task list used by the approval/build flow. */
  todos: PlanTodo[];
  /** Optional structured requirements and evidence authored in Spec Mode. */
  spec?: PlanSpec;
  /** Build lifecycle state (see PlanBuildStatus). */
  buildStatus: PlanBuildStatus;
  createdAt: string;
  updatedAt: string;
};

/* ── Skills (Agent Skills, 2026 SKILL.md standard) ─────────────────────── */

export type ConfigScope = "workspace" | "user";
export type SkillScope = ConfigScope | "builtin";
/** Settings/runtime source for a subagent profile (Markdown CRUD vs Modus defaults). */
export type SubagentScope = ConfigScope | "builtin";
