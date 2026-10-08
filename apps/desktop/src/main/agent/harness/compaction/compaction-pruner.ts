/**
 * Compaction Turn Pruner:
 * Identifies and prunes redundant tool results, noisy CLI logs,
 * superseded file reads, and searches prior to full session compaction.
 */

export type PruneCandidateType = "log" | "search" | "read" | "tool_result";

export type PruneCandidate = {
  id: string; // Identifier of the message or tool result
  type: PruneCandidateType;
  toolName?: string | undefined;
  path?: string | undefined;
  summary: string;
  sizeBytes: number;
  estimatedTokens: number;
  timestamp: number;
  superseded: boolean;
  canPrune: boolean;
  content: string;
};

export type PruneResult = {
  prunedIds: string[];
  savedBytes: number;
  savedTokens: number;
  replacements: Map<string, string>; // id -> tombstone text
};

export type MessageLike = {
  id: string;
  role: "user" | "assistant" | "tool" | "toolResult" | "system";
  content: string | Array<{ type: string; text?: string; [key: string]: any }>;
  toolName?: string | undefined;
  timestamp?: number | undefined;
};

/**
 * Estimates token count from text using standard ~4 chars per token approximation.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * True when the message is a tool-originated payload (result / log / search output).
 * User and assistant text must never be replaced by a tombstone: only tool output
 * that the session storage retains verbatim is safe to prune.
 */
function isToolOriginated(msg: MessageLike): boolean {
  if (msg.role === "tool" || msg.role === "toolResult") {
    return true;
  }
  if (msg.role === "user" || msg.role === "system") return false;
  return Boolean(msg.toolName);
}

/**
 * Analyzes conversation messages to identify prune candidates.
 */
export function identifyPruneCandidates(
  messages: MessageLike[],
  options?: {
    minCandidateBytes?: number | undefined; // Only consider items > minCandidateBytes (default 1024)
    neverPrunePaths?: string[] | undefined;
  },
): PruneCandidate[] {
  const minBytes = options?.minCandidateBytes ?? 1024;
  const neverPrune = new Set(options?.neverPrunePaths ?? []);
  const candidates: PruneCandidate[] = [];

  // Track file paths that were edited or read
  const filesTouched = new Map<string, number[]>(); // path -> turn indices
  const searchQueries = new Map<string, number[]>(); // query -> turn indices

  // Pass 1: Gather file accesses and search executions
  messages.forEach((msg, idx) => {
    const rawText =
      typeof msg.content === "string"
        ? msg.content
        : msg.content.map((c) => c.text ?? "").join("\n");

    const toolName = msg.toolName ?? "";

    if (toolName.includes("read") || toolName.includes("view")) {
      const match = rawText.match(/(?:path|file|target)[:=]\s*["']?([^"'\n]+)/i);
      if (match?.[1]) {
        const p = match[1].trim();
        const list = filesTouched.get(p) ?? [];
        list.push(idx);
        filesTouched.set(p, list);
      }
    } else if (
      toolName.includes("grep") ||
      toolName.includes("search") ||
      toolName.includes("find")
    ) {
      const match = rawText.match(/(?:query|pattern)[:=]\s*["']?([^"'\n]+)/i);
      const q = match?.[1]?.trim() ?? toolName;
      const list = searchQueries.get(q) ?? [];
      list.push(idx);
      searchQueries.set(q, list);
    }
  });

  // Pass 2: Evaluate messages for pruning suitability
  messages.forEach((msg, idx) => {
    if (!isToolOriginated(msg)) return;

    const rawText =
      typeof msg.content === "string"
        ? msg.content
        : msg.content.map((c) => c.text ?? "").join("\n");

    const sizeBytes = Buffer.byteLength(rawText, "utf8");
    if (sizeBytes < minBytes) return;

    const toolName = msg.toolName ?? "";
    let candidateType: PruneCandidateType = "tool_result";
    let superseded = false;
    let path: string | undefined = undefined;

    if (
      toolName.includes("run_command") ||
      toolName.includes("terminal") ||
      toolName.includes("bash")
    ) {
      candidateType = "log";
      // Command outputs older than recent turns are prime pruning candidates
      superseded = idx < messages.length - 4;
    } else if (
      toolName.includes("grep") ||
      toolName.includes("find") ||
      toolName.includes("search")
    ) {
      candidateType = "search";
      // If same search was run later, or later turns exist
      superseded = idx < messages.length - 4;
    } else if (toolName.includes("read") || toolName.includes("view")) {
      candidateType = "read";
      const match = rawText.match(/(?:path|file|target)[:=]\s*["']?([^"'\n]+)/i);
      path = match?.[1]?.trim();
      if (path && neverPrune.has(path)) return;
      // If file was read multiple times, earlier reads are superseded
      const touches = path ? (filesTouched.get(path) ?? []) : [];
      superseded = touches.some((t) => t > idx);
    }

    const estimatedTokens = estimateTokens(rawText);

    candidates.push({
      id: msg.id,
      type: candidateType,
      ...(toolName ? { toolName } : {}),
      ...(path ? { path } : {}),
      summary: `${toolName || msg.role} (${sizeBytes} bytes, ~${estimatedTokens} tokens)`,
      sizeBytes,
      estimatedTokens,
      timestamp: msg.timestamp ?? Date.now(),
      superseded,
      canPrune: true,
      content: rawText,
    });
  });

  return candidates;
}

/**
 * Prunes selected candidates up to target token budget.
 * Priority order:
 * 1. Redundant search outputs
 * 2. Superseded command logs
 * 3. Superseded file reads
 * 4. General tool results
 */
export function pruneCandidates(
  candidates: PruneCandidate[],
  targetTokensToSave: number,
): PruneResult {
  const priorityScore = (c: PruneCandidate): number => {
    let score = 0;
    if (c.superseded) score += 100;
    if (c.type === "search") score += 40;
    if (c.type === "log") score += 30;
    if (c.type === "read") score += 20;
    if (c.type === "tool_result") score += 10;
    score += Math.min(50, Math.floor(c.estimatedTokens / 500));
    return score;
  };

  // Sort descending by priority (highest score pruned first)
  const sorted = [...candidates].sort((a, b) => priorityScore(b) - priorityScore(a));

  const prunedIds: string[] = [];
  let savedBytes = 0;
  let savedTokens = 0;
  const replacements = new Map<string, string>();

  for (const candidate of sorted) {
    if (savedTokens >= targetTokensToSave && targetTokensToSave > 0) {
      break;
    }

    const tombstone = `[Pruned superseded ${candidate.type} output: ${candidate.summary}. Raw content retained in session storage.]`;
    const tombstoneTokens = estimateTokens(tombstone);
    const netTokenSavings = Math.max(0, candidate.estimatedTokens - tombstoneTokens);

    prunedIds.push(candidate.id);
    savedBytes += Math.max(0, candidate.sizeBytes - Buffer.byteLength(tombstone, "utf8"));
    savedTokens += netTokenSavings;
    replacements.set(candidate.id, tombstone);
  }

  return {
    prunedIds,
    savedBytes,
    savedTokens,
    replacements,
  };
}
