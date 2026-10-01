import type { GroupMessage } from "../../../../shared/contracts";
import { GroupMessageRow, type WorkingMemberAvatar } from "./GroupMessageRow";
import type { MemberLabel } from "./memberLabels";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";

export type { WorkingMemberAvatar } from "./GroupMessageRow";

function syntheticInFlightMessage(row: GroupMemberWorkingRow, groupId: string): GroupMessage {
  const stream = row.live.streamText.trim();
  return {
    id: `inflight:${row.sessionId}`,
    groupId,
    authorKind: "agent",
    authorSessionId: row.sessionId,
    kind: "message",
    body: row.live.streamText,
    mentions: [],
    createdAt: new Date(
      row.live.presence.startedAt || row.live.lastEventAt || Date.now(),
    ).toISOString(),
    status: row.mode === "queued" ? "queued" : stream ? "writing" : "running",
  };
}

/** Fallback cards for active agents without a canonical in-flight message yet. */
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
  roles?: ReadonlyMap<string, string>;
  members: readonly { sessionId: string; title: string }[];
  groupId: string;
}) {
  const visible = rows.filter((row) => !row.live.collapsed);
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="group-working-status">
      {visible.map((row) => {
        const message = syntheticInFlightMessage(row, groupId);
        return (
          <div
            data-mode={row.mode}
            data-phase={row.live.phase}
            data-testid="group-member-working"
            key={row.sessionId}
          >
            <GroupMessageRow
              avatar={avatars.get(row.sessionId)}
              labels={labels}
              liveTurn={{ mode: row.mode, live: row.live }}
              members={members}
              message={message}
              role={roles?.get(row.sessionId)}
              streaming={Boolean(row.live.streamText.trim())}
            />
          </div>
        );
      })}
    </div>
  );
}
