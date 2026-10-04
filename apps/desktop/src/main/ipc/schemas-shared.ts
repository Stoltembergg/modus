import { z } from "zod";
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_FACES,
  AGENT_AVATAR_SHAPES,
} from "../../shared/contracts";
import {
  GROUP_CAPABILITY_IDS,
  GROUP_SUPPORTED_TASK_KINDS,
  normalizeGroupMemberCapabilities,
} from "../../shared/group-capabilities";
import {
  MAX_RESTORE_DRAFT_CHARS,
  MAX_RESTORE_DRAFTS,
  MAX_RESTORE_UI_STATE_BYTES,
} from "../../shared/update-restore";

export const nonEmptyString = z.string().trim().min(1);

export const optionalNonEmptyString = nonEmptyString.optional();

export const MAX_HYPERPLAN_REVISION_BYTES = 12 * 1024;

export const MAX_PLAN_CONTENT_BYTES = 64 * 1024;

export const MAX_HYPERPLAN_SOURCE_ITEMS = 100;

export const MAX_HYPERPLAN_SOURCE_EVIDENCE = 800;

export const MAX_HYPERPLAN_SOURCE_SNAPSHOT_BYTES = 1024 * 1024;

export const sourceSnapshotIdSchema = z.string().min(1).max(128).regex(/\S/);

export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const jsonObjectSchema = z.record(z.string(), z.unknown());

export const optionalHeadersSchema = z.record(z.string(), z.string()).optional();

export const mcpReadOnlyToolAllowlistSchema = z
  .array(
    z
      .string()
      .max(256)
      .refine((name) => name.trim().length > 0, "Tool names cannot be empty."),
  )
  .max(100)
  .refine((names) => new Set(names).size === names.length, "Tool names must be unique.")
  .optional();

export const modelCostSchema = z
  .object({
    input: z.number().min(0).optional(),
    output: z.number().min(0).optional(),
    cacheRead: z.number().min(0).optional(),
    cacheWrite: z.number().min(0).optional(),
  })
  .optional();

/** ~10 MB of raw image bytes once base64-decoded. */
export const MAX_ATTACHMENT_BASE64_CHARS = 14_000_000;

export const promptImageAttachmentSchema = z.object({
  type: z.literal("image"),
  data: z.string().min(1).max(MAX_ATTACHMENT_BASE64_CHARS),
  mimeType: z.string().regex(/^image\/[\w.+-]+$/),
  name: z.string().max(256).optional(),
});

export const skillSelectionSchema = z.object({
  name: nonEmptyString,
  path: nonEmptyString,
});

export const hexColor = z.string().trim().min(1).max(64);

/**
 * Open a workspace file in the OS default app. `path` is the tool's reported
 * path (relative to cwd or absolute); the handler resolves + sandboxes it.
 */
export const fileOpenSchema = z.object({
  cwd: nonEmptyString,
  path: nonEmptyString,
});

/** Recent commit history for the All commits scope. */
export const gitLogSchema = z.object({
  cwd: nonEmptyString,
  limit: z.number().int().positive().max(500).optional(),
});

export const stringRecordSchema = z.record(z.string(), z.string());

export const restoreIdSchema = z.string().min(1).max(256);

export const restorePanelSchema = {
  open: z.boolean(),
  width: z.number().finite().min(0).max(4096),
};

export const restoreDraftSchema = z
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

export function jsonByteLength(value: unknown): number {
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

export const providerCompatibilitySchema = z.object({
  supportsDeveloperRole: z.boolean().optional(),
  supportsReasoningEffort: z.boolean().optional(),
});

export const modelCompatibilitySchema = z.object({
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

/** PNG bytes from renderer canvas.encode — Uint8Array survives Electron IPC clone. */
export const pngBytesSchema = z.custom<Uint8Array>(
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

/* ── Agents (agents:*) ─────────────────────────────────────────────────── */

export const agentIdString = nonEmptyString.max(128);

export const agentFields = {
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

/** Cap on `roles` (the modal holds at most a few more than the 10-member limit). */
export const MAX_PROFILE_ROLES = 32;

/* ── Agent Groups (group:*) ─────────────────────────────────────────────── */

export const groupIdString = nonEmptyString.max(128);

export const MAX_GROUP_MEMBERS = 32;

export const groupSessionIdString = nonEmptyString.max(128);

export const groupNameString = z.string().trim().min(1).max(120);

/** A NEW agent created in a group (group:create members, group:update-members adds). */
export const newGroupAgentSchema = z
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

/** Strict: the user deletes; a payload naming a session (a member acting) is refused. */
export const groupDeleteDecisionSchema = z.object({ decisionId: nonEmptyString.max(128) }).strict();

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

/** A room message body; long enough for pasted logs, bounded for the prompt budget. */
export const MAX_GROUP_MESSAGE_BODY = 20_000;

export const groupMessageCursorSchema = z
  .object({ createdAt: nonEmptyString.max(64), id: groupIdString })
  .strict();
