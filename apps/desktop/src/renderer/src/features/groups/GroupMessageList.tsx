import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GroupMessage } from "../../../../shared/contracts";
import { isNearBottom, shouldShowInFlightRow } from "../../../../shared/group-room-transcript";
import { GroupMessageRow, type WorkingMemberAvatar } from "./GroupMessageRow";
import { GroupWorkingStatus } from "./GroupWorkingStatus";
import type { MentionMember } from "./groupMentions";
import { buildGroupThreads } from "./groupThreads";
import { memberLabels } from "./memberLabels";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";
import type { GroupMemberStatesById } from "./useWorkingGroups";

export const GROUP_ROOM_EMPTY_TEXT =
  "Write to the group. Members pick up what fits — or @mention someone.";

export {
  GroupMessageRow,
  isActiveWaitingStatus,
  isNoNextOwnerStatus,
  isWaitingStatus,
  memberColor,
  StatusText,
  splitTrailingCollabStatuses,
} from "./GroupMessageRow";

export function GroupMessageList({
  avatars,
  members,
  memberStates,
  messages,
  loaded,
  hasOlder,
  loadingOlder,
  error,
  loadOlder,
  cwd,
  onOpenFile,
  onHandoffClick,
  onReply,
  workingRows,
  roles,
  groupId,
}: {
  avatars: ReadonlyMap<string, WorkingMemberAvatar>;
  groupId: string;
  members: readonly MentionMember[];
  /** Kept for callers; live rows come from `workingRows`. */
  memberStates: GroupMemberStatesById;
  /** Owned by GroupRoom (shared with Activity). */
  messages: readonly GroupMessage[];
  loaded: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  error: string | undefined;
  loadOlder(): Promise<void>;
  cwd: string | undefined;
  onOpenFile: ((path: string) => void) | undefined;
  /** Click a natural handoff phrase to seed `@Name` in the composer. */
  onHandoffClick?: ((targetName: string) => void) | undefined;
  /** N3: start a thread reply from a room message. */
  onReply?: ((message: GroupMessage) => void) | undefined;
  /** Shared live-turn rows from GroupRoom (also feeds Activity). */
  workingRows: readonly GroupMemberWorkingRow[];
  /** Optional role label per session id. */
  roles?: ReadonlyMap<string, string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ first: string | undefined; height: number; nearBottom: boolean }>({
    first: undefined,
    height: 0,
    nearBottom: true,
  });
  const labels = useMemo(() => memberLabels(members), [members]);
  const threads = useMemo(() => buildGroupThreads(messages), [messages]);
  const activeWaiting = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of memberStates.values()) {
      for (const sessionId of entry.waitingSessionIds) ids.add(sessionId);
    }
    return ids;
  }, [memberStates]);

  // Linger in-flight streams after the run ends until persist reconcile.
  const [lingerBySession, setLingerBySession] = useState<
    ReadonlyMap<string, GroupMemberWorkingRow>
  >(() => new Map());
  useEffect(() => {
    setLingerBySession((previous) => {
      const next = new Map(previous);
      const workingIds = new Set(workingRows.map((row) => row.sessionId));
      for (const row of workingRows) next.set(row.sessionId, row);
      for (const [sessionId, row] of next) {
        const stillWorking = workingIds.has(sessionId);
        if (
          !shouldShowInFlightRow({
            sessionId,
            streamText: row.live.streamText,
            collapsed: row.live.collapsed,
            stillWorking,
            messages,
          })
        ) {
          next.delete(sessionId);
        }
      }
      return next;
    });
  }, [workingRows, messages]);

  const visibleWorkingRows = useMemo(() => {
    const workingIds = new Set(workingRows.map((row) => row.sessionId));
    const ordered: GroupMemberWorkingRow[] = [...workingRows];
    for (const [sessionId, row] of lingerBySession) {
      if (workingIds.has(sessionId)) continue;
      if (
        shouldShowInFlightRow({
          sessionId,
          streamText: row.live.streamText,
          collapsed: row.live.collapsed,
          stillWorking: false,
          messages,
        })
      ) {
        ordered.push(row);
      }
    }
    return ordered;
  }, [workingRows, lingerBySession, messages]);

  // Older page prepended: keep the view where it was. New message / working strip:
  // follow the bottom only when the user was already near it.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    void visibleWorkingRows;
    const previous = anchorRef.current;
    const first = messages[0]?.id;
    if (previous.first && first !== previous.first && node.scrollHeight > previous.height) {
      node.scrollTop += node.scrollHeight - previous.height;
    } else if (previous.nearBottom) {
      node.scrollTop = node.scrollHeight;
    }
    anchorRef.current = { first, height: node.scrollHeight, nearBottom: previous.nearBottom };
  }, [messages, visibleWorkingRows]);

  // A first page shorter than the viewport cannot be scrolled: load on.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || node.clientHeight === 0 || !hasOlder || loadingOlder) return;
    if (node.scrollHeight <= node.clientHeight) void loadOlder();
  }, [hasOlder, loadingOlder, loadOlder]);

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid="group-message-list"
      onScroll={(event) => {
        const node = event.currentTarget;
        anchorRef.current.nearBottom = isNearBottom(
          node.scrollHeight,
          node.scrollTop,
          node.clientHeight,
        );
        anchorRef.current.height = node.scrollHeight;
        if (node.scrollTop < 40 && hasOlder && !loadingOlder) void loadOlder();
      }}
      ref={scrollRef}
    >
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-5">
        {loadingOlder ? (
          <div className="text-center text-2xs text-fg-faint">Loading older messages…</div>
        ) : null}
        {error ? <div className="text-center text-danger text-xs">{error}</div> : null}
        {loaded && messages.length === 0 && !error && visibleWorkingRows.length === 0 ? (
          <div className="py-16 text-center text-fg-faint text-sm" data-testid="group-room-empty">
            {GROUP_ROOM_EMPTY_TEXT}
          </div>
        ) : null}
        {threads.map((thread) => (
          <div className="flex flex-col gap-1.5" data-testid="group-thread" key={thread.root.id}>
            <GroupMessageRow
              activeWaitingSessionIds={activeWaiting}
              avatar={
                thread.root.authorSessionId ? avatars.get(thread.root.authorSessionId) : undefined
              }
              cwd={cwd}
              labels={labels}
              members={members}
              message={thread.root}
              onHandoffClick={onHandoffClick}
              onOpenFile={onOpenFile}
              onReply={onReply}
              role={
                thread.root.authorSessionId ? roles?.get(thread.root.authorSessionId) : undefined
              }
            />
            {thread.replies.length > 0 ? (
              <div
                className="ml-4 flex flex-col gap-1.5 border-hairline border-l pl-3"
                data-testid="group-thread-replies"
              >
                {thread.replies.map((message) => (
                  <GroupMessageRow
                    activeWaitingSessionIds={activeWaiting}
                    avatar={
                      message.authorSessionId ? avatars.get(message.authorSessionId) : undefined
                    }
                    cwd={cwd}
                    key={message.id}
                    labels={labels}
                    members={members}
                    message={message}
                    onHandoffClick={onHandoffClick}
                    onOpenFile={onOpenFile}
                    onReply={onReply}
                    role={message.authorSessionId ? roles?.get(message.authorSessionId) : undefined}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ))}
        <GroupWorkingStatus
          avatars={avatars}
          groupId={groupId}
          labels={labels}
          members={members}
          rows={visibleWorkingRows}
          {...(roles ? { roles } : {})}
        />
      </div>
    </div>
  );
}
