import type { CompactionEvidenceCategory } from "./compaction-policy";

/**
 * Structured Evidence Item extracted from conversation history or agent events.
 */
export type PreservedEvidence = {
  id: string;
  category: CompactionEvidenceCategory;
  timestamp: number;
  summary: string;
  details?: Record<string, any> | undefined;
  tags?: string[] | undefined;
};

/**
 * Rule configuration for preserving specific evidence categories.
 */
export type EvidencePreservationRule = {
  category: CompactionEvidenceCategory;
  preserveAll: boolean; // Preserves all occurrences if true
  maxCount?: number | undefined; // Keeps only the most recent N items if preserveAll is false
  includeDetails?: boolean | undefined;
};

export const DEFAULT_EVIDENCE_RULES: Record<CompactionEvidenceCategory, EvidencePreservationRule> =
  {
    qa_check: {
      category: "qa_check",
      preserveAll: true,
      includeDetails: true,
    },
    harness_decision: {
      category: "harness_decision",
      preserveAll: false,
      maxCount: 10,
      includeDetails: true,
    },
    plan_acceptance: {
      category: "plan_acceptance",
      preserveAll: true,
      includeDetails: true,
    },
    checkpoint: {
      category: "checkpoint",
      preserveAll: false,
      maxCount: 5,
      includeDetails: false,
    },
    failure_attempt: {
      category: "failure_attempt",
      preserveAll: false,
      maxCount: 15,
      includeDetails: true,
    },
    user_confirmation: {
      category: "user_confirmation",
      preserveAll: true,
      includeDetails: true,
    },
  };

/**
 * Extracts and filters evidence items from a collection according to active preservation rules.
 */
export function filterPreservedEvidence(
  items: PreservedEvidence[],
  allowedCategories?: CompactionEvidenceCategory[],
  customRules?: Partial<Record<CompactionEvidenceCategory, EvidencePreservationRule>>,
): PreservedEvidence[] {
  const rules = { ...DEFAULT_EVIDENCE_RULES, ...(customRules ?? {}) };
  const categoriesToInclude = new Set<CompactionEvidenceCategory>(
    allowedCategories ?? (Object.keys(rules) as CompactionEvidenceCategory[]),
  );

  const grouped = new Map<CompactionEvidenceCategory, PreservedEvidence[]>();

  for (const item of items) {
    if (!categoriesToInclude.has(item.category)) continue;
    const list = grouped.get(item.category) ?? [];
    list.push(item);
    grouped.set(item.category, list);
  }

  const result: PreservedEvidence[] = [];

  for (const [cat, list] of grouped.entries()) {
    const rule = rules[cat];
    // Sort chronologically ascending
    list.sort((a, b) => a.timestamp - b.timestamp);

    if (rule.preserveAll || !rule.maxCount) {
      result.push(...list);
    } else {
      // Keep the most recent maxCount items
      result.push(...list.slice(-rule.maxCount));
    }
  }

  // Final chronological sort
  return result.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Formats preserved evidence into a markdown block suitable for injection into LLM compaction summaries.
 */
export function formatPreservedEvidenceMarkdown(evidence: PreservedEvidence[]): string {
  if (evidence.length === 0) return "";

  const sections: Record<CompactionEvidenceCategory, string[]> = {
    qa_check: [],
    harness_decision: [],
    plan_acceptance: [],
    checkpoint: [],
    failure_attempt: [],
    user_confirmation: [],
  };

  for (const item of evidence) {
    const timeStr = new Date(item.timestamp).toISOString().slice(11, 19);
    let line = `- [${timeStr}] ${item.summary}`;
    if (item.details && Object.keys(item.details).length > 0) {
      const detailStr = Object.entries(item.details)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(", ");
      line += ` (${detailStr})`;
    }
    sections[item.category].push(line);
  }

  const output: string[] = ["### Preserved Harness Evidence (Pre-Compaction Integrity)"];

  if (sections.plan_acceptance.length > 0) {
    output.push("#### Plan & Specifications Accepted:");
    output.push(...sections.plan_acceptance);
  }

  if (sections.qa_check.length > 0) {
    output.push("#### QA Checks & Verification Results:");
    output.push(...sections.qa_check);
  }

  if (sections.user_confirmation.length > 0) {
    output.push("#### User Confirmations & Clearances:");
    output.push(...sections.user_confirmation);
  }

  if (sections.harness_decision.length > 0) {
    output.push("#### Key Architectural & Harness Decisions:");
    output.push(...sections.harness_decision);
  }

  if (sections.failure_attempt.length > 0) {
    output.push("#### Known Failures & Guard Warnings:");
    output.push(...sections.failure_attempt);
  }

  if (sections.checkpoint.length > 0) {
    output.push("#### Checkpoints:");
    output.push(...sections.checkpoint);
  }

  return output.join("\n\n");
}
