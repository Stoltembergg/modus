import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getActiveAgentRun } from "./agent-run-store";
import { isFeatureFlagEnabled } from "./harness/feature-flags";
import { interceptToolResult } from "./harness/tools/tool-spill-interceptor";

/**
 * PI SDK Extension Factory that intercepts tool results and spills large outputs (>20KB)
 * to disk storage, injecting compact previews into the LLM context.
 */
export function createModusToolSpillExtension(sessionId: string): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", async (event) => {
      if (!isFeatureFlagEnabled("MODUS_TOOL_RESULT_SPILL")) {
        return undefined;
      }

      const textBlockIndex = event.content.findIndex((c) => c.type === "text");
      if (textBlockIndex === -1) {
        return undefined;
      }

      const textBlock = event.content[textBlockIndex] as { type: "text"; text: string };
      const rawText = textBlock.text;
      const run = getActiveAgentRun(sessionId);
      const runId = run?.id ?? "unknown-run";

      const intercept = interceptToolResult({
        sessionId,
        runId,
        toolName: event.toolName,
        output: rawText,
      });

      if (!intercept.spilled) {
        return undefined;
      }

      const updatedContent = [...event.content];
      updatedContent[textBlockIndex] = {
        type: "text",
        text: intercept.effectiveContent,
      };

      return {
        content: updatedContent,
      };
    });
  };
}
