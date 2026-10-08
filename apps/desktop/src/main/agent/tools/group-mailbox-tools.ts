import {
  type AgentToolResult,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { isFeatureFlagEnabled } from "../harness/feature-flags";
import { GroupMailbox, type GroupMessage } from "../harness/groups/group-mailbox";
import { detectConflict, GroupRevisionRegistry } from "../harness/groups/group-revision";
import { toolRegistry } from "./registry";
import { resolveAgentToolContext } from "./tool-context";

export const GROUP_MAILBOX_SEND_TOOL = "group_mailbox_send";
export const GROUP_MAILBOX_RECEIVE_TOOL = "group_mailbox_receive";
export const GROUP_MAILBOX_ACK_TOOL = "group_mailbox_ack";
export const GROUP_REVISION_CHECK_TOOL = "group_revision_check";

export interface GroupMailboxSendArgs {
  to: string;
  content: string;
  revision?: number | undefined;
  groupId?: string | undefined;
}

export interface GroupMailboxReceiveArgs {
  limit?: number | undefined;
}

export interface GroupMailboxAckArgs {
  messageIds: string[];
}

export interface GroupRevisionCheckArgs {
  files: Record<string, string>;
  groupId?: string | undefined;
  baseRevision?: number | undefined;
}

/**
 * The PI tool `ctx` (ExtensionContext) carries no session identity. The owning
 * Modus session travels through AsyncLocalStorage instead, exactly like every
 * other shared tool (`resolveAgentToolContext`). Returning `undefined` when no
 * session is bound keeps the caller from silently routing messages into the
 * shared "unknown" mailbox, which no session can ever read.
 */
function resolveSenderIdentity(ctx: { cwd?: string }): {
  fromAgent: string;
  groupId: string;
} | null {
  try {
    const context = resolveAgentToolContext(ctx.cwd ?? "");
    if (!context.sessionId) return null;
    return {
      fromAgent: context.sessionId,
      groupId: context.groupId || "default",
    };
  } catch {
    return null;
  }
}

function noSessionResult(details: unknown): {
  content: { type: "text"; text: string }[];
  details: unknown;
} {
  return {
    content: [
      {
        type: "text",
        text: "Error: group mailbox has no owning Modus session for this call.",
      },
    ],
    details,
  };
}

export function handleGroupMailboxSend(
  args: GroupMailboxSendArgs,
  fromAgent: string,
  fallbackGroupId: string = "default",
): {
  success: boolean;
  messageId?: string | undefined;
  error?: string | undefined;
} {
  if (!args.to || typeof args.to !== "string") {
    return { success: false, error: "Missing required parameter 'to'." };
  }
  if (!args.content || typeof args.content !== "string") {
    return { success: false, error: "Missing required parameter 'content'." };
  }

  try {
    const mailbox = GroupMailbox.getInstance();
    const id = mailbox.send({
      groupId: args.groupId || fallbackGroupId,
      from: fromAgent,
      to: args.to,
      content: args.content,
      revision: args.revision ?? 1,
      sentAt: new Date().toISOString(),
    });

    return { success: true, messageId: id };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function handleGroupMailboxReceive(
  args: GroupMailboxReceiveArgs,
  agentId: string,
): {
  success: boolean;
  messages?: GroupMessage[] | undefined;
  count?: number | undefined;
  error?: string | undefined;
} {
  try {
    const mailbox = GroupMailbox.getInstance();
    const messages = mailbox.receive(agentId, args.limit ?? 50);
    return {
      success: true,
      messages,
      count: messages.length,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function handleGroupMailboxAck(
  args: GroupMailboxAckArgs,
  agentId: string,
): {
  success: boolean;
  ackedCount?: number | undefined;
  error?: string | undefined;
} {
  if (!Array.isArray(args.messageIds)) {
    return {
      success: false,
      error: "Parameter 'messageIds' must be an array of string IDs.",
    };
  }

  try {
    const mailbox = GroupMailbox.getInstance();
    let ackedCount = 0;
    for (const id of args.messageIds) {
      if (mailbox.ack(id, agentId)) {
        ackedCount++;
      }
    }

    return { success: true, ackedCount };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function handleGroupRevisionCheck(
  args: GroupRevisionCheckArgs,
  fallbackGroupId: string = "default",
): {
  conflict: boolean;
  conflicts: string[];
  currentRevision?: number | undefined;
} {
  const groupId = args.groupId || fallbackGroupId;
  const registry = GroupRevisionRegistry.getInstance();
  const current = registry.getRevision(groupId);

  if (!current) {
    return { conflict: false, conflicts: [] };
  }

  const agentRevision = {
    groupId,
    agentId: "check",
    revision: args.baseRevision ?? current.revision,
    files: args.files ?? {},
    updatedAt: new Date().toISOString(),
  };

  const conflicts = detectConflict(current, agentRevision);
  return {
    conflict: conflicts.length > 0,
    conflicts,
    currentRevision: current.revision,
  };
}

// --- Pi Coding Agent Tool Definitions ---

const sendParams = Type.Object({
  to: Type.String({ description: "Recipient agent ID or '*' for broadcast." }),
  content: Type.String({ description: "Message content body to send." }),
  revision: Type.Optional(Type.Number({ description: "Current workspace revision number." })),
  group_id: Type.Optional(Type.String({ description: "Optional group ID override." })),
});

export const groupMailboxSendTool: ToolDefinition<typeof sendParams> = defineTool({
  name: GROUP_MAILBOX_SEND_TOOL,
  label: "Send Group Mailbox Message",
  description:
    "Send a message to another agent in the group mailbox, or '*' to broadcast to all members.",
  parameters: sendParams,
  execute: async (_callId, params, _sig, _onUp, ctx) => {
    const identity = resolveSenderIdentity(ctx);
    if (!identity) {
      return noSessionResult({ success: false });
    }
    const result = handleGroupMailboxSend(
      {
        to: params.to,
        content: params.content,
        revision: params.revision,
        groupId: params.group_id ?? identity.groupId,
      },
      identity.fromAgent,
      identity.groupId,
    );

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Error sending message: ${result.error}` }],
        details: result,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Message sent successfully. ID: ${result.messageId}`,
        },
      ],
      details: result,
    };
  },
});

const receiveParams = Type.Object({
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of unread messages to receive. Default: 50.",
    }),
  ),
});

export const groupMailboxReceiveTool: ToolDefinition<typeof receiveParams> = defineTool({
  name: GROUP_MAILBOX_RECEIVE_TOOL,
  label: "Receive Group Mailbox Messages",
  description: "Receive unread messages delivered to this agent in the group mailbox.",
  parameters: receiveParams,
  execute: async (_callId, params, _sig, _onUp, ctx) => {
    const identity = resolveSenderIdentity(ctx);
    if (!identity) {
      return noSessionResult({ success: false });
    }
    const result = handleGroupMailboxReceive({ limit: params.limit }, identity.fromAgent);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Error receiving messages: ${result.error}` }],
        details: result,
      };
    }

    const msgs = result.messages ?? [];
    const summary = `Received ${msgs.length} unread message(s):\n${msgs
      .map((m) => `- [From ${m.from} at ${m.sentAt} (ID: ${m.id})]: ${m.content}`)
      .join("\n")}`;

    return {
      content: [{ type: "text", text: msgs.length > 0 ? summary : "No unread messages." }],
      details: result,
    };
  },
});

const ackParams = Type.Object({
  message_ids: Type.Array(Type.String(), {
    description: "Array of message IDs to acknowledge receipt of.",
  }),
});

export const groupMailboxAckTool: ToolDefinition<typeof ackParams> = defineTool({
  name: GROUP_MAILBOX_ACK_TOOL,
  label: "Acknowledge Group Mailbox Messages",
  description: "Acknowledge receipt of messages to remove them from unread inbox.",
  parameters: ackParams,
  execute: async (_callId, params, _sig, _onUp, ctx) => {
    const identity = resolveSenderIdentity(ctx);
    if (!identity) {
      return noSessionResult({ success: false });
    }
    const result = handleGroupMailboxAck({ messageIds: params.message_ids }, identity.fromAgent);

    if (!result.success) {
      return {
        content: [{ type: "text", text: `Error acking messages: ${result.error}` }],
        details: result,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Acknowledged ${result.ackedCount} message(s).`,
        },
      ],
      details: result,
    };
  },
});

const checkParams = Type.Object({
  files: Type.Record(Type.String(), Type.String(), {
    description: "Map of file relative paths to their content hashes.",
  }),
  base_revision: Type.Optional(Type.Number({ description: "Base revision number checked out." })),
  group_id: Type.Optional(Type.String({ description: "Group ID." })),
});

export const groupRevisionCheckTool: ToolDefinition<typeof checkParams> = defineTool({
  name: GROUP_REVISION_CHECK_TOOL,
  label: "Check Group Revision Conflicts",
  description:
    "Check proposed file changes against the latest group revision to detect optimistic concurrency conflicts.",
  parameters: checkParams,
  execute: async (_callId, params, _sig, _onUp, ctx) => {
    const groupId = params.group_id ?? resolveSenderIdentity(ctx)?.groupId ?? "default";
    const result = handleGroupRevisionCheck(
      {
        files: params.files,
        baseRevision: params.base_revision,
        groupId,
      },
      groupId,
    );

    if (result.conflict) {
      return {
        content: [
          {
            type: "text",
            text: `Conflict detected with revision ${result.currentRevision}! Conflicting files: ${result.conflicts.join(", ")}`,
          },
        ],
        details: result,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `No conflicts detected. Safe to merge (current revision: ${result.currentRevision ?? "initial"}).`,
        },
      ],
      details: result,
    };
  },
});

let registered = false;

export function registerGroupMailboxTools(): void {
  if (!isFeatureFlagEnabled("MODUS_GROUPS_MAILBOX")) {
    if (registered) {
      toolRegistry.unregisterTool(GROUP_MAILBOX_SEND_TOOL);
      toolRegistry.unregisterTool(GROUP_MAILBOX_RECEIVE_TOOL);
      toolRegistry.unregisterTool(GROUP_MAILBOX_ACK_TOOL);
      toolRegistry.unregisterTool(GROUP_REVISION_CHECK_TOOL);
      registered = false;
    }
    return;
  }
  if (registered) return;
  registered = true;

  toolRegistry.registerTool({
    entry: {
      name: GROUP_MAILBOX_SEND_TOOL,
      profiles: ["chat", "plan"],
      permission: { danger: "safe" },
      capabilities: ["write"],
      ui: { verb: "Send Group Mailbox Message" },
    },
    definition: groupMailboxSendTool,
  });

  toolRegistry.registerTool({
    entry: {
      name: GROUP_MAILBOX_RECEIVE_TOOL,
      profiles: ["chat", "plan"],
      permission: { danger: "safe" },
      capabilities: ["read"],
      readOnly: true,
      ui: { verb: "Receive Group Mailbox Messages" },
    },
    definition: groupMailboxReceiveTool,
  });

  toolRegistry.registerTool({
    entry: {
      name: GROUP_MAILBOX_ACK_TOOL,
      profiles: ["chat", "plan"],
      permission: { danger: "safe" },
      capabilities: ["write"],
      ui: { verb: "Acknowledge Group Mailbox Messages" },
    },
    definition: groupMailboxAckTool,
  });

  toolRegistry.registerTool({
    entry: {
      name: GROUP_REVISION_CHECK_TOOL,
      profiles: ["chat", "plan"],
      permission: { danger: "safe" },
      capabilities: ["read"],
      readOnly: true,
      ui: { verb: "Check Group Revision Conflicts" },
    },
    definition: groupRevisionCheckTool,
  });
}
