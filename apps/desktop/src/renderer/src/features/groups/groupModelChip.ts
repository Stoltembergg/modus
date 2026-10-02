import { groupModelChipText, groupModelCountLabel } from "../../../../shared/group-room-locale";
import { type MentionMember, splitMentions } from "./groupMentions";

/**
 * Read-only model chip of the group composer (C5). It only DESCRIBES the
 * models of the agents involved; it never picks who answers (specialty
 * routing may still choose another member) and adds no group-level model.
 *
 * - one mention    → that agent's model
 * - several        → "N models" (distinct), tooltip "Agent: model" per agent
 * - no mention     → the Lead's model, tooltip "Lead answers by default"
 * - no Lead        → the active members' models, tooltip "No Lead: …"
 * An agent without `modelId` shows "Default model"; an unknown id shows raw.
 */
export type GroupModelChipModel = { id: string; name: string };

export type GroupModelChipInput = {
  draft: string;
  members: readonly MentionMember[];
  /** sessionId → the member agent's `modelId` (undefined = none set). */
  memberModels: ReadonlyMap<string, string | undefined>;
  leadSessionId?: string | undefined;
  /** Session ids of archived members (never woken; skipped without a Lead). */
  archivedSessionIds?: ReadonlySet<string> | undefined;
  models: readonly GroupModelChipModel[];
  locale?: string | null | undefined;
};

export type GroupModelChip = {
  kind: "single" | "multiple" | "lead" | "noLead";
  label: string;
  tooltip: string;
  /** Agents described by the chip, in order. */
  entries: { sessionId: string; name: string; model: string }[];
};

export function modelDisplayName(
  modelId: string | undefined,
  models: readonly GroupModelChipModel[],
  locale?: string | null,
): string {
  const id = modelId?.trim();
  if (!id) return groupModelChipText("defaultModel", locale);
  return models.find((model) => model.id === id)?.name || id;
}

/** Unique mentioned member session ids, in first-mention order. */
export function mentionedSessionIds(draft: string, members: readonly MentionMember[]): string[] {
  const ids: string[] = [];
  for (const segment of splitMentions(draft, members)) {
    if (segment.kind !== "mention") continue;
    for (const id of segment.sessionIds) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function summarize(entries: GroupModelChip["entries"], locale: string | null | undefined): string {
  const distinct = new Set(entries.map((entry) => entry.model));
  return distinct.size === 1
    ? (entries[0]?.model ?? "")
    : groupModelCountLabel(distinct.size, locale);
}

function listTooltip(entries: GroupModelChip["entries"]): string {
  return entries.map((entry) => `${entry.name}: ${entry.model}`).join("\n");
}

export function groupModelChip(input: GroupModelChipInput): GroupModelChip | undefined {
  const { members, memberModels, models, locale } = input;
  const byId = new Map(members.map((member) => [member.sessionId, member]));
  const entryFor = (sessionId: string) => {
    const member = byId.get(sessionId);
    return member
      ? {
          sessionId,
          name: member.title.trim() || sessionId,
          model: modelDisplayName(memberModels.get(sessionId), models, locale),
        }
      : undefined;
  };
  const entries = (ids: readonly string[]) =>
    ids.map(entryFor).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const mentioned = entries(mentionedSessionIds(input.draft, members));
  if (mentioned.length === 1) {
    const [only] = mentioned;
    if (only) {
      return {
        kind: "single",
        label: only.model,
        tooltip: listTooltip(mentioned),
        entries: mentioned,
      };
    }
  }
  if (mentioned.length > 1) {
    return {
      kind: "multiple",
      label: summarize(mentioned, locale),
      tooltip: listTooltip(mentioned),
      entries: mentioned,
    };
  }
  const lead = input.leadSessionId ? entryFor(input.leadSessionId) : undefined;
  if (lead) {
    return {
      kind: "lead",
      label: lead.model,
      tooltip: `${groupModelChipText("leadDefault", locale)}\n${listTooltip([lead])}`,
      entries: [lead],
    };
  }
  const active = entries(
    members.map((member) => member.sessionId).filter((id) => !input.archivedSessionIds?.has(id)),
  );
  if (active.length === 0) return undefined;
  return {
    kind: "noLead",
    label: summarize(active, locale),
    tooltip: `${groupModelChipText("noLead", locale)}\n${listTooltip(active)}`,
    entries: active,
  };
}
