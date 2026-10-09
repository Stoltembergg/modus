import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isFeatureFlagEnabled } from "./harness/feature-flags";
import type {
  SpillAuthorizationContext,
  ToolResultStorage,
} from "./harness/tools/tool-result-storage";
import { interceptToolResult } from "./harness/tools/tool-spill-interceptor";

export interface ToolResultSpillEventResult {
  content?: ToolResultEvent["content"];
  details?: unknown;
  isError?: boolean;
}

export type ToolResultSpillHandler = (
  event: ToolResultEvent,
  signal: AbortSignal | undefined,
) => Promise<ToolResultSpillEventResult | undefined>;

/**
 * Builds the post-Repeat-Guard middleware used by the existing Pi permission
 * extension. It is a callback, not a second extension listener, so Pi sees one
 * ordered tool_result pipeline.
 */
export function createModusToolSpillHandler(
  expectedSessionId: string,
  resolveAuthorization: (event: ToolResultEvent) => SpillAuthorizationContext | undefined,
  onStorageFailure: () => void,
  storage?: ToolResultStorage,
): ToolResultSpillHandler {
  return async (event, signal) => {
    const reportStorageFailure = (): void => {
      try {
        onStorageFailure();
      } catch {
        // Diagnostics are best-effort; they must not alter the original result.
      }
    };
    // Consume the call-time authorization before any early return so non-text,
    // cancelled, and flag-disabled results cannot leave transient call state.
    let authorization: SpillAuthorizationContext | undefined;
    try {
      authorization = resolveAuthorization(event);
    } catch {
      reportStorageFailure();
      return undefined;
    }
    if (!isFeatureFlagEnabled("MODUS_TOOL_RESULT_SPILL") || signal?.aborted) {
      return undefined;
    }

    // Keep image and multi-block results byte-for-byte intact. The current
    // persisted format is deliberately text-only, so it cannot drop modalities.
    if (event.content.length !== 1 || event.content[0]?.type !== "text") {
      return undefined;
    }

    if (!authorization || authorization.sessionId !== expectedSessionId) {
      return undefined;
    }

    const textBlock = event.content[0];
    if (!textBlock || textBlock.type !== "text") return undefined;
    let result: ReturnType<typeof interceptToolResult>;
    try {
      result = interceptToolResult({
        ...authorization,
        toolName: event.toolName,
        output: textBlock.text,
        isError: event.isError,
        storage,
      });
    } catch {
      reportStorageFailure();
      return undefined;
    }
    if (result.failureCode) {
      reportStorageFailure();
      return undefined;
    }
    if (!result.spilled) return undefined;

    // Preserve TextContent annotations and all SDK error/details fields by
    // patching only its text while retaining the exact result metadata.
    return {
      content: [{ ...textBlock, text: result.effectiveContent }],
    };
  };
}
