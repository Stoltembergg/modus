import { memberLabels, memberLabelText } from "./memberLabels";

/** A group member as the room knows it (session id + chat title). */
export type MentionMember = { sessionId: string; title: string };

export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; sessionIds: string[]; label: string };

/** Markdown links to this sentinel render as mention chips (never navigate). */
export const MODUS_MENTION_HREF_PREFIX = "https://modus.workspace/mention";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Handle = { handle: string; sessionIds: string[]; label: string };

/**
 * Same grammar as the main-process `parseGroupMentions`: `@<title>`
 * (case-insensitive, members sharing a title all match) or `@<session id>`,
 * longest handle first, not followed by a letter, digit, `_` or `-`.
 */
function mentionHandles(members: readonly MentionMember[]): Handle[] {
  const labels = memberLabels(members);
  const byTitle = new Map<string, Handle>();
  for (const member of members) {
    const title = member.title.trim();
    if (!title) continue;
    const key = title.toLocaleLowerCase();
    const entry = byTitle.get(key) ?? { handle: title, sessionIds: [], label: title };
    entry.sessionIds.push(member.sessionId);
    byTitle.set(key, entry);
  }
  return [
    ...byTitle.values(),
    ...members.map((member) => ({
      handle: member.sessionId,
      sessionIds: [member.sessionId],
      label: labelFor(labels, member),
    })),
  ].sort((a, b) => b.handle.length - a.handle.length);
}

/** One member's label text: the title, plus the short id when the title repeats. */
function labelFor(labels: ReturnType<typeof memberLabels>, member: MentionMember): string {
  const label = labels.get(member.sessionId);
  return label ? memberLabelText(label) : member.title.trim() || member.sessionId;
}

/** Splits text into plain runs and `@mention` runs of group members. */
export function splitMentions(text: string, members: readonly MentionMember[]): MentionSegment[] {
  const taken: Array<{ start: number; end: number; handle: Handle }> = [];
  for (const handle of mentionHandles(members)) {
    if (!handle.handle.trim()) continue;
    const pattern = new RegExp(`@${escapeRegExp(handle.handle)}(?![\\p{L}\\p{N}_-])`, "giu");
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (taken.some((range) => start < range.end && end > range.start)) continue;
      taken.push({ start, end, handle });
    }
  }
  taken.sort((a, b) => a.start - b.start);
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const { start, end, handle } of taken) {
    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push({
      kind: "mention",
      text: text.slice(start, end),
      sessionIds: handle.sessionIds,
      label: handle.label,
    });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

/** Code spans and fenced blocks keep their `@` text as is. */
const CODE_PATTERN = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

/**
 * Member markdown with every mention outside code turned into a link to the
 * mention sentinel, so the shared chat renderer draws it as a chip.
 */
export function linkMentionsInMarkdown(
  markdown: string,
  members: readonly MentionMember[],
): string {
  return markdown
    .split(CODE_PATTERN)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return splitMentions(part, members)
        .map((segment) =>
          segment.kind === "text"
            ? segment.text
            : `[@${segment.label.replace(/[[\]\\]/g, "\\$&")}](${mentionHref(segment.sessionIds)})`,
        )
        .join("");
    })
    .join("");
}

export function mentionHref(sessionIds: readonly string[]): string {
  return `${MODUS_MENTION_HREF_PREFIX}?id=${sessionIds.map(encodeURIComponent).join(",")}`;
}

export function isMentionHref(href: string | undefined): boolean {
  return Boolean(href?.startsWith(`${MODUS_MENTION_HREF_PREFIX}?`));
}

/** The `@query` being typed at the caret (no whitespace in it), if any. */
export function activeMentionQuery(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/u.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query };
}

export type MentionSuggestion = {
  sessionId: string;
  title: string;
  /** Inserted after `@`: the title, or the session id when the title is shared. */
  insert: string;
  duplicateTitle: boolean;
  /** Short id shown after a shared title (same as everywhere else in the room). */
  suffix?: string;
};

function suffixOf(duplicateTitle: boolean, suffix: string | undefined): { suffix?: string } {
  return duplicateTitle && suffix ? { suffix } : {};
}

/** Members whose title contains the query (prefix matches first). */
export function mentionSuggestions(
  query: string,
  members: readonly MentionMember[],
): MentionSuggestion[] {
  const counts = new Map<string, number>();
  for (const member of members) {
    const key = member.title.trim().toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const labels = memberLabels(members);
  const needle = query.toLocaleLowerCase();
  return members
    .map((member) => {
      const title = member.title.trim() || member.sessionId;
      const duplicateTitle = (counts.get(member.title.trim().toLocaleLowerCase()) ?? 0) > 1;
      return {
        sessionId: member.sessionId,
        title,
        insert: duplicateTitle ? member.sessionId : title,
        duplicateTitle,
        ...suffixOf(duplicateTitle, labels.get(member.sessionId)?.suffix),
        rank: title.toLocaleLowerCase().indexOf(needle),
      };
    })
    .filter((item) => item.rank >= 0 || item.sessionId.toLocaleLowerCase().startsWith(needle))
    .sort((a, b) => (a.rank < 0 ? 1 : a.rank) - (b.rank < 0 ? 1 : b.rank))
    .map(({ rank: _rank, ...item }) => item);
}
