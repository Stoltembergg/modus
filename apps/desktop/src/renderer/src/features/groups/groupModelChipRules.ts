import type { AgentGroupMember, AgentGroupMode, GroupMessage } from "../../../../shared/contracts";
import {
  type GroupModelChipTextKey,
  groupModelChipText,
  groupModelCountLabel,
} from "../../../../shared/group-room-locale";
import {
  autonomousWakeEligible,
  memberWakeTargets,
  parseGroupMentions,
  partitionArchivedWakeTargets,
  resolveUserWakeRule,
  type UserWakeRule,
  type WakeMemberRef,
} from "../../../../shared/group-wake-rules";
import type { MentionMember } from "./groupMentions";

/**
 * Read-only model chip of the group composer (C5). It mirrors the runtime's
 * wake rules for a user message (shared `group-wake-rules`, used by
 * `GroupRuntime.wakeTargets`/`route`): @mentions → thread reply author →
 * coordinator Lead → autonomous pick. Archived members are never woken.
 * It only DESCRIBES models; it never routes and adds no group-level model.
 *
 * - mentions          → models of the ACTIVE mentioned agents ("N models")
 * - reply, no mention → the replied-to author's model
 * - coordinator mode  → the Lead's model
 * - autonomous        → the Lead's model ("Lead answers by default"); when a
 *                       configured Lead is archived, the active members are candidates
 * - nobody would wake → amber warning ("Archived" / "Lead archived")
 * An agent without `modelId` shows "Default model"; an unknown id shows raw.
 */
export type GroupModelChipModel = { id: string; name: string };

export type GroupModelChipInput = {
  draft: string;
  members: readonly MentionMember[];
  /** sessionId → the member agent's `modelId` (undefined = none set). */
  memberModels: ReadonlyMap<string, string | undefined>;
  leadSessionId?: string | undefined;
  /** Room mode (coordinator wakes only the Lead for untargeted messages). */
  mode?: AgentGroupMode | undefined;
  /** Author of the message being replied to (undefined for user messages). */
  replyAuthorSessionId?: string | undefined;
  /** Session ids of archived members (never woken). */
  archivedSessionIds?: ReadonlySet<string> | undefined;
  models: readonly GroupModelChipModel[];
  locale?: string | null | undefined;
};

export type GroupModelChipEntry = { sessionId: string; name: string; model: string };

export type GroupModelChip = {
  kind: "single" | "multiple" | "reply" | "lead" | "noLead" | "nobody";
  /** Which runtime rule resolved the target. */
  rule: UserWakeRule["rule"];
  label: string;
  tooltip: string;
  /** Amber "nobody will answer" state. */
  warning: boolean;
  /**
   * Resolved target set: exactly who the runtime wakes for mention / reply /
   * coordinator; for autonomous, the eligible pool the specialty pick uses.
   */
  targets: string[];
  /** Agents described by the chip (models shown), in order. */
  entries: GroupModelChipEntry[];
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

/** Archived members (still members, never woken), from the room's members. */
export function archivedMemberIds(
  members: readonly Pick<AgentGroupMember, "sessionId" | "archived">[],
): Set<string> {
  return new Set(members.filter((member) => member.archived === true).map((m) => m.sessionId));
}

/**
 * The runtime's `repliedAuthor`: the author session of the replied-to message
 * (undefined for a user/system message or a message that is not loaded).
 */
export function replyAuthorOf(
  messages: readonly Pick<GroupMessage, "id" | "authorSessionId">[],
  replyToMessageId: string | undefined,
): string | undefined {
  if (!replyToMessageId) return undefined;
  return messages.find((message) => message.id === replyToMessageId)?.authorSessionId;
}

/** Mentioned member session ids, parsed exactly like the runtime (member order). */
export function mentionedSessionIds(draft: string, members: readonly MentionMember[]): string[] {
  return parseGroupMentions(draft, members);
}

function summarize(entries: readonly GroupModelChipEntry[], locale: string | null | undefined) {
  const distinct = new Set(entries.map((entry) => entry.model));
  return distinct.size === 1
    ? (entries[0]?.model ?? "")
    : groupModelCountLabel(distinct.size, locale);
}

function listLines(entries: readonly GroupModelChipEntry[]): string[] {
  return entries.map((entry) => `${entry.name}: ${entry.model}`);
}

export function groupModelChip(input: GroupModelChipInput): GroupModelChip | undefined {
  const { members, memberModels, models, locale } = input;
  if (members.length === 0) return undefined;
  const t = (key: GroupModelChipTextKey) => groupModelChipText(key, locale);
  const roster: WakeMemberRef[] = members.map((member) => ({
    sessionId: member.sessionId,
    title: member.title,
    archived: input.archivedSessionIds?.has(member.sessionId) === true,
  }));
  const byId = new Map(members.map((member) => [member.sessionId, member]));
  const nameOf = (id: string) => byId.get(id)?.title.trim() || id;
  const entriesOf = (ids: readonly string[]): GroupModelChipEntry[] =>
    ids.map((sessionId) => ({
      sessionId,
      name: nameOf(sessionId),
      model: modelDisplayName(memberModels.get(sessionId), models, locale),
    }));
  const memberIds = new Set(members.map((member) => member.sessionId));

  const rule = resolveUserWakeRule({
    mentions: parseGroupMentions(input.draft, roster),
    repliedAuthorSessionId: input.replyAuthorSessionId,
    group: {
      mode: input.mode ?? "free",
      ...(input.leadSessionId ? { leadSessionId: input.leadSessionId } : {}),
    },
  });

  if (rule.rule === "autonomous") {
    const eligible = autonomousWakeEligible(roster).map((member) => member.sessionId);
    const targets = eligible;
    if (eligible.length === 0) {
      return nobody(rule.rule, t("archived"), [t("nobody"), t("archivedHint")]);
    }
    if (input.leadSessionId && eligible.includes(input.leadSessionId)) {
      const entries = entriesOf([input.leadSessionId]);
      return {
        kind: "lead",
        rule: rule.rule,
        label: entries[0]?.model ?? "",
        tooltip: [t("leadDefault"), ...listLines(entries)].join("\n"),
        warning: false,
        targets,
        entries,
      };
    }
    if (!input.leadSessionId || !byId.has(input.leadSessionId)) {
      return nobody(rule.rule, t("noTarget"), [t("nobody"), t("noLeadRequiredHint")]);
    }
    const entries = entriesOf(eligible);
    return {
      kind: "noLead",
      rule: rule.rule,
      label: summarize(entries, locale),
      tooltip: [t("noLead"), ...listLines(entries)].join("\n"),
      warning: false,
      targets,
      entries,
    };
  }

  // The runtime keeps only member targets, then route() drops archived ones.
  const wanted = memberWakeTargets(rule.wanted, memberIds);
  const { archived, targets } = partitionArchivedWakeTargets(wanted, roster);
  const skipped = archived.length
    ? [`${t("archivedSkipped")}: ${archived.map(nameOf).join(", ")}`]
    : [];

  if (targets.length === 0) {
    if (rule.rule === "coordinator" && archived.length > 0) {
      return nobody(rule.rule, t("leadArchived"), [`${t("nobody")}. ${t("leadArchivedHint")}`]);
    }
    if (archived.length > 0) {
      return nobody(rule.rule, t("archived"), [`${t("nobody")}. ${t("archivedHint")}`, ...skipped]);
    }
    return nobody(rule.rule, t("noTarget"), [`${t("nobody")}. ${t("noTargetHint")}`]);
  }

  const entries = entriesOf(targets);
  const lines = listLines(entries);
  const base = { rule: rule.rule, warning: false, targets, entries };
  if (rule.rule === "reply") {
    return {
      ...base,
      kind: "reply",
      label: entries[0]?.model ?? "",
      tooltip: [t("replyAuthor"), ...lines].join("\n"),
    };
  }
  if (rule.rule === "coordinator") {
    return {
      ...base,
      kind: "lead",
      label: entries[0]?.model ?? "",
      tooltip: [t("coordinatorLead"), ...lines].join("\n"),
    };
  }
  return {
    ...base,
    kind: entries.length === 1 ? "single" : "multiple",
    label: summarize(entries, locale),
    tooltip: [...lines, ...skipped].join("\n"),
  };
}

function nobody(rule: UserWakeRule["rule"], label: string, lines: string[]): GroupModelChip {
  return {
    kind: "nobody",
    rule,
    label,
    tooltip: lines.join("\n"),
    warning: true,
    targets: [],
    entries: [],
  };
}
