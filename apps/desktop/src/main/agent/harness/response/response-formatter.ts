import type { Deliverable } from "./deliverables";
import { formatDeliverables } from "./deliverables";
import type {
  ResponseEnforcementMode,
  ResponsePolicy,
} from "./response-policy";
import {
  extractSections,
  isCriticalParagraph,
  splitParagraphs,
} from "./response-sections";

export type EnforceResult = {
  response: string;
  violated: boolean;
  reason?: string | undefined;
  originalParagraphCount: number;
  formattedParagraphCount: number;
  omittedParagraphCount: number;
  criticalPreservedCount: number;
};

/**
 * Enforces response bounds according to the configured ResponsePolicy and enforcement mode.
 *
 * Implements GAP 5 (Response Policy Enforcement) and mitigates RISCO 4 (Never truncates
 * critical sections such as errors, blockers, or failed verifications).
 */
export function enforceResponsePolicy(
  response: string,
  policy: ResponsePolicy,
  modeOverride?: ResponseEnforcementMode,
): EnforceResult {
  const mode = modeOverride ?? policy.enforcementMode;
  const paragraphs = splitParagraphs(response);
  const totalParas = paragraphs.length;

  // When policy has unlimited paragraphs or mode is "off", no enforcement needed
  if (policy.maxParagraphs <= 0 || mode === "off" || totalParas <= policy.maxParagraphs) {
    const criticalCount = paragraphs.filter(isCriticalParagraph).length;
    return {
      response,
      violated: false,
      originalParagraphCount: totalParas,
      formattedParagraphCount: totalParas,
      omittedParagraphCount: 0,
      criticalPreservedCount: criticalCount,
    };
  }

  // Violated: paragraphs exceed policy.maxParagraphs
  const violated = true;
  const reason = `exceeded_max_paragraphs (${totalParas} > ${policy.maxParagraphs})`;

  // Advisory mode: flags violation but does not alter content
  if (mode === "advisory") {
    const criticalCount = paragraphs.filter(isCriticalParagraph).length;
    return {
      response,
      violated: true,
      reason,
      originalParagraphCount: totalParas,
      formattedParagraphCount: totalParas,
      omittedParagraphCount: 0,
      criticalPreservedCount: criticalCount,
    };
  }

  // Strict mode: truncate surplus paragraphs, BUT ALWAYS PRESERVE CRITICAL PARAGRAPHS (RISCO 4)
  const criticalParagraphs = paragraphs.filter(isCriticalParagraph);
  const nonCriticalQuota = Math.max(
    0,
    policy.maxParagraphs - criticalParagraphs.length,
  );

  // Walk in original order and count kept non-critical paragraphs. A Set-based
  // filter kept *every* occurrence of a kept string, so a paragraph repeated N
  // times could blow past maxParagraphs and crowd out other content.
  const formattedParagraphs: string[] = [];
  let keptNonCritical = 0;
  for (const para of paragraphs) {
    if (isCriticalParagraph(para)) {
      formattedParagraphs.push(para);
    } else if (keptNonCritical < nonCriticalQuota) {
      formattedParagraphs.push(para);
      keptNonCritical++;
    }
  }

  const omittedCount = totalParas - formattedParagraphs.length;
  let formattedText = formattedParagraphs.join("\n\n");

  if (omittedCount > 0) {
    formattedText += `\n\n*[Response formatted by response policy (${omittedCount} non-critical paragraph${omittedCount > 1 ? "s" : ""} truncated)]*`;
  }

  return {
    response: formattedText,
    violated: true,
    reason,
    originalParagraphCount: totalParas,
    formattedParagraphCount: formattedParagraphs.length,
    omittedParagraphCount: omittedCount,
    criticalPreservedCount: criticalParagraphs.length,
  };
}

/**
 * Formats a message according to the active ResponsePolicy, incorporating deliverables
 * and semantic section filters.
 */
export function formatResponse(input: {
  message: string;
  policy: ResponsePolicy;
  deliverables?: Deliverable[] | undefined;
  modeOverride?: ResponseEnforcementMode | undefined;
}): {
  response: string;
  violated: boolean;
  reason?: string | undefined;
  deliverablesSummary?: string | undefined;
} {
  const { message, policy, deliverables, modeOverride } = input;

  let workingMessage = message;

  // Level "compact": extract only essential components
  if (policy.level === "compact") {
    const sections = extractSections(message);
    const compactPieces = [
      sections.conclusion,
      sections.importantChanges,
      sections.verification,
      sections.blockers,
      sections.warnings,
      ...sections.criticalParagraphs.filter(
        (cp) =>
          cp !== sections.conclusion &&
          cp !== sections.importantChanges &&
          cp !== sections.verification &&
          cp !== sections.blockers &&
          cp !== sections.warnings,
      ),
    ].filter((p): p is string => Boolean(p && p.trim()));

    if (compactPieces.length > 0) {
      // Deduplicate identical blocks
      workingMessage = Array.from(new Set(compactPieces)).join("\n\n");
    }
  }

  // Append formatted deliverables if present
  let deliverablesSummary: string | undefined;
  if (deliverables && deliverables.length > 0) {
    deliverablesSummary = formatDeliverables(deliverables, policy.level);
    if (deliverablesSummary) {
      // Applies to every level: compact renders as "*N file(s) modified.*"
      // (section 2.3 of the report) instead of silently dropping the summary.
      workingMessage += `\n\n${deliverablesSummary}`;
    }
  }

  // Enforce policy constraints
  const enforceResult = enforceResponsePolicy(workingMessage, policy, modeOverride);

  return {
    response: enforceResult.response,
    violated: enforceResult.violated,
    reason: enforceResult.reason,
    deliverablesSummary,
  };
}

/**
 * ResponseFormatter class wrapper for object-oriented delegation in PiSdkRuntime.
 */
export class ResponseFormatter {
  enforce(
    response: string,
    policy: ResponsePolicy,
    modeOverride?: ResponseEnforcementMode,
  ): EnforceResult {
    return enforceResponsePolicy(response, policy, modeOverride);
  }

  format(input: {
    message: string;
    policy: ResponsePolicy;
    deliverables?: Deliverable[] | undefined;
    modeOverride?: ResponseEnforcementMode | undefined;
  }) {
    return formatResponse(input);
  }

  formatDeliverables(deliverables: Deliverable[], level?: ResponsePolicy["level"]): string | undefined {
    return formatDeliverables(deliverables, level);
  }
}
