import { isFeatureFlagEnabled } from "../feature-flags";
import { evaluateToolSpill, type ToolResultPolicy } from "./tool-result-policy";
import { generateSpillPreview } from "./tool-result-preview";
import { type SpilledToolResult, ToolResultStorage } from "./tool-result-storage";

export interface ToolSpillInterceptInput {
  sessionId: string;
  runId: string;
  toolName: string;
  output: string;
  customPolicy?: Partial<ToolResultPolicy> | undefined;
  storage?: ToolResultStorage | undefined;
}

export interface ToolSpillInterceptResult {
  spilled: boolean;
  effectiveContent: string;
  spillRecord?: SpilledToolResult | undefined;
  spillId?: string | undefined;
  originalBytes: number;
  effectiveBytes: number;
  bytesSaved: number;
}

/**
 * Intercepts tool execution outputs and spills large results to storage
 * when MODUS_TOOL_RESULT_SPILL is enabled.
 */
export function interceptToolResult(input: ToolSpillInterceptInput): ToolSpillInterceptResult {
  const originalBytes = Buffer.byteLength(input.output, "utf8");

  // If feature flag is disabled, return untouched output
  if (!isFeatureFlagEnabled("MODUS_TOOL_RESULT_SPILL")) {
    return {
      spilled: false,
      effectiveContent: input.output,
      originalBytes,
      effectiveBytes: originalBytes,
      bytesSaved: 0,
    };
  }

  const evaluation = evaluateToolSpill(input.toolName, input.output, input.customPolicy);

  if (!evaluation.shouldSpill) {
    return {
      spilled: false,
      effectiveContent: input.output,
      originalBytes,
      effectiveBytes: originalBytes,
      bytesSaved: 0,
    };
  }

  const storage = input.storage ?? ToolResultStorage.getInstance();
  const spillRecord = storage.spillResult({
    sessionId: input.sessionId,
    runId: input.runId,
    toolName: input.toolName,
    content: input.output,
    metadata: {
      spillReason: evaluation.reason,
      lineCount: evaluation.lineCount,
    },
  });

  const preview = generateSpillPreview(spillRecord, evaluation.policy);
  const effectiveBytes = Buffer.byteLength(preview, "utf8");
  const bytesSaved = Math.max(0, originalBytes - effectiveBytes);

  return {
    spilled: true,
    effectiveContent: preview,
    spillRecord,
    spillId: spillRecord.id,
    originalBytes,
    effectiveBytes,
    bytesSaved,
  };
}
