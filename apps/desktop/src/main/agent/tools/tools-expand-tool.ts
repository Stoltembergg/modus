import {
  type AgentToolResult,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { TOOLS_EXPAND_TOOL_NAME, TOOLS_EXPAND_TOOL_UI } from "../../../shared/tools";
import { toolRegistry } from "./registry";
import { resolveAgentToolContext } from "./tool-context";

/**
 * `tools_expand` (RERANK-03): while the local tool filter is on, a session
 * starts with core tools + this tool + the 8 tools the model ranked highest.
 * When the agent needs anything else it calls this once and every tool the
 * turn allows is exposed from its next step on (Pi refreshes the tool list
 * between steps). The session's set only grows, so the prompt cache holds.
 */
export type ToolsExpandOps = {
  /** Expose every allowed tool for this session; returns the names that were added. */
  expandSessionTools(sessionId: string): string[];
};

let ops: ToolsExpandOps | undefined;
let registered = false;

const params = Type.Object({
  reason: Type.String({ description: "Which capability is missing." }),
});

function toResult(text: string, added: string[]): AgentToolResult<{ added: string[] }> {
  return { content: [{ type: "text", text }], details: { added } };
}

const toolsExpandTool: ToolDefinition = defineTool({
  name: TOOLS_EXPAND_TOOL_NAME,
  label: "Expand tools",
  description:
    "Your tool list was narrowed for this session. If you need a tool that is not listed, call this once: every Modus tool becomes available from your next step on.",
  parameters: params,
  execute: async (_toolCallId, _input: Static<typeof params>, _signal, _onUpdate, ctx) => {
    const context = resolveAgentToolContext(ctx.cwd);
    if (!context.sessionId || !ops) {
      return toResult("Every tool is already available.", []);
    }
    const added = ops.expandSessionTools(context.sessionId);
    return toResult(
      added.length > 0
        ? `All tools are available now. Added: ${added.join(", ")}.`
        : "Every tool is already available.",
      added,
    );
  },
});

export function registerToolsExpandTool(nextOps: ToolsExpandOps): void {
  ops = nextOps;
  if (registered) return;
  registered = true;
  toolRegistry.registerTool({
    entry: {
      name: TOOLS_EXPAND_TOOL_NAME,
      profiles: ["chat", "review", "plan"],
      permission: { danger: "safe" },
      capabilities: [],
      ui: TOOLS_EXPAND_TOOL_UI,
    },
    definition: toolsExpandTool,
  });
}
