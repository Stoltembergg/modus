import type { AgentAvatarColor, AgentAvatarFace } from "../../../../shared/contracts";
import { AgentAvatar } from "../agents/AgentAvatar";
import { agentAvatarState } from "../agents/agentAvatarModel";
import { GroupMemberLiveTurn } from "./GroupMemberLiveTurn";
import { MemberName } from "./MemberName";
import type { MemberLabel } from "./memberLabels";
import { memberLabelText } from "./memberLabels";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";

/** Avatar fields the working strip needs (same shape as GroupRoom's RoomAvatar). */
export type WorkingMemberAvatar = {
  agentId: string;
  face: AgentAvatarFace;
  color: AgentAvatarColor;
  archived: boolean;
};

/**
 * In-transcript working strip for group members whose turns are running or
 * queued. Binds `group.activity` + live agent events so Stop ≠ empty transcript:
 * phase, thought/tools/writing previews, and "Still working…" on silence.
 */
export function GroupWorkingStatus({
  rows,
  labels,
  avatars,
}: {
  rows: readonly GroupMemberWorkingRow[];
  labels: ReadonlyMap<string, MemberLabel>;
  avatars: ReadonlyMap<string, WorkingMemberAvatar>;
}) {
  if (rows.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="flex flex-col gap-3"
      data-testid="group-working-status"
      role="status"
    >
      {rows.map((row) => {
        const label = labels.get(row.sessionId) ?? { title: row.sessionId };
        const avatar = avatars.get(row.sessionId);
        const phase = row.live.phase;
        const working = row.mode === "running";
        return (
          <div
            className="flex gap-2.5"
            data-mode={row.mode}
            data-phase={phase}
            data-testid="group-member-working"
            key={row.sessionId}
          >
            {avatar ? (
              <AgentAvatar
                className="mt-0.5"
                color={avatar.color}
                face={avatar.face}
                seed={avatar.agentId}
                size={20}
                state={agentAvatarState(working ? "working" : "idle", avatar.archived)}
              />
            ) : (
              <span
                aria-hidden
                className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-elevated font-medium text-fg-muted text-xs"
              >
                {memberLabelText(label).trim().charAt(0).toLocaleUpperCase() || "?"}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 font-medium text-fg-muted text-xs">
                <MemberName label={label} />
              </div>
              <GroupMemberLiveTurn live={row.live} mode={row.mode} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
