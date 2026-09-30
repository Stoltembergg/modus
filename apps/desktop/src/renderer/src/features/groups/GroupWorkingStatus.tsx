import type { GroupMessage } from "../../../../shared/contracts";
import { GroupMessageRow, type WorkingMemberAvatar } from "./GroupMessageRow";
import type { MemberLabel } from "./memberLabels";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";

export type { WorkingMemberAvatar } from "./GroupMessageRow";

function syntheticInFlightMessage(row: GroupMemberWorkingRow, groupId: string): GroupMessage {
  return {
    id: `inflight:${row.sessionId}`,
    groupId,
    authorKind: "agent",
    authorSessionId: row.sessionId,
    kind: "message",
    body: row.live.streamText,
    mentions: [],
    createdAt: new Date(row.live.lastEventAt || Date.now()).toISOString(),
  };
}

/**
 * In-flight definitive GroupMessageRows for members whose turns are streaming.
 * Each row updates independently from `message.delta`; inline status yields to text.
 */
export function GroupWorkingStatus({
  rows,
  labels,
  avatars,
  roles,
  members,
  groupId,
}: {
  rows: readonly GroupMemberWorkingRow[];
  labels: ReadonlyMap<string, MemberLabel>;
  avatars: ReadonlyMap<string, WorkingMemberAvatar>;
  /** Optional role label per session (discreet under the name). */
  roles?: ReadonlyMap<string, string>;
  members: readonly { sessionId: string; title: string }[];
  groupId: string;
}) {
  if (rows.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="flex flex-col gap-2"
      data-testid="group-working-status"
      role="status"
    >
      {rows.map((row) => {
        const avatar = avatars.get(row.sessionId);
        const stream = row.live.streamText.trim();
        const role = roles?.get(row.sessionId)?.trim();
        return (
          <div
            data-mode={row.mode}
            data-phase={row.live.phase}
            data-streaming={stream ? "true" : undefined}
            data-testid="group-member-working"
            key={row.sessionId}
          >
            <GroupMessageRow
              avatar={avatar}
              labels={labels}
              liveTurn={{ mode: row.mode, live: row.live }}
              members={members}
              message={syntheticInFlightMessage(row, groupId)}
              role={role}
              streaming
            />
          </div>
        );
      })}
    </div>
  );
}
