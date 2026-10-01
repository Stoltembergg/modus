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
  MAX_ATTACHMENT_BASE64_CHARS,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_MESSAGE_BODY,
  MAX_HYPERPLAN_REVISION_BYTES,
  MAX_HYPERPLAN_SOURCE_EVIDENCE,
  MAX_HYPERPLAN_SOURCE_ITEMS,
  MAX_HYPERPLAN_SOURCE_SNAPSHOT_BYTES,
  MAX_PLAN_CONTENT_BYTES,
  MAX_PROFILE_ROLES,
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
  updateSaveUiStateSchema,
} from "./schemas-shared";

export function parseIpcInput<T>(schema: z.ZodType<T>, value: unknown, channel: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid IPC payload for ${channel}: ${result.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  return result.data;
}

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
  })
  .strict();

export const agentsArchiveSchema = z.object({ id: agentIdString, archived: z.boolean() }).strict();

export const agentsIdSchema = z.object({ id: agentIdString }).strict();

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

export const groupSetLeadSchema = z
  .object({ groupId: groupIdString, sessionId: groupSessionIdString.nullable() })
  .strict();

export const groupSetModeSchema = z
  .object({ groupId: groupIdString, mode: z.enum(["free", "coordinator"]) })
  .strict();

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
