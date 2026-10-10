/**
 * Tool Result Spill Policy
 * Enforces empirical thresholds calibrated in Sprint 0.3 (20 KB / ~5,000 tokens)
 * to prevent massive command dumps from overwhelming context windows and SQLite storage.
 */

export interface ToolResultPolicy {
  /** Maximum bytes permitted before spilling to storage. Default: 20480 (20 KB). */
  spillThresholdBytes: number;
  /** Maximum lines permitted before spilling to storage. Default: 300 lines. */
  maxInlineLines: number;
  /** Number of leading lines to retain in the compact preview. Default: 40 lines. */
  previewHeadLines: number;
  /** Number of trailing lines to retain in the compact preview. Default: 40 lines. */
  previewTailLines: number;
  /** Maximum characters for leading preview when line count is small but bytes are large. Default: 1000. */
  previewHeadChars: number;
  /** Maximum characters for trailing preview when line count is small but bytes are large. Default: 1000. */
  previewTailChars: number;
}

export const DEFAULT_TOOL_RESULT_POLICY: ToolResultPolicy = {
  spillThresholdBytes: 20 * 1024, // 20 KB (~5,000 tokens)
  maxInlineLines: 300,
  previewHeadLines: 40,
  previewTailLines: 40,
  previewHeadChars: 1000,
  previewTailChars: 1000,
};

/**
 * Tool-specific policy overrides based on empirical transcript characteristics.
 */
export const TOOL_SPECIFIC_POLICIES: Record<string, Partial<ToolResultPolicy>> = {
  // Browser events can be enormous DOM/event dumps; spill aggressively at 10 KB
  browser_events: {
    spillThresholdBytes: 10 * 1024,
    maxInlineLines: 150,
  },
  // Fast codebase symbol indexing dumps
  fast_codebase: {
    spillThresholdBytes: 15 * 1024,
    maxInlineLines: 200,
  },
  // Terminal commands and bash scripts
  bash: {
    spillThresholdBytes: 20 * 1024,
    maxInlineLines: 250,
  },
  terminal_run: {
    spillThresholdBytes: 20 * 1024,
    maxInlineLines: 250,
  },
  // Grep searches across directories
  grep: {
    spillThresholdBytes: 20 * 1024,
    maxInlineLines: 250,
  },
  // File reads can reasonably accommodate larger continuous source code up to 30 KB
  read: {
    spillThresholdBytes: 30 * 1024,
    maxInlineLines: 500,
  },
  view_file: {
    spillThresholdBytes: 30 * 1024,
    maxInlineLines: 500,
  },
};

export interface ToolSpillEvaluation {
  shouldSpill: boolean;
  reason?: "byte_limit_exceeded" | "line_limit_exceeded" | undefined;
  sizeBytes: number;
  lineCount: number;
  policy: ToolResultPolicy;
}

/**
 * Evaluates whether a tool execution output should be spilled to storage.
 */
export function evaluateToolSpill(
  toolName: string,
  output: string,
  customPolicy?: Partial<ToolResultPolicy>,
): ToolSpillEvaluation {
  const toolOverride = TOOL_SPECIFIC_POLICIES[toolName] || {};
  const policy: ToolResultPolicy = {
    ...DEFAULT_TOOL_RESULT_POLICY,
    ...toolOverride,
    ...customPolicy,
  };

  const sizeBytes = Buffer.byteLength(output, "utf8");
  let lineCount = 1;
  for (const character of output) {
    if (character === "\n") lineCount += 1;
  }

  if (sizeBytes > policy.spillThresholdBytes) {
    return {
      shouldSpill: true,
      reason: "byte_limit_exceeded",
      sizeBytes,
      lineCount,
      policy,
    };
  }

  if (lineCount > policy.maxInlineLines) {
    return {
      shouldSpill: true,
      reason: "line_limit_exceeded",
      sizeBytes,
      lineCount,
      policy,
    };
  }

  return {
    shouldSpill: false,
    sizeBytes,
    lineCount,
    policy,
  };
}
