/**
 * Patterns matching critical content that MUST NEVER be truncated or omitted
 * by response formatting, regardless of policy limits (Mitigation for RISCO 4).
 */
const CRITICAL_PATTERNS: RegExp[] = [
  /\b(?:errors?|fatal|exceptions?|crash(?:es)?|panic|fails?|failed|failures?)\b/i,
  /\b(?:blockers?|blocked|action required|must resolve|intervention needed)\b/i,
  /\b(?:breaking changes?|regressions?|security vulnerability|cve)\b/i,
  /\b(?:typecheck errors?|syntax errors?|compilation errors?|build failures?)\b/i,
  /\b(?:verification failed|check failed|assertion error)\b/i,
  /\[!(?:caution|warning|important)\]/i,
];

/**
 * Checks whether a paragraph contains critical information that must be preserved.
 */
export function isCriticalParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  if (!trimmed) return false;
  return CRITICAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export type ExtractedSections = {
  conclusion?: string | undefined;
  importantChanges?: string | undefined;
  verification?: string | undefined;
  blockers?: string | undefined;
  warnings?: string | undefined;
  criticalParagraphs: string[];
  standardParagraphs: string[];
};

/**
 * Splits text into paragraphs separated by double newlines or markdown block divisions.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Extracts semantic sections and classifies paragraphs into critical and standard.
 */
export function extractSections(text: string): ExtractedSections {
  const paragraphs = splitParagraphs(text);
  const criticalParagraphs: string[] = [];
  const standardParagraphs: string[] = [];

  let conclusion: string | undefined;
  let importantChanges: string | undefined;
  let verification: string | undefined;
  let blockers: string | undefined;
  let warnings: string | undefined;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    if (!para) continue;

    const isCrit = isCriticalParagraph(para);
    if (isCrit) {
      criticalParagraphs.push(para);
    } else {
      standardParagraphs.push(para);
    }

    const lower = para.toLowerCase();

    // Semantic category heuristics
    if (
      !blockers &&
      (lower.includes("blocker") ||
        lower.includes("action required") ||
        lower.includes("blocked by"))
    ) {
      blockers = para;
    } else if (
      !warnings &&
      (lower.includes("warning") || lower.includes("caution") || lower.includes("alert"))
    ) {
      warnings = para;
    } else if (
      !verification &&
      (lower.includes("verification") ||
        lower.includes("test") ||
        lower.includes("typecheck") ||
        lower.includes("status"))
    ) {
      verification = para;
    } else if (i === 0 && !conclusion) {
      // First paragraph is treated as conclusion/summary if not blocker/warning
      conclusion = para;
    } else if (
      !importantChanges &&
      (lower.includes("change") ||
        lower.includes("implement") ||
        lower.includes("modified") ||
        lower.includes("added"))
    ) {
      importantChanges = para;
    } else if (!conclusion) {
      conclusion = para;
    }
  }

  return {
    conclusion,
    importantChanges,
    verification,
    blockers,
    warnings,
    criticalParagraphs,
    standardParagraphs,
  };
}
