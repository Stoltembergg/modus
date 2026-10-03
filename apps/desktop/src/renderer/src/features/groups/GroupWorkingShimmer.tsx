import { useEffect, useMemo, useState } from "react";
import { groupAgentWorkingLabel } from "../../../../shared/group-room-locale";
import { useGroupRoomLocale } from "./groupRoomI18n";
import type { MemberLabel } from "./memberLabels";
import { TextShimmer } from "./prompt-kit/PromptKit";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";
import { groupWorkingShimmerText, shouldShowGroupWorkingShimmer } from "./workingShimmer";

/**
 * Compact Prompt Kit text-shimmer above the group composer.
 * Names the agent(s) and a concrete phase (queued age / waiting on model / …).
 * Clears when idle or when streaming makes progress obvious.
 */
export function GroupWorkingShimmer({
  rows,
  labels,
  locale: localeProp,
}: {
  rows: readonly GroupMemberWorkingRow[];
  labels: ReadonlyMap<string, MemberLabel>;
  locale?: string | null;
}) {
  const locale = useGroupRoomLocale(localeProp);
  const visible = shouldShowGroupWorkingShimmer(rows);
  const needsTick = visible && rows.some((row) => row.mode === "queued" && !row.live.collapsed);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!needsTick) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [needsTick]);
  const text = useMemo(
    () =>
      visible
        ? groupWorkingShimmerText(rows, labels, locale, now)
        : groupAgentWorkingLabel([], locale),
    [visible, rows, labels, locale, now],
  );
  if (!visible) return null;
  return (
    <div
      aria-live="polite"
      className="mx-auto mb-2 w-full max-w-[760px] shrink-0 px-6 pt-0.5"
      data-testid="group-working-shimmer"
      role="status"
    >
      <TextShimmer className="text-xs leading-snug" duration={3.2} spread={18}>
        {text}
      </TextShimmer>
    </div>
  );
}
