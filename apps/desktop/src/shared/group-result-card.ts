/**
 * Coordinator final result card — structured Outcome / Validations /
 * Changed files / Open items posted by the Lead when a task finishes.
 */

export const GROUP_RESULT_CARD_KEYS = [
  "Outcome",
  "Validations",
  "Changed files",
  "Open items",
] as const;

export type GroupResultCardKey = (typeof GROUP_RESULT_CARD_KEYS)[number];

export type GroupFinalResultCard = {
  outcome: string;
  validations: string[];
  changedFiles: string[];
  openItems: string[];
};

const KEY_BY_LOWER: Record<string, GroupResultCardKey> = {
  outcome: "Outcome",
  validations: "Validations",
  "changed files": "Changed files",
  "open items": "Open items",
};

const HEADER_RE = /^(Outcome|Validations|Changed files|Open items)\s*:\s*(.*)$/i;

function parseHeader(line: string): { key: GroupResultCardKey; rest: string } | undefined {
  const match = HEADER_RE.exec(line.trim());
  if (!match) return undefined;
  const key = KEY_BY_LOWER[(match[1] ?? "").toLocaleLowerCase()];
  if (!key) return undefined;
  return { key, rest: (match[2] ?? "").trim() };
}

function bulletValue(line: string): string | undefined {
  const trimmed = line.trim();
  const match = /^[-*•]\s+(.+)$/.exec(trimmed);
  return match?.[1]?.trim() || undefined;
}

/**
 * True when the body looks like a Coordinator final card
 * (Outcome plus at least one other section).
 */
export function isGroupFinalResultCard(body: string): boolean {
  return parseGroupFinalResultCard(body) !== undefined;
}

/**
 * Parse a Lead final-result body into structured sections.
 * Returns undefined when Outcome is missing or no supporting section is present.
 */
export function parseGroupFinalResultCard(body: string):
  | {
      card: GroupFinalResultCard;
      /** Conversational prose above the card fields (if any). */
      prose: string;
    }
  | undefined {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let outcome = "";
  const validations: string[] = [];
  const changedFiles: string[] = [];
  const openItems: string[] = [];
  const proseLines: string[] = [];
  let active: GroupResultCardKey | undefined;
  let sawAnySection = false;

  const pushList = (key: GroupResultCardKey, value: string) => {
    if (!value) return;
    if (key === "Outcome") outcome = value;
    else if (key === "Validations") validations.push(value);
    else if (key === "Changed files") changedFiles.push(value);
    else openItems.push(value);
  };

  for (const line of lines) {
    const header = parseHeader(line);
    if (header) {
      sawAnySection = true;
      active = header.key;
      if (header.rest) pushList(header.key, header.rest);
      continue;
    }
    if (!sawAnySection) {
      proseLines.push(line);
      continue;
    }
    if (!active) continue;
    if (!line.trim()) {
      active = undefined;
      continue;
    }
    const bullet = bulletValue(line);
    if (bullet) {
      pushList(active, bullet);
      continue;
    }
    // Continuation of a single-line value (rare) — treat as another list item.
    pushList(active, line.trim());
  }

  const supporting = validations.length > 0 || changedFiles.length > 0 || openItems.length > 0;
  if (!outcome.trim() || !supporting) return undefined;

  return {
    card: {
      outcome: outcome.trim(),
      validations,
      changedFiles,
      openItems,
    },
    prose: proseLines.join("\n").replace(/^\s+|\s+$/gu, ""),
  };
}

/** Format a structured final card for the Lead to post (or tests). */
export function formatGroupFinalResultCard(card: GroupFinalResultCard): string {
  const blocks: string[] = [`Outcome: ${card.outcome.trim()}`];
  const section = (title: GroupResultCardKey, items: readonly string[]) => {
    const cleaned = items.map((item) => item.trim()).filter(Boolean);
    if (cleaned.length === 0) return;
    if (cleaned.length === 1) {
      blocks.push(`${title}: ${cleaned[0]}`);
      return;
    }
    blocks.push(`${title}:`);
    for (const item of cleaned) blocks.push(`- ${item}`);
  };
  section("Validations", card.validations);
  section("Changed files", card.changedFiles);
  section("Open items", card.openItems);
  return blocks.join("\n");
}

/**
 * Build a final card from Coordinator consolidation inputs.
 * Empty optional sections are omitted from the formatted body but kept in the object.
 */
export function consolidateGroupFinalResult(input: {
  outcome: string;
  validations?: readonly string[];
  changedFiles?: readonly string[];
  openItems?: readonly string[];
}): GroupFinalResultCard {
  return {
    outcome: input.outcome.trim(),
    validations: [...(input.validations ?? [])].map((item) => item.trim()).filter(Boolean),
    changedFiles: [...(input.changedFiles ?? [])].map((item) => item.trim()).filter(Boolean),
    openItems: [...(input.openItems ?? [])].map((item) => item.trim()).filter(Boolean),
  };
}
