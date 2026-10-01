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

export const clipboardWriteImageSchema = z.object({
  png: pngBytesSchema,
});

export const dialogSaveImageSchema = z.object({
  png: pngBytesSchema,
  defaultName: z.string().trim().min(1).max(200).optional(),
});
