export type ResponseLevel = "compact" | "standard" | "detailed" | "verbose";

export type ResponseEnforcementMode = "strict" | "advisory" | "off";

export type ResponsePolicy = {
  level: ResponseLevel;
  maxParagraphs: number;
  includeReasoning: boolean;
  includeToolNarration: boolean;
  includeFileReads: boolean;
  includeSearchResults: boolean;
  enforcementMode: ResponseEnforcementMode;
};

export const DEFAULT_RESPONSE_LEVEL: ResponseLevel = "standard";

export const RESPONSE_POLICIES: Record<ResponseLevel, ResponsePolicy> = {
  compact: {
    level: "compact",
    maxParagraphs: 2,
    includeReasoning: false,
    includeToolNarration: false,
    includeFileReads: false,
    includeSearchResults: false,
    enforcementMode: "advisory",
  },
  standard: {
    level: "standard",
    maxParagraphs: 5,
    includeReasoning: false,
    includeToolNarration: false,
    includeFileReads: false,
    includeSearchResults: false,
    enforcementMode: "advisory",
  },
  detailed: {
    level: "detailed",
    maxParagraphs: 10,
    includeReasoning: true,
    includeToolNarration: true,
    includeFileReads: false,
    includeSearchResults: false,
    enforcementMode: "advisory",
  },
  verbose: {
    level: "verbose",
    maxParagraphs: -1, // Unlimited
    includeReasoning: true,
    includeToolNarration: true,
    includeFileReads: true,
    includeSearchResults: true,
    enforcementMode: "off",
  },
};

export const RESPONSE_POLICY_PROMPTS: Record<ResponseLevel, string> = {
  compact: `<response_policy level="compact">
Keep your response minimal and concise. Report only:
1. What was accomplished (1 sentence).
2. Important changes or decisions made.
3. Verification status (tests, typecheck, lint).
4. Blockers or required actions from the user.

Do NOT narrate:
- Internal reasoning process (silent thinking).
- Routine tool calls or arguments (already visible in UI work fold).
- Routine file reads or searches.
- Step-by-step narration of intermediate actions.

Maximum 2 short paragraphs.
</response_policy>`,

  standard: `<response_policy level="standard">
Concise, direct response. Include:
1. Summary of what was done.
2. Important changes made and their rationale.
3. Verification status and test evidence.
4. Next steps, recommendations, or blockers.

Omit routine tool narration, file reads, and searches (visible in UI).
Maximum 5 paragraphs.
</response_policy>`,

  detailed: `<response_policy level="detailed">
Comprehensive response. Include:
1. Complete overview of changes and implementation details.
2. Architectural decisions and context.
3. Verification results and test coverage evidence.
4. Operational guidance and potential side effects.

Tool narration is permitted when relevant to explanations.
Maximum 10 paragraphs.
</response_policy>`,

  verbose: `<response_policy level="verbose">
Full transparency response. Include all reasoning, intermediate findings, tool call justifications, and detailed execution logs.
</response_policy>`,
};

/**
 * Resolves a ResponsePolicy from a level name, falling back to standard.
 */
export function resolveResponsePolicy(
  level?: ResponseLevel | string,
  overrides?: Partial<ResponsePolicy>,
): ResponsePolicy {
  const base =
    level && level in RESPONSE_POLICIES
      ? RESPONSE_POLICIES[level as ResponseLevel]
      : RESPONSE_POLICIES[DEFAULT_RESPONSE_LEVEL];
  return { ...base, ...overrides };
}
