import { type SpillRetrievalOptions, ToolResultStorage } from "./tool-result-storage";

export interface RetrieveSpillArgs {
  spillId: string;
  offsetLine?: number | undefined;
  limitLines?: number | undefined;
}

/**
 * Tool execution handler for retrieving spilled tool results.
 */
export function handleRetrieveSpilledToolResult(
  args: RetrieveSpillArgs,
  storage: ToolResultStorage = ToolResultStorage.getInstance()
): {
  success: boolean;
  content?: string | undefined;
  error?: string | undefined;
  totalLines?: number | undefined;
  offsetLine?: number | undefined;
  linesReturned?: number | undefined;
  hasMore?: boolean | undefined;
} {
  if (!args.spillId || typeof args.spillId !== "string") {
    return {
      success: false,
      error: "Missing required parameter 'spillId'.",
    };
  }

  const retrievalOptions: SpillRetrievalOptions = {
    offsetLine: args.offsetLine,
    limitLines: args.limitLines,
  };

  const retrieved = storage.retrieveResult(args.spillId, retrievalOptions);
  if (!retrieved) {
    return {
      success: false,
      error: `Spilled result '${args.spillId}' not found. It may have expired or belongs to another session.`,
    };
  }

  return {
    success: true,
    content: retrieved.content,
    totalLines: retrieved.totalLines,
    offsetLine: retrieved.offsetLine,
    linesReturned: retrieved.linesReturned,
    hasMore: retrieved.hasMore,
  };
}
