import { useMemo } from "react";
import { groupAgentWorkingLabel } from "../../../../shared/group-room-locale";
import type { MemberLabel } from "./memberLabels";
import { TextShimmer } from "./prompt-kit/PromptKit";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";
import { groupWorkingShimmerNames, shouldShowGroupWorkingShimmer } from "./workingShimmer";

/**
 * Compact Prompt Kit text-shimmer above the group composer.
 * Names the agent(s) still working without streamed writing yet.
 * Clears when idle or when streaming makes progress obvious.
 */
export function GroupWorkingShimmer({
  rows,
  labels,
  locale,
}: {
  rows: readonly GroupMemberWorkingRow[];
  labels: ReadonlyMap<string, MemberLabel>;
  locale?: string | null;
}) {
  const visible = shouldShowGroupWorkingShimmer(rows);
  const names = useMemo(
    () => (visible ? groupWorkingShimmerNames(rows, labels) : []),
    [visible, rows, labels],
  );
  if (!visible) return null;
  const text = groupAgentWorkingLabel(names, locale);
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
