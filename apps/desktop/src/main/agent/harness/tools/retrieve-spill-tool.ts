import {
  type SpillAuthorizationContext,
  type SpillRetrievalOptions,
  TOOL_RESULT_SPILL_LIMITS,
  ToolResultStorage,
  ToolResultStorageError,
} from "./tool-result-storage";

export interface RetrieveSpillArgs {
  spillId: string;
  offsetLine?: number | undefined;
  offsetByte?: number | undefined;
  limitLines?: number | undefined;
  maxBytes?: number | undefined;
}

export interface RetrieveSpillResponse {
  success: boolean;
  content?: string | undefined;
  error?: string | undefined;
  spillId?: string | undefined;
  toolName?: string | undefined;
  originalWasError?: boolean | undefined;
  totalLines?: number | undefined;
  offsetLine?: number | undefined;
  linesReturned?: number | undefined;
  hasMore?: boolean | undefined;
  nextOffsetLine?: number | undefined;
  nextOffsetByte?: number | undefined;
  maxBytes?: number | undefined;
}

/**
 * Retrieves a bounded window from the existing durable tool-result table.
 * The authorization context is derived by the host, never from tool arguments.
 */
export function handleRetrieveSpilledToolResult(
  args: RetrieveSpillArgs,
  authorization: SpillAuthorizationContext,
  storage: ToolResultStorage = ToolResultStorage.getInstance(),
): RetrieveSpillResponse {
  if (!args.spillId || typeof args.spillId !== "string") {
    return {
      success: false,
      error: "Missing required parameter 'spill_id'.",
    };
  }

  const maxBytes = args.maxBytes ?? TOOL_RESULT_SPILL_LIMITS.defaultRecoveryBytes;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > TOOL_RESULT_SPILL_LIMITS.maxRecoveryBytes
  ) {
    return {
      success: false,
      error: "Invalid max_bytes. Use a value from 1024 through 32768.",
    };
  }

  // Reserve room for the fixed model-facing cursor/status header.
  const retrievalOptions: SpillRetrievalOptions = {
    offsetLine: args.offsetLine,
    offsetByte: args.offsetByte,
    limitLines: args.limitLines,
    maxBytes: maxBytes - 256,
  };

  try {
    const retrieved = storage.retrieveResult(args.spillId, authorization, retrievalOptions);
    if (!retrieved) {
      return {
        success: false,
        error: "Spilled result is unavailable to this session or workspace, or it has expired.",
      };
    }

    return {
      success: true,
      content: retrieved.content,
      spillId: retrieved.spill.id,
      toolName: retrieved.spill.toolName,
      originalWasError: retrieved.spill.isError,
      totalLines: retrieved.totalLines,
      offsetLine: retrieved.offsetLine,
      linesReturned: retrieved.linesReturned,
      hasMore: retrieved.hasMore,
      nextOffsetLine: retrieved.nextOffsetLine,
      nextOffsetByte: retrieved.nextOffsetByte,
      maxBytes,
    };
  } catch (error) {
    if (error instanceof ToolResultStorageError && error.code === "invalid_content") {
      return {
        success: false,
        error: "Invalid spill retrieval limits. Use bounded line and byte windows.",
      };
    }
    return {
      success: false,
      error: "Spilled result could not be read from durable storage.",
    };
  }
}
