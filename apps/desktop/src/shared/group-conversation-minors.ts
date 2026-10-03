/**
 * Agent Groups conversation UX minors: search, day separators, draft persistence
 * keys, and estimated token totals per ask-spanning execution (chain).
 *
 * Pure helpers — keep renderer/main free of duplicated date/token math.
 */

import { groupRoomIntlLocale, groupText } from "./group-room-locale";

/** Rough token estimate (same rule as Group Runtime chain budget). */
export function estimateGroupTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Local calendar day key (YYYY-MM-DD) in the viewer's timezone. */
export function groupMessageDayKey(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "invalid";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Transcript day label: Today / Yesterday / weekday / short date. */
export function formatGroupDaySeparator(
  iso: string,
  now: Date = new Date(),
  locale?: string | null,
): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThat = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (startOfThat === startOfToday) return groupText("day.today", locale);
  if (startOfThat === startOfToday - dayMs) return groupText("day.yesterday", locale);
  const intl = groupRoomIntlLocale(locale);
  if (startOfThat >= startOfToday - 6 * dayMs) {
    return date.toLocaleDateString(intl, { weekday: "long" });
  }
  return date.toLocaleDateString(intl, { month: "short", day: "numeric", year: "numeric" });
}

export type GroupTranscriptItem<T extends { id: string; createdAt: string }> =
  | { type: "day"; key: string; label: string }
  | { type: "message"; message: T };

/** Insert a day separator before the first message of each local calendar day. */
export function withGroupDaySeparators<T extends { id: string; createdAt: string }>(
  messages: readonly T[],
  now: Date = new Date(),
  locale?: string | null,
): GroupTranscriptItem<T>[] {
  const items: GroupTranscriptItem<T>[] = [];
  let previousDay: string | undefined;
  for (const message of messages) {
    const day = groupMessageDayKey(message.createdAt);
    if (day !== previousDay) {
      items.push({
        type: "day",
        key: `day-${day}`,
        label: formatGroupDaySeparator(message.createdAt, now, locale),
      });
      previousDay = day;
    }
    items.push({ type: "message", message });
  }
  return items;
}

/** Case-insensitive match against body + optional author title. */
export function messageMatchesGroupSearch(
  message: { body: string; authorKind: string; authorSessionId?: string | undefined },
  query: string,
  labels?: ReadonlyMap<string, { title: string }>,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  if (message.body.toLocaleLowerCase().includes(needle)) return true;
  if (message.authorKind === "user" && "you".startsWith(needle)) return true;
  const title = message.authorSessionId ? labels?.get(message.authorSessionId)?.title : undefined;
  return Boolean(title?.toLocaleLowerCase().includes(needle));
}

export function filterMessagesByGroupSearch<
  T extends { body: string; authorKind: string; authorSessionId?: string | undefined },
>(messages: readonly T[], query: string, labels?: ReadonlyMap<string, { title: string }>): T[] {
  const needle = query.trim();
  if (!needle) return [...messages];
  return messages.filter((message) => messageMatchesGroupSearch(message, needle, labels));
}

/** Ask-spanning execution id: chain root, else the message id. */
export function groupExecutionId(message: { id: string; chainId?: string | undefined }): string {
  return message.chainId ?? message.id;
}

/**
 * Sum estimated tokens for every message in each execution (chain).
 * Used for the transcript chip — not provider-reported billing.
 */
export function estimateTokensByExecution(
  messages: readonly { id: string; chainId?: string | undefined; body: string }[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const message of messages) {
    const executionId = groupExecutionId(message);
    totals.set(executionId, (totals.get(executionId) ?? 0) + estimateGroupTokens(message.body));
  }
  return totals;
}

/**
 * Message id that should show the execution token chip: last message of each
 * chain in chronological order (so the total settles at the end of the turn).
 */
export function executionTokenAnchorIds(
  messages: readonly { id: string; chainId?: string | undefined }[],
): Set<string> {
  const lastByExecution = new Map<string, string>();
  for (const message of messages) {
    lastByExecution.set(groupExecutionId(message), message.id);
  }
  return new Set(lastByExecution.values());
}

export const GROUP_COMPOSER_DRAFT_PREFIX = "modus.group.composerDraft.v1.";

export function groupComposerDraftKey(groupId: string): string {
  return `${GROUP_COMPOSER_DRAFT_PREFIX}${groupId}`;
}

export function readGroupComposerDraft(
  groupId: string,
  storage: Pick<Storage, "getItem"> | null | undefined = globalThis.localStorage,
): string {
  if (!storage || !groupId) return "";
  try {
    return storage.getItem(groupComposerDraftKey(groupId)) ?? "";
  } catch {
    return "";
  }
}

export function writeGroupComposerDraft(
  groupId: string,
  value: string,
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined = globalThis.localStorage,
): void {
  if (!storage || !groupId) return;
  try {
    const key = groupComposerDraftKey(groupId);
    if (!value) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Quota / private mode — draft is best-effort.
  }
}

export function clearGroupComposerDraft(
  groupId: string,
  storage: Pick<Storage, "removeItem"> | null | undefined = globalThis.localStorage,
): void {
  if (!storage || !groupId) return;
  try {
    storage.removeItem(groupComposerDraftKey(groupId));
  } catch {
    // ignore
  }
}
