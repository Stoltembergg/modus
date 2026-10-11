import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolRegistry } from "./registry";
import { type AgentToolContext, resolveAgentToolContext } from "./tool-context";

export const EXTERNAL_PLUGIN_INVOKE_TOOL = "external_plugin_invoke";

export type ExternalPluginInvokeInput = {
  pluginId: string;
  capability: string;
  payload: Record<string, unknown>;
  context: AgentToolContext;
  signal?: AbortSignal;
};

export type ExternalPluginToolOps = {
  invoke(input: ExternalPluginInvokeInput): Promise<unknown>;
};

let currentOps: ExternalPluginToolOps | undefined;
let registered = false;

const parameters = Type.Object({
  pluginId: Type.String({ minLength: 1, maxLength: 128 }),
  capability: Type.String({ minLength: 1, maxLength: 128 }),
  payload: Type.Record(Type.String(), Type.Unknown()),
});

const externalPluginInvokeTool: ToolDefinition = defineTool({
  name: EXTERNAL_PLUGIN_INVOKE_TOOL,
  label: "Call external plugin",
  description:
    "Invoke a host-installed external plugin capability. Each invocation requires explicit user approval and is blocked unless the isolated Linux supervisor admits it.",
  promptSnippet:
    "external_plugin_invoke(pluginId, capability, payload) — request an isolated plugin capability.",
  parameters,
  execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
    if (!currentOps) {
      throw new Error("External plugin execution is unavailable.");
    }
    const context = resolveAgentToolContext(ctx.cwd);
    const result = await currentOps.invoke({
      pluginId: params.pluginId,
      capability: params.capability,
      payload: params.payload,
      context,
      ...(signal ? { signal } : {}),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: { pluginId: params.pluginId, capability: params.capability },
    };
  },
});

/** Register only when a host supplies an external catalog and enables isolation. */
export function registerExternalPluginTool(ops: ExternalPluginToolOps): void {
  currentOps = ops;
  if (registered) return;
  registered = true;
  toolRegistry.registerTool({
    entry: {
      name: EXTERNAL_PLUGIN_INVOKE_TOOL,
      profiles: ["chat"],
      // The callback asks the permission broker itself before supervisor IPC.
      // Marking it safe here prevents a second, duplicate prompt in Pi's hook.
      permission: { danger: "safe", action: "mcp.call" },
      capabilities: ["write"],
      readOnly: false,
      ui: { verb: "Call plugin", primaryArgKey: "pluginId" },
    },
    definition: externalPluginInvokeTool,
  });
}

export function unregisterExternalPluginTool(): void {
  currentOps = undefined;
  if (!registered) return;
  registered = false;
  toolRegistry.unregisterTool(EXTERNAL_PLUGIN_INVOKE_TOOL);
}
