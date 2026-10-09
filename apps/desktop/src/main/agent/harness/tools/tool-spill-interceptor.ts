import { isFeatureFlagEnabled } from "../feature-flags";
import { evaluateToolSpill, type ToolResultPolicy } from "./tool-result-policy";
import { generateSpillPreview } from "./tool-result-preview";
import {
  type SpilledToolResult,
  ToolResultStorage,
  ToolResultStorageError,
  type ToolResultStorageErrorCode,
} from "./tool-result-storage";

export interface ToolSpillInterceptInput {
  sessionId: string;
  runId: string;
  workspaceId: string;
  toolName: string;
  output: string;
  isError?: boolean | undefined;
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
  failureCode?: ToolResultStorageErrorCode | "preview_failed" | undefined;
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
  let spillRecord: SpilledToolResult;
  try {
    spillRecord = storage.spillResult({
      sessionId: input.sessionId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      content: input.output,
      spillReason: evaluation.reason ?? "byte_limit_exceeded",
      isError: input.isError,
    });
  } catch (error) {
    return {
      spilled: false,
      effectiveContent: input.output,
      originalBytes,
      effectiveBytes: originalBytes,
      bytesSaved: 0,
      failureCode: error instanceof ToolResultStorageError ? error.code : "storage_unavailable",
    };
  }

  try {
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
  } catch {
    return {
      spilled: false,
      effectiveContent: input.output,
      originalBytes,
      effectiveBytes: originalBytes,
      bytesSaved: 0,
      failureCode: "preview_failed",
    };
  }
}
