import {
  type AgentToolResult,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { isFeatureFlagEnabled } from "../harness/feature-flags";
import { TOOL_RESULT_SPILL_LIMITS } from "../harness/tools/tool-result-storage";
import { handleRetrieveSpilledToolResult } from "../harness/tools/retrieve-spill-tool";
import { resolveAgentToolContext } from "./tool-context";
import { toolRegistry } from "./registry";

export const RETRIEVE_SPILL_TOOL_NAME = "retrieve_spilled_tool_result";

const retrieveSpillParams = Type.Object({
  spill_id: Type.String({
    description:
      "The spill identifier (e.g. 'spill-abc123xyz') returned when a previous tool output was truncated.",
  }),
  offset_line: Type.Optional(
    Type.Integer({
      description: "0-indexed starting line number to retrieve. Default: 0.",
      minimum: 0,
    }),
  ),
  offset_byte: Type.Optional(
    Type.Integer({
      description:
        "Absolute UTF-8 byte offset to continue a long line. Use instead of offset_line.",
      minimum: 0,
    }),
  ),
  limit_lines: Type.Optional(
    Type.Integer({
      description: `Maximum number of lines to return. Default: ${TOOL_RESULT_SPILL_LIMITS.defaultRecoveryLines}; maximum: ${TOOL_RESULT_SPILL_LIMITS.maxRecoveryLines}.`,
      minimum: 1,
      maximum: TOOL_RESULT_SPILL_LIMITS.maxRecoveryLines,
    }),
  ),
  max_bytes: Type.Optional(
    Type.Integer({
      description: `Maximum total response bytes including metadata. Default: ${TOOL_RESULT_SPILL_LIMITS.defaultRecoveryBytes}; maximum: ${TOOL_RESULT_SPILL_LIMITS.maxRecoveryBytes}.`,
      minimum: 1024,
      maximum: TOOL_RESULT_SPILL_LIMITS.maxRecoveryBytes,
    }),
  ),
});

type RetrieveSpillParams = Static<typeof retrieveSpillParams>;

export const retrieveSpillTool: ToolDefinition<typeof retrieveSpillParams> = defineTool({
  name: RETRIEVE_SPILL_TOOL_NAME,
  label: "Retrieve Spilled Tool Result",
  description:
    "Retrieve a bounded window of a large tool result spilled to storage. Provide spill_id and optional offset_line or offset_byte, limit_lines, and max_bytes.",
  parameters: retrieveSpillParams,
  execute: async (
    _toolCallId,
    params: RetrieveSpillParams,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<unknown>> => {
    if (!isFeatureFlagEnabled("MODUS_TOOL_RESULT_SPILL")) {
      return {
        content: [{ type: "text", text: "Tool result spill is disabled for this runtime." }],
        details: { success: false },
      };
    }

    const owner = resolveAgentToolContext(ctx.cwd);
    if (!owner.runId) {
      return {
        content: [{ type: "text", text: "Spill retrieval is unavailable without an active run." }],
        details: { success: false },
      };
    }

    const result = handleRetrieveSpilledToolResult({
      spillId: params.spill_id,
      offsetLine: params.offset_line,
      offsetByte: params.offset_byte,
      limitLines: params.limit_lines,
      maxBytes: params.max_bytes,
    }, {
      sessionId: owner.sessionId,
      runId: owner.runId,
      workspaceId: owner.workspaceId,
    });

    if (!result.success || result.content === undefined) {
      return {
        content: [
          {
            type: "text",
            text: result.error ?? `Error: Spilled result with id '${params.spill_id}' not found.`,
          },
        ],
        details: { success: false, spillId: params.spill_id },
      };
    }

    const offset = result.offsetLine ?? 0;
    const count = result.linesReturned ?? 0;
    const total = result.totalLines ?? 0;
    const maxBytes = result.maxBytes ?? TOOL_RESULT_SPILL_LIMITS.defaultRecoveryBytes;
    const header = `[Spilled output lines ${offset + 1}-${offset + count} of ${total}; more=${Boolean(result.hasMore)}; next_offset_byte=${result.nextOffsetByte ?? 0}; original_error=${Boolean(result.originalWasError)}]`;
    const text = `${header}\n\n${result.content}`;
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      return {
        content: [{ type: "text", text: "Spilled result exceeds the configured response limit." }],
        details: { success: false },
      };
    }

    return {
      content: [{ type: "text", text }],
      details: {
        success: true,
        spillId: result.spillId,
        totalLines: result.totalLines,
        offsetLine: result.offsetLine,
        linesReturned: result.linesReturned,
        hasMore: result.hasMore,
        nextOffsetLine: result.nextOffsetLine,
        nextOffsetByte: result.nextOffsetByte,
        maxBytes: result.maxBytes,
        originalWasError: result.originalWasError,
      },
    };
  },
});

let registered = false;

export function registerSpillTools(): void {
  if (!isFeatureFlagEnabled("MODUS_TOOL_RESULT_SPILL")) {
    if (registered) {
      toolRegistry.unregisterTool(RETRIEVE_SPILL_TOOL_NAME);
      registered = false;
    }
    return;
  }
  if (registered) {
    return;
  }
  registered = true;
  toolRegistry.registerTool({
    entry: {
      name: RETRIEVE_SPILL_TOOL_NAME,
      profiles: ["chat", "plan"],
      permission: { danger: "safe" },
      capabilities: ["read"],
      ui: {
        verb: "Spilled Result",
        activeVerb: "Retrieving Spilled Result",
        primaryArgKey: "spill_id",
        render: "flat",
      },
    },
    definition: retrieveSpillTool,
  });
}
