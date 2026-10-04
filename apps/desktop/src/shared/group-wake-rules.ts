import type { AgentGroupInfo } from "./contracts";
import { isCoordinatorModeActive } from "./group-coordinator";

/**
 * Pure wake rules for a user message, shared by the main-process runtime
 * (`GroupRuntime.wakeTargets` / `route`) and the renderer's read-only model
 * chip, so both resolve the same targets from the same inputs.
 */
export type WakeMemberRef = { sessionId: string; title: string; archived?: boolean };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Member session ids mentioned in `text` as `@<session title>` (case-insensitive,
 * longest title first) or `@<session id>`, in member order.
 */
export function parseGroupMentions(text: string, members: readonly WakeMemberRef[]): string[] {
  const found = new Set<string>();
  // Members sharing a title (case-insensitive) are all woken by `@Title`.
  const byTitle = new Map<string, { title: string; sessionIds: string[] }>();
  for (const member of members) {
    const title = member.title.trim();
    if (!title) continue;
    const key = title.toLocaleLowerCase();
    const entry = byTitle.get(key) ?? { title, sessionIds: [] };
    entry.sessionIds.push(member.sessionId);
    byTitle.set(key, entry);
  }
  const handles = [
    ...[...byTitle.values()].map((entry) => ({
      handle: entry.title,
      sessionIds: entry.sessionIds,
    })),
    ...members.map((member) => ({ handle: member.sessionId, sessionIds: [member.sessionId] })),
  ].sort((a, b) => b.handle.length - a.handle.length);
  // P2: `@everyone` stays in the transcript (broadcast) but never mass-wakes.
  let rest = text.replace(/@everyone(?![\p{L}\p{N}_-])/giu, " ");
  for (const { handle, sessionIds } of handles) {
    if (!handle.trim()) continue;
    const pattern = new RegExp(`@${escapeRegExp(handle)}(?![\\p{L}\\p{N}_-])`, "giu");
    if (pattern.test(rest)) {
      for (const id of sessionIds) found.add(id);
      // Consume it so a shorter handle that prefixes this one does not match too.
      rest = rest.replace(pattern, " ");
    }
  }
  return members.map((member) => member.sessionId).filter((id) => found.has(id));
}

/**
 * Which rule picks the targets of a user message, in runtime priority order:
 * @mentions → thread reply author → coordinator Lead → autonomous (specialty).
 * `wanted` is the raw target list for the first three; the autonomous pick is
 * made by `selectAutonomousWakeTargets` (main) over `autonomousWakeEligible`.
 */
export type UserWakeRule =
  | { rule: "mention"; wanted: string[] }
  | { rule: "reply"; wanted: string[] }
  | { rule: "coordinator"; wanted: string[] }
  | { rule: "autonomous" };

export function resolveUserWakeRule(input: {
  mentions: readonly string[];
  repliedAuthorSessionId?: string | undefined;
  group: Pick<AgentGroupInfo, "mode" | "leadSessionId">;
}): UserWakeRule {
  if (input.mentions.length > 0) return { rule: "mention", wanted: [...input.mentions] };
  // Thread reply without @ — continue with the person being answered.
  if (input.repliedAuthorSessionId)
    return { rule: "reply", wanted: [input.repliedAuthorSessionId] };
  if (isCoordinatorModeActive(input.group) && input.group.leadSessionId) {
    return { rule: "coordinator", wanted: [input.group.leadSessionId] };
  }
  return { rule: "autonomous" };
}

/** Members an autonomous (untargeted) wake may pick: never archived or excluded. */
export function autonomousWakeEligible<T extends Pick<WakeMemberRef, "sessionId" | "archived">>(
  members: readonly T[],
  excludeSessionIds: readonly string[] = [],
): T[] {
  const excluded = new Set(excludeSessionIds);
  return members.filter((member) => !member.archived && !excluded.has(member.sessionId));
}

/** Unique targets that are members and not the author (an author never wakes itself). */
export function memberWakeTargets(
  targets: readonly string[],
  memberIds: ReadonlySet<string>,
  authorSessionId?: string | undefined,
): string[] {
  return [...new Set(targets)].filter((id) => memberIds.has(id) && id !== authorSessionId);
}

/** route(): archived members stay members but are never woken (a notice is posted). */
export function partitionArchivedWakeTargets(
  wanted: readonly string[],
  members: readonly Pick<WakeMemberRef, "sessionId" | "archived">[],
): { archived: string[]; targets: string[] } {
  const archived = wanted.filter(
    (id) => members.find((member) => member.sessionId === id)?.archived,
  );
  return { archived, targets: wanted.filter((id) => !archived.includes(id)) };
}
