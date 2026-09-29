/** How a group member is labelled: its chat title, plus a short id when the title repeats. */
export type MemberLabel = { title: string; suffix?: string };

/** `Reviewer · 3f2a` as plain text (tooltips, aria labels). */
export function memberLabelText(label: MemberLabel): string {
  return label.suffix ? `${label.title} · ${label.suffix}` : label.title;
}

function shortId(sessionId: string, length: number): string {
  const compact = sessionId.replace(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase();
  return (compact || sessionId).slice(0, length);
}

/**
 * Labels for the members of ONE group. A title shared (case-insensitive) by
 * several members gets a short session id suffix, 4 characters, longer only
 * if needed to tell them apart; unique titles stay as they are.
 */
export function memberLabels(
  members: ReadonlyArray<{ sessionId: string; title: string }>,
): Map<string, MemberLabel> {
  const byTitle = new Map<string, Array<{ sessionId: string; title: string }>>();
  for (const member of members) {
    const title = member.title.trim() || member.sessionId;
    const key = title.toLocaleLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), { sessionId: member.sessionId, title }]);
  }
  const labels = new Map<string, MemberLabel>();
  for (const same of byTitle.values()) {
    if (same.length === 1) {
      const [only] = same;
      if (only) labels.set(only.sessionId, { title: only.title });
      continue;
    }
    const longest = Math.max(...same.map((member) => member.sessionId.length));
    let length = 4;
    while (
      length < longest &&
      new Set(same.map((member) => shortId(member.sessionId, length))).size < same.length
    ) {
      length += 1;
    }
    for (const member of same) {
      labels.set(member.sessionId, {
        title: member.title,
        suffix: shortId(member.sessionId, length),
      });
    }
  }
  return labels;
}
