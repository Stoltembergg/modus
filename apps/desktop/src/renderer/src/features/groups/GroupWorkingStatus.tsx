import { useEffect, useState } from "react";
import { inlineLiveStatusLabel } from "../../../../shared/group-room-transcript";
import { shouldShowStillWorking } from "../../../../shared/group-semantic-presence";
import type { WorkingMemberAvatar } from "./GroupMessageRow";
import { isStillWorking, STILL_WORKING_AFTER_MS } from "./groupLiveTurn";
import { MemberName } from "./MemberName";
import type { MemberLabel } from "./memberLabels";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";

export type { WorkingMemberAvatar } from "./GroupMessageRow";

/** One compact presence surface. Public message text belongs to canonical cards. */
export function GroupWorkingStatus({
  rows,
  labels,
}: {
  rows: readonly GroupMemberWorkingRow[];
  labels: ReadonlyMap<string, MemberLabel>;
  avatars: ReadonlyMap<string, WorkingMemberAvatar>;
  roles?: ReadonlyMap<string, string>;
  members: readonly { sessionId: string; title: string }[];
  groupId: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const visible = rows.filter((row) => !row.live.collapsed);
  const ticking = visible.some((row) => row.mode === "running" || row.mode === "queued");
  useEffect(() => {
    if (!ticking) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [ticking]);
  if (visible.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-2xs text-fg-subtle"
      data-testid="group-working-status"
      role="status"
    >
      {visible.map((row) => {
        const still =
          row.mode === "running" &&
          (row.live.presence
            ? shouldShowStillWorking(row.live.presence, now, STILL_WORKING_AFTER_MS)
            : isStillWorking(row.mode, row.live.lastEventAt || now, now, STILL_WORKING_AFTER_MS));
        const phase = inlineLiveStatusLabel({
          phase: String(row.live.phase),
          presenceState: row.live.presence?.state,
          activity: row.live.presence?.activity,
          waitingFor: row.live.presence?.waitingFor,
          stillWorking: still,
          startedAt: row.live.presence?.startedAt,
          nowMs: now,
        });
        return (
          <span
            className="inline-flex min-w-0 items-center gap-1.5"
            data-mode={row.mode}
            data-phase={row.live.phase}
            data-testid="group-member-working"
            key={row.sessionId}
          >
            <span
              aria-hidden
              className={`size-1.5 shrink-0 rounded-full bg-fg-faint${row.mode === "running" ? " animate-pulse" : ""}`}
            />
            <MemberName label={labels.get(row.sessionId) ?? { title: "Member" }} />
            <span data-testid="group-live-status">{phase}</span>
          </span>
        );
      })}
    </div>
  );
}
