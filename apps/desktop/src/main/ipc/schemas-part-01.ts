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
