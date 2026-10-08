import {
  type AgentToolResult,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { isFeatureFlagEnabled } from "../harness/feature-flags";
import { handleRetrieveSpilledToolResult } from "../harness/tools/retrieve-spill-tool";
import { toolRegistry } from "./registry";

export const RETRIEVE_SPILL_TOOL_NAME = "retrieve_spilled_tool_result";

const retrieveSpillParams = Type.Object({
  spill_id: Type.String({
    description: "The spill identifier (e.g. 'spill-abc123xyz') returned when a previous tool output was truncated.",
  }),
  offset_line: Type.Optional(
    Type.Number({
      description: "0-indexed starting line number to retrieve. Default: 0.",
    }),
  ),
  limit_lines: Type.Optional(
    Type.Number({
      description: "Maximum number of lines to return. Default: all remaining lines.",
    }),
  ),
});

type RetrieveSpillParams = Static<typeof retrieveSpillParams>;

export const retrieveSpillTool: ToolDefinition<typeof retrieveSpillParams> = defineTool({
  name: RETRIEVE_SPILL_TOOL_NAME,
  label: "Retrieve Spilled Tool Result",
  description:
    "Retrieve the full or windowed content of a large tool result that was spilled to storage to preserve context window. Provide spill_id and optional offset_line/limit_lines.",
  parameters: retrieveSpillParams,
  execute: async (
    _toolCallId,
    params: RetrieveSpillParams,
    _signal,
    _onUpdate,
    _ctx,
  ): Promise<AgentToolResult<unknown>> => {
    const result = handleRetrieveSpilledToolResult({
      spillId: params.spill_id,
      offsetLine: params.offset_line,
      limitLines: params.limit_lines,
    });

    if (!result.success || result.content === undefined) {
      return {
        content: [{ type: "text", text: result.error ?? `Error: Spilled result with id '${params.spill_id}' not found.` }],
        details: { success: false, spillId: params.spill_id },
      };
    }

    const offset = result.offsetLine ?? 0;
    const count = result.linesReturned ?? 0;
    const total = result.totalLines ?? 0;
    const header = `[Spilled tool output, lines ${offset + 1}-${offset + count} of ${total}${result.hasMore ? " (more available)" : ""}]`;
    const text = `${header}\n\n${result.content}`;

    return {
      content: [{ type: "text", text }],
      details: result,
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
