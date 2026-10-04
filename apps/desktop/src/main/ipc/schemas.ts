import { z } from "zod";
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_FACES,
  AGENT_AVATAR_SHAPES,
  type ContextItem,
} from "../../shared/contracts";
import {
  GROUP_CAPABILITY_IDS,
  GROUP_SUPPORTED_TASK_KINDS,
  normalizeGroupMemberCapabilities,
} from "../../shared/group-capabilities";
import { STARTUP_RENDERER_MILESTONES } from "../../shared/startup";
import {
  MAX_RESTORE_DRAFT_CHARS,
  MAX_RESTORE_DRAFTS,
  MAX_RESTORE_UI_STATE_BYTES,
} from "../../shared/update-restore";

const nonEmptyString = z.string().trim().min(1);
const optionalNonEmptyString = nonEmptyString.optional();
const MAX_HYPERPLAN_REVISION_BYTES = 12 * 1024;
const MAX_PLAN_CONTENT_BYTES = 64 * 1024;
const MAX_HYPERPLAN_SOURCE_ITEMS = 100;
const MAX_HYPERPLAN_SOURCE_EVIDENCE = 800;
const MAX_HYPERPLAN_SOURCE_SNAPSHOT_BYTES = 1024 * 1024;
const sourceSnapshotIdSchema = z.string().min(1).max(128).regex(/\S/);
const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const optionalHeadersSchema = z.record(z.string(), z.string()).optional();
const mcpReadOnlyToolAllowlistSchema = z
  .array(
    z
      .string()
      .max(256)
      .refine((name) => name.trim().length > 0, "Tool names cannot be empty."),
  )
  .max(100)
  .refine((names) => new Set(names).size === names.length, "Tool names must be unique.")
  .optional();
export const startupMetricSchema = z.object({
  milestone: z.enum(STARTUP_RENDERER_MILESTONES),
  rendererElapsedMs: z.number().finite().nonnegative(),
});
const modelCostSchema = z
  .object({
    input: z.number().min(0).optional(),
    output: z.number().min(0).optional(),
    cacheRead: z.number().min(0).optional(),
    cacheWrite: z.number().min(0).optional(),
  })
  .optional();

export const agentCreateSchema = z.object({
  workspaceId: nonEmptyString,
  cwd: nonEmptyString,
  title: nonEmptyString,
  model: optionalNonEmptyString,
});

export const workspacePinSchema = z.object({
  id: nonEmptyString,
  pinned: z.boolean(),
});

export const workspaceRenameSchema = z.object({
  id: nonEmptyString,
  displayName: z.string().trim().min(1).max(120),
});

export const workspaceIdSchema = z.object({
  id: nonEmptyString,
});

export const sessionPinSchema = z.object({
  id: nonEmptyString,
  pinned: z.boolean(),
});

export const sessionTitleSchema = z.object({
  id: nonEmptyString,
  title: nonEmptyString.max(200),
});

/** ~10 MB of raw image bytes once base64-decoded. */
const MAX_ATTACHMENT_BASE64_CHARS = 14_000_000;

const promptImageAttachmentSchema = z.object({
  type: z.literal("image"),
  data: z.string().min(1).max(MAX_ATTACHMENT_BASE64_CHARS),
  mimeType: z.string().regex(/^image\/[\w.+-]+$/),
  name: z.string().max(256).optional(),
});

const skillSelectionSchema = z.object({
  name: nonEmptyString,
  path: nonEmptyString,
});

export const agentPromptSchema = z.object({
  sessionId: nonEmptyString,
  message: nonEmptyString,
  context: z
    .array(z.unknown())
    .transform((items) => items as ContextItem[])
    .optional(),
  delivery: z.enum(["normal", "steer", "follow-up"]).optional(),
  userMessageId: optionalNonEmptyString,
  attachments: z.array(promptImageAttachmentSchema).max(6).optional(),
  skills: z.array(skillSelectionSchema).max(10).optional(),
  mode: z.enum(["build", "plan", "spec"]).optional(),
  model: optionalNonEmptyString,
  thinkingLevel: thinkingLevelSchema.optional(),
  thinkingVariant: optionalNonEmptyString,
  planId: optionalNonEmptyString,
});

export const sessionIdSchema = nonEmptyString;

/**
 * L2: the renderer sends ONLY a branch name; the main process validates it against the
 * repo's local branches and uses the session's own cwd. A path is never accepted.
 */
export const agentSetBranchSchema = z
  .object({
    sessionId: nonEmptyString.max(128),
    branch: nonEmptyString
      .max(255)
      .refine((name) => !/[\\\0\s~^:?*[]|\.\.|@\{|^[-/.]|[/.]$|\.lock$/.test(name), {
        message: "invalid branch name",
      }),
  })
  .strict();

export const agentReviewPlanWithHyperPlanSchema = z
  .object({
    sessionId: nonEmptyString.max(128),
    planId: nonEmptyString.max(128),
    model: optionalNonEmptyString,
  })
  .strict();

export const agentApplyHyperPlanRevisionSchema = z
  .object({
    sessionId: nonEmptyString.max(128),
    planId: nonEmptyString.max(128),
    planHash: nonEmptyString.max(128),
    revisedContent: z
      .string()
      .trim()
      .min(1)
      .max(MAX_HYPERPLAN_REVISION_BYTES)
      .refine(
        (content) => new TextEncoder().encode(content).byteLength <= MAX_HYPERPLAN_REVISION_BYTES,
        `Revision content must be at most ${MAX_HYPERPLAN_REVISION_BYTES} UTF-8 bytes.`,
      ),
  })
  .strict();

export const agentCreateHyperPlanDraftSchema = z
  .object({
    sessionId: nonEmptyString.max(128),
    planId: nonEmptyString.max(128),
    /** Spec/composer model id; HyperPlan prefers this over the global default. */
    model: optionalNonEmptyString,
  })
  .strict();

export const agentResolveHyperPlanDraftChoiceSchema = z
  .object({
    draftId: nonEmptyString.max(128),
    choice: z.enum(["revision", "original"]),
    requestId: nonEmptyString.max(128),
  })
  .strict();

export const agentStartPlanBuildSchema = z
  .object({
    selectionId: nonEmptyString.max(128),
    requestId: nonEmptyString.max(128),
  })
  .strict();

export const agentStartOriginalPlanBuildSchema = z
  .object({
    sessionId: nonEmptyString.max(128),
    planId: nonEmptyString.max(128),
    requestId: nonEmptyString.max(128),
    sourceSnapshot: z
      .object({
        title: z.string().min(1).max(MAX_HYPERPLAN_SOURCE_SNAPSHOT_BYTES),
        overview: z.string().min(1).max(MAX_HYPERPLAN_SOURCE_SNAPSHOT_BYTES),
        content: z
          .string()
          .min(1)
          .max(MAX_PLAN_CONTENT_BYTES)
          .refine(
            (content) => new TextEncoder().encode(content).byteLength <= MAX_PLAN_CONTENT_BYTES,
            `Source content must be at most ${MAX_PLAN_CONTENT_BYTES} UTF-8 bytes.`,
          ),
        todos: z
          .array(
            z
              .object({
                id: sourceSnapshotIdSchema,
                content: z.string().min(1).max(MAX_HYPERPLAN_SOURCE_SNAPSHOT_BYTES),
                acceptanceCriterionIds: z
                  .array(sourceSnapshotIdSchema)
                  .max(MAX_HYPERPLAN_SOURCE_ITEMS),
              })
              .strict(),
          )
          .max(MAX_HYPERPLAN_SOURCE_ITEMS),
        spec: z
          .object({
            requirements: z
              .array(
                z
                  .object({ id: sourceSnapshotIdSchema, text: z.string().min(1).max(2_000) })
                  .strict(),
              )
              .max(MAX_HYPERPLAN_SOURCE_ITEMS),
            acceptanceCriteria: z
              .array(
                z
                  .object({
                    id: sourceSnapshotIdSchema,
                    requirementId: sourceSnapshotIdSchema,
                    description: z.string().min(1).max(2_000),
                    todoIds: z.array(sourceSnapshotIdSchema).max(MAX_HYPERPLAN_SOURCE_ITEMS),
                    requiredCheckKinds: z
                      .array(z.enum(["tests", "typecheck", "lint", "build"]))
                      .max(4)
                      .refine((kinds) => new Set(kinds).size === kinds.length)
                      .optional(),
                    status: z.enum(["pending", "passed", "failed", "skipped", "blocked"]),
                  })
                  .strict(),
              )
              .max(MAX_HYPERPLAN_SOURCE_ITEMS),
            assumptions: z.array(z.string().min(1).max(500)).max(20),
            openQuestions: z.array(z.string().min(1).max(500)).max(20),
            evidence: z
              .array(
                z
                  .object({
                    id: sourceSnapshotIdSchema,
                    kind: z.string().max(128),
                    status: z.enum([
                      "passed",
                      "failed",
                      "skipped",
                      "missing",
                      "unavailable",
                      "user_confirmed",
                    ]),
                    runId: sourceSnapshotIdSchema.optional(),
                    eventId: sourceSnapshotIdSchema.optional(),
                    revision: sourceSnapshotIdSchema.optional(),
                    paths: z.array(z.string().max(512)).max(MAX_HYPERPLAN_SOURCE_ITEMS).optional(),
                    label: z.string().max(512),
                    criterionId: sourceSnapshotIdSchema,
                  })
                  .strict(),
              )
              .max(MAX_HYPERPLAN_SOURCE_EVIDENCE),
          })
          .strict(),
      })
      .strict()
      .superRefine((snapshot, ctx) => {
        if (
          new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
          MAX_HYPERPLAN_SOURCE_SNAPSHOT_BYTES
        ) {
          ctx.addIssue({
            code: "custom",
            message: `Source snapshot must be at most ${MAX_HYPERPLAN_SOURCE_SNAPSHOT_BYTES} UTF-8 bytes.`,
          });
        }
      }),
  })
  .strict();

export const agentListSchema = z
  .object({
    includeSessionId: optionalNonEmptyString,
  })
  .optional();

export const agentRollbackSchema = z.object({
  sessionId: nonEmptyString,
  userMessageId: nonEmptyString,
});

export const agentSetModelSchema = z.object({
  sessionId: nonEmptyString,
  model: nonEmptyString,
  thinkingLevel: thinkingLevelSchema.optional(),
  thinkingVariant: optionalNonEmptyString,
});

export const agentCycleModelSchema = z.object({
  sessionId: optionalNonEmptyString,
  direction: z.enum(["forward", "backward"]).optional(),
});

export const terminalCreateSchema = z.object({
  workspaceId: nonEmptyString,
  cwd: optionalNonEmptyString,
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
});

export const terminalWriteSchema = z.object({
  terminalId: nonEmptyString,
  data: z.string(),
});

export const terminalResizeSchema = z.object({
  terminalId: nonEmptyString,
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});

export const processListSchema = z.object({
  workspaceId: optionalNonEmptyString,
  sessionId: optionalNonEmptyString,
  origin: z.enum(["user", "agent"]).optional(),
});

export const processKillSchema = z.object({
  id: nonEmptyString,
});

export const cwdSchema = nonEmptyString;

export const filesListSchema = z.object({
  cwd: nonEmptyString,
  dir: optionalNonEmptyString,
});

export const filesReadSchema = z.object({
  cwd: nonEmptyString,
  path: nonEmptyString,
});

export const filesWriteSchema = z.object({
  cwd: nonEmptyString,
  path: nonEmptyString,
  content: z.string(),
});

export const previewReadSchema = z.object({
  cwd: nonEmptyString,
  path: nonEmptyString,
});

export const browserWorkspaceSchema = z.object({
  workspaceId: nonEmptyString,
});

export const browserCreateTabSchema = z.object({
  workspaceId: nonEmptyString,
  url: z.string().trim().optional(),
});

export const browserTabSchema = z.object({
  tabId: nonEmptyString,
});

export const browserNavigateSchema = z.object({
  tabId: optionalNonEmptyString,
  workspaceId: optionalNonEmptyString,
  url: nonEmptyString,
  newTab: z.boolean().optional(),
});

export const browserBoundsSchema = z.object({
  tabId: nonEmptyString,
  bounds: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().min(0).max(10_000),
    height: z.number().finite().min(0).max(10_000),
  }),
});

export const browserFindSchema = z.object({
  tabId: nonEmptyString,
  query: nonEmptyString,
  forward: z.boolean().optional(),
  findNext: z.boolean().optional(),
  matchCase: z.boolean().optional(),
});

export const browserFindStopSchema = z.object({
  tabId: nonEmptyString,
  action: z.enum(["clearSelection", "keepSelection", "activateSelection"]).optional(),
});

export const browserRecentSchema = z.object({
  id: nonEmptyString,
});

const hexColor = z.string().trim().min(1).max(64);

export const browserDesignModeSchema = z.object({
  tabId: nonEmptyString,
  enabled: z.boolean(),
  theme: z
    .object({
      accent: hexColor,
      accentContrast: hexColor,
      surface: hexColor,
      elevated: hexColor,
      fg: hexColor,
      fgSubtle: hexColor,
      fontFamily: z.string().trim().min(1).max(512),
      border: hexColor,
      shadow: hexColor,
    })
    .optional(),
});

export const skillsGetSchema = z.object({
  cwd: nonEmptyString,
  path: nonEmptyString,
});

export const skillsCreateSchema = z.object({
  cwd: nonEmptyString,
  name: nonEmptyString.max(64),
  description: z.string().trim().max(280),
  body: z.string().trim().min(1).max(20_000),
});

export const subagentsGetSchema = z.object({
  cwd: nonEmptyString,
  path: nonEmptyString,
});

export const subagentsCreateSchema = z.object({
  cwd: nonEmptyString,
  scope: z.enum(["user", "workspace"]).optional(),
  name: nonEmptyString.max(64),
  description: z.string().trim().max(280),
  model: z.string().trim().max(120).optional(),
  readOnly: z.boolean(),
  tools: z.array(z.string().trim().min(1).max(80)).optional(),
  disallowedTools: z.array(z.string().trim().min(1).max(80)).optional(),
  isolation: z.enum(["shared", "worktree"]).optional(),
  body: z.string().trim().min(1).max(20_000),
});

export const subagentsUpdateSchema = subagentsCreateSchema.extend({
  path: nonEmptyString,
});

export const subagentsDeleteSchema = z.object({
  cwd: nonEmptyString,
  path: nonEmptyString,
});

export const subagentsOpenDirSchema = z.object({
  cwd: nonEmptyString,
  scope: z.enum(["user", "workspace"]).optional(),
});

export const diffReadSchema = z.object({
  cwd: nonEmptyString,
  path: optionalNonEmptyString,
  mode: z.enum(["unstaged", "staged", "working-state"]).optional(),
});

export const diffPathSchema = z.object({
  cwd: nonEmptyString,
  path: nonEmptyString,
});

export const diffTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unstaged") }),
  z.object({ type: z.literal("staged") }),
  z.object({ type: z.literal("commit"), commit: nonEmptyString }),
  z.object({ type: z.literal("branch"), base: optionalNonEmptyString }),
  z.object({ type: z.literal("last-turn"), sessionId: nonEmptyString }),
]);

export const diffReviewSchema = z.object({
  cwd: nonEmptyString,
  target: diffTargetSchema,
});

export const diffStatsSinceSchema = z.object({
  cwd: nonEmptyString,
  base: nonEmptyString,
});

/**
 * Open a workspace file in the OS default app. `path` is the tool's reported
 * path (relative to cwd or absolute); the handler resolves + sandboxes it.
 */
export const fileOpenSchema = z.object({
  cwd: nonEmptyString,
  path: nonEmptyString,
});

export const diffFilePatchSchema = z.object({
  cwd: nonEmptyString,
  path: nonEmptyString,
  target: diffTargetSchema,
  originalPath: optionalNonEmptyString,
  untracked: z.boolean(),
  ignoreWhitespace: z.boolean(),
});

/** Recent commit history for the All commits scope. */
export const gitLogSchema = z.object({
  cwd: nonEmptyString,
  limit: z.number().int().positive().max(500).optional(),
});

export const diffCommitOrPushSchema = z
  .object({
    cwd: nonEmptyString,
    message: optionalNonEmptyString,
    commit: z.boolean(),
    push: z.boolean(),
    includeUnstaged: z.boolean().optional(),
  })
  .refine((value) => value.commit || value.push, {
    message: "At least one of commit or push must be requested.",
  })
  .refine((value) => !value.commit || (value.message?.trim().length ?? 0) > 0, {
    message: "Commit message is required when committing.",
  });

export const gitCheckoutSchema = z.object({
  cwd: nonEmptyString,
  name: nonEmptyString,
  remote: z.boolean().optional(),
});

export const permissionDecideSchema = z.object({
  requestId: optionalNonEmptyString,
  sessionId: optionalNonEmptyString,
  action: z.enum([
    "shell.execute",
    "file.write",
    "file.delete",
    "git.write",
    "mcp.call",
    "external.open",
    "browser.control",
  ]),
  target: nonEmptyString,
  decision: z.enum(["allow-once", "allow-workspace", "deny"]),
});

export const approvalModeSchema = z.object({
  mode: z.enum(["request-approval", "auto", "full-access"]),
  /** When set, writes a project override for this cwd instead of the global default. */
  cwd: z.string().min(1).optional(),
});

export const approvalModeGetSchema = z.object({
  cwd: z.string().min(1).optional(),
});

export const approvalModeClearProjectSchema = z.object({
  cwd: z.string().min(1),
});

export const questionRespondSchema = z.object({
  requestId: nonEmptyString,
  skipped: z.boolean(),
  answers: z
    .array(
      z.object({
        questionId: nonEmptyString,
        selected: z.array(z.string()).default([]),
        custom: z.string().optional(),
      }),
    )
    .default([]),
});

export const contextSearchSchema = z.object({
  workspaceId: nonEmptyString,
  cwd: nonEmptyString,
  query: z.string(),
  kind: z
    .enum([
      "file",
      "folder",
      "doc",
      "terminal",
      "browser",
      "git-diff",
      "past-chat",
      "project-summary",
      "recent-changes",
      "rules",
      "search",
    ])
    .optional(),
});

export const contextResolveSchema = z.object({
  cwd: nonEmptyString,
  items: z.array(z.unknown()).transform((items) => items as ContextItem[]),
});

export const docsAddSchema = z.object({
  workspaceId: nonEmptyString,
  title: nonEmptyString,
  path: optionalNonEmptyString,
  url: optionalNonEmptyString,
});

export const docsSearchSchema = z.object({
  workspaceId: nonEmptyString,
  query: z.string(),
});

export const projectMemorySnapshotSchema = z
  .object({
    workspaceId: optionalNonEmptyString,
  })
  .strict();

export const workspaceSelectSchema = z
  .object({
    workspaceId: optionalNonEmptyString,
  })
  .strict();

export const projectMemorySetEnabledSchema = z
  .object({
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("global") }).strict(),
      z.object({ kind: z.literal("project"), workspaceId: nonEmptyString }).strict(),
    ]),
    enabled: z.boolean(),
  })
  .strict();

export const projectMemoryIdSchema = z.object({ memoryId: nonEmptyString }).strict();

export const harnessInsightsQuerySchema = z
  .object({
    workspaceId: nonEmptyString.max(128).optional(),
    since: z.string().datetime({ offset: true }),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const checkpointRestoreSchema = z.object({
  checkpointId: nonEmptyString,
});

const stringRecordSchema = z.record(z.string(), z.string());

export const mcpUpsertSchema = z
  .object({
    cwd: nonEmptyString,
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[\w.-]+$/, "Server names may use letters, numbers, dot, dash and underscore."),
    originalName: optionalNonEmptyString,
    scope: z.enum(["user", "project"]).optional(),
    transport: z.enum(["stdio", "http"]),
    command: z.string().trim().optional(),
    args: z.array(z.string()).max(64).optional(),
    env: stringRecordSchema.optional(),
    url: z.string().trim().optional(),
    headers: stringRecordSchema.optional(),
    readOnlyToolAllowlist: mcpReadOnlyToolAllowlistSchema,
    enabled: z.boolean(),
  })
  .refine((value) => (value.transport === "stdio" ? Boolean(value.command?.trim()) : true), {
    message: "Local servers need a command.",
  })
  .refine(
    (value) =>
      value.transport === "http" ? Boolean(value.url && /^https?:\/\//.test(value.url)) : true,
    { message: "Remote servers need an http(s) URL." },
  );

export const mcpServerNameSchema = z.object({
  cwd: nonEmptyString,
  name: nonEmptyString,
});

export const mcpSetEnabledSchema = z.object({
  cwd: nonEmptyString,
  name: nonEmptyString,
  enabled: z.boolean(),
});

export const personalizationSaveSchema = z.object({
  content: z.string().max(200_000),
});

export const rulesSaveAgentsSchema = z.object({
  cwd: nonEmptyString,
  content: z.string().max(200_000),
});

export const setProviderModelsEnabledSchema = z.object({
  provider: nonEmptyString,
  enabled: z.boolean(),
});

export const limitsCodexEnabledSchema = z.object({ enabled: z.boolean() }).strict();
export const limitsNoInputSchema = z.undefined();
export const updateNoInputSchema = z.undefined();

const restoreIdSchema = z.string().min(1).max(256);
const restorePanelSchema = { open: z.boolean(), width: z.number().finite().min(0).max(4096) };
const restoreDraftSchema = z
  .object({
    text: z.string().max(MAX_RESTORE_DRAFT_CHARS),
    mode: z.enum(["build", "plan", "spec"]),
  })
  .strict();

/** UI state the renderer pushes while an update is pending (and read back from disk). */
export const updateRestoreUiStateSchema = z
  .object({
    activeWorkspaceId: restoreIdSchema.nullable(),
    activeSessionId: restoreIdSchema.nullable(),
    drafts: z
      .record(restoreIdSchema, restoreDraftSchema)
      .refine((drafts) => Object.keys(drafts).length <= MAX_RESTORE_DRAFTS, {
        message: "too many drafts",
      }),
    hero: restoreDraftSchema,
    sidebar: z.object(restorePanelSchema).strict(),
    inspector: z
      .object({
        ...restorePanelSchema,
        tab: z.enum(["changes", "plan", "files", "subagents", "browser", "terminal", "security"]),
      })
      .strict(),
    settingsOpen: z.boolean(),
  })
  .strict();

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Byte cap (MAX_RESTORE_UI_STATE_BYTES) applies to the renderer payload and the file on disk. */
export const updateSaveUiStateSchema = z
  .unknown()
  .refine((value) => jsonByteLength(value) <= MAX_RESTORE_UI_STATE_BYTES, {
    message: "UI state too large",
  })
  .pipe(updateRestoreUiStateSchema);

export const reviewStartSchema = z.object({
  cwd: nonEmptyString,
  sessionId: optionalNonEmptyString,
  workspaceId: optionalNonEmptyString,
  depth: z.enum(["fast", "standard", "deep"]).optional(),
});

export const configureProviderSchema = z.object({
  provider: nonEmptyString,
  apiKey: z.string().optional(),
  baseUrl: z.string().trim().optional(),
  enabledModelIds: z.array(nonEmptyString).optional(),
});

export const providerAuthStartSchema = z
  .object({
    provider: nonEmptyString,
    riskAcknowledged: z.literal(true).optional(),
  })
  .refine((input) => input.provider !== "antigravity" || input.riskAcknowledged === true, {
    message: "Antigravity sign-in requires risk acknowledgement.",
    path: ["riskAcknowledged"],
  });

export const providerAuthOperationSchema = z.object({
  operationId: nonEmptyString,
});

export const providerAuthResponseSchema = z.object({
  operationId: nonEmptyString,
  value: z.string().max(20_000).optional(),
});

const providerCompatibilitySchema = z.object({
  supportsDeveloperRole: z.boolean().optional(),
  supportsReasoningEffort: z.boolean().optional(),
});

const modelCompatibilitySchema = z.object({
  thinkingFormat: z
    .enum([
      "none",
      "openai",
      "openrouter",
      "deepseek",
      "together",
      "zai",
      "qwen",
      "qwen-chat-template",
      "string-thinking",
    ])
    .optional(),
  supportsUsageInStreaming: z.boolean().optional(),
  forceAdaptiveThinking: z.boolean().optional(),
  allowEmptySignature: z.boolean().optional(),
});

export const customProviderModelSchema = z.object({
  id: nonEmptyString,
  name: z.string().optional(),
  api: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().url().optional(),
  headers: optionalHeadersSchema,
  contextWindow: z.number().int().min(1_000).max(10_000_000).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  reasoning: z.boolean().optional(),
  input: z
    .array(z.enum(["text", "image"]))
    .min(1)
    .optional(),
  cost: modelCostSchema,
  compat: jsonObjectSchema.optional(),
  compatibility: modelCompatibilitySchema.optional(),
  thinkingLevelMap: z.partialRecord(thinkingLevelSchema, z.string().nullable()).optional(),
});

export const upsertCustomProviderSchema = z.object({
  provider: nonEmptyString,
  name: nonEmptyString,
  baseUrl: z.string().trim().url(),
  apiKey: z.string().optional(),
  api: z.string().trim().min(1).optional(),
  authHeader: z.boolean().optional(),
  headers: optionalHeadersSchema,
  compat: jsonObjectSchema.optional(),
  compatibility: providerCompatibilitySchema.optional(),
  models: z.array(customProviderModelSchema).min(1),
});

export const testCustomProviderSchema = z.object({
  provider: optionalNonEmptyString,
  baseUrl: z.string().trim().url(),
  api: z.string().trim().min(1).optional(),
  apiKey: z.string().optional(),
  authHeader: z.boolean().optional(),
  headers: optionalHeadersSchema,
  model: z.object({
    id: nonEmptyString,
    api: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().url().optional(),
    headers: optionalHeadersSchema,
    reasoning: z.boolean().optional(),
    contextWindow: z.number().int().min(1_000).max(10_000_000).optional(),
    maxTokens: z.number().int().min(1).max(1_000_000).optional(),
    compat: jsonObjectSchema.optional(),
    compatibility: modelCompatibilitySchema.optional(),
    thinkingLevelMap: z.partialRecord(thinkingLevelSchema, z.string().nullable()).optional(),
  }),
});

export const updateModelConfigSchema = z.object({
  model: nonEmptyString,
  enabled: z.boolean().optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  thinkingVariant: optionalNonEmptyString,
  contextWindow: z.number().int().min(1_000).max(10_000_000).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
});

/** PNG bytes from renderer canvas.encode — Uint8Array survives Electron IPC clone. */
const pngBytesSchema = z.custom<Uint8Array>(
  (value): value is Uint8Array => {
    if (value instanceof Uint8Array) {
      return value.byteLength > 0 && value.byteLength <= 50_000_000;
    }
    // Some Electron builds surface cloned bytes as Buffer on the main side.
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      return value.byteLength > 0 && value.byteLength <= 50_000_000;
    }
    return false;
  },
  { message: "png bytes required" },
);

export const clipboardWriteImageSchema = z.object({
  png: pngBytesSchema,
});

export const dialogSaveImageSchema = z.object({
  png: pngBytesSchema,
  defaultName: z.string().trim().min(1).max(200).optional(),
});

export function parseIpcInput<T>(schema: z.ZodType<T>, value: unknown, channel: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid IPC payload for ${channel}: ${result.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  return result.data;
}

/* ── Agents (agents:*) ─────────────────────────────────────────────────── */

const agentIdString = nonEmptyString.max(128);
const agentFields = {
  name: z.string().trim().min(1).max(80),
  role: z.string().max(80),
  instructions: z.string().max(20_000),
  modelId: z.string().max(256).nullable(),
  defaultWorkspaceId: z.string().min(1).max(128).nullable(),
  avatarFace: z.enum(AGENT_AVATAR_FACES),
  avatarColor: z.enum(AGENT_AVATAR_COLORS),
  avatarShape: z.enum(AGENT_AVATAR_SHAPES),
  capabilityIds: z
    .array(z.enum(GROUP_CAPABILITY_IDS))
    .max(64)
    .transform(
      (capabilityIds) => normalizeGroupMemberCapabilities({ capabilityIds }).capabilityIds,
    ),
  supportedTaskKinds: z
    .array(z.enum(GROUP_SUPPORTED_TASK_KINDS))
    .max(64)
    .transform(
      (supportedTaskKinds) =>
        normalizeGroupMemberCapabilities({ supportedTaskKinds }).supportedTaskKinds,
    ),
};

export const agentsCreateSchema = z
  .object({
    /** The agent's only group (required, A2). */
    groupId: agentIdString,
    name: agentFields.name,
    /** From a template: exempt from the model rule (the app default model applies). */
    templateId: z.string().min(1).max(128).optional(),
    role: agentFields.role.optional(),
    instructions: agentFields.instructions.optional(),
    modelId: agentFields.modelId.optional(),
    defaultWorkspaceId: agentFields.defaultWorkspaceId.optional(),
    avatarFace: agentFields.avatarFace.optional(),
    avatarColor: agentFields.avatarColor.optional(),
    avatarShape: agentFields.avatarShape.optional(),
    capabilityIds: agentFields.capabilityIds.optional(),
    supportedTaskKinds: agentFields.supportedTaskKinds.optional(),
  })
  .strict();

export const agentsUpdateSchema = z
  .object({
    id: agentIdString,
    name: agentFields.name.optional(),
    role: agentFields.role.optional(),
    instructions: agentFields.instructions.optional(),
    modelId: agentFields.modelId.optional(),
    defaultWorkspaceId: agentFields.defaultWorkspaceId.optional(),
    avatarFace: agentFields.avatarFace.optional(),
    avatarColor: agentFields.avatarColor.optional(),
    avatarShape: agentFields.avatarShape.optional(),
    capabilityIds: agentFields.capabilityIds.optional(),
    supportedTaskKinds: agentFields.supportedTaskKinds.optional(),
  })
  .strict();

export const agentsArchiveSchema = z.object({ id: agentIdString, archived: z.boolean() }).strict();

export const agentsIdSchema = z.object({ id: agentIdString }).strict();

/** Cap on `roles` (the modal holds at most a few more than the 10-member limit). */
const MAX_PROFILE_ROLES = 32;

export const agentsGenerateProfileSchema = z
  .object({
    // Absent in the create-group modal (A4): no group yet, `roles` carries the chosen ones.
    groupId: agentIdString.optional(),
    roles: z.array(agentFields.role).max(MAX_PROFILE_ROLES).optional(),
    modelId: z.string().trim().min(1).max(256),
    name: agentFields.name,
    description: z.string().trim().max(500).optional(),
    agentId: agentIdString.optional(),
  })
  .strict();

/* ── Agent Groups (group:*) ─────────────────────────────────────────────── */

const groupIdString = nonEmptyString.max(128);
const groupSessionIdString = nonEmptyString.max(128);
const groupNameString = z.string().trim().min(1).max(120);
export const MAX_GROUP_MEMBERS = 32;

/** A NEW agent created in a group (group:create members, group:update-members adds). */
const newGroupAgentSchema = z
  .object({
    name: agentFields.name,
    role: agentFields.role.optional(),
    instructions: agentFields.instructions.optional(),
    modelId: agentFields.modelId.optional(),
    defaultWorkspaceId: agentFields.defaultWorkspaceId.optional(),
    avatarFace: agentFields.avatarFace.optional(),
    avatarColor: agentFields.avatarColor.optional(),
    avatarShape: agentFields.avatarShape.optional(),
    capabilityIds: agentFields.capabilityIds.optional(),
    supportedTaskKinds: agentFields.supportedTaskKinds.optional(),
    templateId: z.string().min(1).max(128).optional(),
  })
  .strict();

export const groupCreateSchema = z
  .object({
    name: groupNameString,
    // Required, but null / the Chats inbox parse so they fail as group-project-required.
    workspaceId: groupIdString.nullable(),
    mode: z.enum(["free", "coordinator"]).optional(),
    // NEW agents, created in the group (one group per agent). The 2..10 rule is
    // groupCreateCountError; this bound only caps the payload.
    members: z.array(newGroupAgentSchema).max(MAX_GROUP_MEMBERS),
    leadName: agentFields.name.nullable().optional(),
  })
  .strict();

export const groupRenameSchema = z.object({ id: groupIdString, name: groupNameString }).strict();

export const groupIdInputSchema = z.object({ id: groupIdString }).strict();

export const groupListTasksSchema = z.object({ groupId: groupIdString }).strict();

export const groupCancelTaskSchema = z.object({ taskId: nonEmptyString.max(128) }).strict();

export const groupListDecisionsSchema = z.object({ groupId: groupIdString }).strict();

/** Strict: the user deletes; a payload naming a session (a member acting) is refused. */
export const groupDeleteDecisionSchema = z.object({ decisionId: nonEmptyString.max(128) }).strict();

export const groupMemberSchema = z
  .object({
    groupId: groupIdString,
    agentId: groupIdString,
    role: z.string().trim().max(40).optional(),
  })
  .strict();

export const groupSetWorkspaceSchema = z
  .object({ groupId: groupIdString, workspaceId: groupIdString.nullable() })
  .strict();

export const groupRemoveMemberSchema = z
  .object({ groupId: groupIdString, sessionId: groupSessionIdString })
  .strict();

/** "Manage members" in one payload: adds, removes and the final lead (one transaction). */
export const groupUpdateMembersSchema = z
  .object({
    groupId: groupIdString,
    add: z.array(newGroupAgentSchema).max(MAX_GROUP_MEMBERS),
    removeAgentIds: z.array(groupIdString).max(MAX_GROUP_MEMBERS),
    lead: z
      .union([
        z.object({ agentId: groupIdString }).strict(),
        z.object({ name: agentFields.name }).strict(),
      ])
      .nullable(),
  })
  .strict();

export const groupSetLeadSchema = z
  .object({ groupId: groupIdString, sessionId: groupSessionIdString.nullable() })
  .strict();

export const groupSetModeSchema = z
  .object({ groupId: groupIdString, mode: z.enum(["free", "coordinator"]) })
  .strict();

/** A room message body; long enough for pasted logs, bounded for the prompt budget. */
export const MAX_GROUP_MESSAGE_BODY = 20_000;

export const groupPostMessageSchema = z
  .object({
    groupId: groupIdString,
    body: z.string().max(MAX_GROUP_MESSAGE_BODY),
    mentions: z.array(groupSessionIdString).max(MAX_GROUP_MEMBERS).optional(),
    replyToMessageId: groupIdString.optional(),
    attachments: z.array(promptImageAttachmentSchema).max(6).optional(),
    contextItems: z
      .array(z.unknown())
      .max(20)
      .transform((items) => items as ContextItem[])
      .optional(),
    /** `new` opens a fresh execution; `complement` joins an existing one. */
    executionMode: z.enum(["new", "complement"]).optional(),
    /** Explicit execution id to complement (chain root message id). */
    executionId: groupIdString.optional(),
  })
  .strict()
  .transform((value) => ({ ...value, body: value.body.trim() }))
  .refine(
    (value) =>
      value.body.length > 0 ||
      (value.attachments?.length ?? 0) > 0 ||
      (value.contextItems?.length ?? 0) > 0,
    { message: "Group message needs text or attachments." },
  );

const groupMessageCursorSchema = z
  .object({ createdAt: nonEmptyString.max(64), id: groupIdString })
  .strict();

export const groupStopSchema = z.object({ groupId: groupIdString }).strict();

export const groupResumeExecutionSchema = z
  .object({ groupId: groupIdString, executionId: groupIdString })
  .strict();

export const groupListMessagesSchema = z
  .object({
    groupId: groupIdString,
    before: groupMessageCursorSchema.optional(),
    after: groupMessageCursorSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
