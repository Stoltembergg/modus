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

export const startupMetricSchema = z.object({
  milestone: z.enum(STARTUP_RENDERER_MILESTONES),
  rendererElapsedMs: z.number().finite().nonnegative(),
});

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
