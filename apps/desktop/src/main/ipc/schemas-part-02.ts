import { z } from "zod";
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_FACES,
  AGENT_AVATAR_SHAPES,
  type ContextItem,
} from "../../shared/contracts";
import { STARTUP_RENDERER_MILESTONES } from "../../shared/startup";
import {
  MAX_RESTORE_DRAFT_CHARS,
  MAX_RESTORE_DRAFTS,
  MAX_RESTORE_UI_STATE_BYTES,
} from "../../shared/update-restore";

import {
  MAX_ATTACHMENT_BASE64_CHARS,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_MESSAGE_BODY,
  MAX_HYPERPLAN_REVISION_BYTES,
  MAX_HYPERPLAN_SOURCE_EVIDENCE,
  MAX_HYPERPLAN_SOURCE_ITEMS,
  MAX_HYPERPLAN_SOURCE_SNAPSHOT_BYTES,
  MAX_PLAN_CONTENT_BYTES,
  MAX_PROFILE_ROLES,
  agentFields,
  agentIdString,
  fileOpenSchema,
  gitLogSchema,
  groupDeleteDecisionSchema,
  groupIdString,
  groupMessageCursorSchema,
  groupNameString,
  groupSessionIdString,
  groupUpdateMembersSchema,
  hexColor,
  jsonByteLength,
  jsonObjectSchema,
  mcpReadOnlyToolAllowlistSchema,
  modelCompatibilitySchema,
  modelCostSchema,
  newGroupAgentSchema,
  nonEmptyString,
  optionalHeadersSchema,
  optionalNonEmptyString,
  pngBytesSchema,
  promptImageAttachmentSchema,
  providerCompatibilitySchema,
  restoreDraftSchema,
  restoreIdSchema,
  restorePanelSchema,
  skillSelectionSchema,
  sourceSnapshotIdSchema,
  stringRecordSchema,
  thinkingLevelSchema,
  updateRestoreUiStateSchema,
  updateSaveUiStateSchema
} from "./schemas-shared";

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

export const diffFilePatchSchema = z.object({
  cwd: nonEmptyString,
  path: nonEmptyString,
  target: diffTargetSchema,
  originalPath: optionalNonEmptyString,
  untracked: z.boolean(),
  ignoreWhitespace: z.boolean(),
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
