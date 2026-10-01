import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GroupMessage } from "../../../../shared/contracts";
import { isNearBottom } from "../../../../shared/group-room-transcript";
import { GroupMessageRow, type WorkingMemberAvatar } from "./GroupMessageRow";
import { GroupWorkingStatus } from "./GroupWorkingStatus";
import type { MentionMember } from "./groupMentions";
import { memberLabels } from "./memberLabels";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";
import type { GroupMemberStatesById } from "./useWorkingGroups";

export const GROUP_ROOM_EMPTY_TEXT =
  "Write to the group. Members pick up what fits — or @mention someone.";

/** Virtualize once the transcript is large enough to matter for scroll cost. */
export const GROUP_MESSAGE_VIRTUALIZE_THRESHOLD = 40;

/** Estimated row height before measure (compact agent cards ~120px). */
const ESTIMATED_MESSAGE_ROW_PX = 120;

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
  onRetry,
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
  /** Quote a room message in the next reply. */
  onReply?: ((message: GroupMessage) => void) | undefined;
  onRetry?: ((message: GroupMessage) => Promise<void>) | undefined;
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
  const roomMessages = useMemo(
    () => messages.filter((message) => message.groupId === groupId),
    [messages, groupId],
  );
  // An agent may complete a turn silently. Keep its canonical record in the
  // store, but leave no empty "Completed" bubble in the user's conversation.
  const renderedMessages = useMemo(
    () =>
      roomMessages.filter(
        (message) =>
          !(
            message.authorKind === "agent" &&
            message.turnId &&
            message.status === "completed" &&
            !message.body.trim()
          ),
      ),
    [roomMessages],
  );
  const byId = useMemo(
    () => new Map(roomMessages.map((message) => [message.id, message])),
    [roomMessages],
  );
  const [newMessageCount, setNewMessageCount] = useState(0);
  const previousRoomRef = useRef(groupId);
  const previousLastRef = useRef<string | undefined>(undefined);
  const activeWaiting = useMemo(() => {
    const ids = new Set<string>();
    for (const sessionId of memberStates.get(groupId)?.waitingSessionIds ?? []) ids.add(sessionId);
    return ids;
  }, [memberStates, groupId]);

  // Public text lives only in canonical cards. Presence is a compact fallback for
  // active members whose canonical queued/running card has not arrived yet.
  const visibleWorkingRows = useMemo(() => {
    const memberIds = new Set(members.map((member) => member.sessionId));
    const represented = new Set(
      roomMessages
        .filter(
          (message) =>
            message.status &&
            ["queued", "running", "writing", "awaiting_user"].includes(message.status),
        )
        .map((message) => message.authorSessionId),
    );
    return workingRows.filter(
      (row) =>
        memberIds.has(row.sessionId) && !row.live.collapsed && !represented.has(row.sessionId),
    );
  }, [workingRows, roomMessages, members]);
  const liveBySession = useMemo(
    () => new Map(workingRows.map((row) => [row.sessionId, row])),
    [workingRows],
  );
  const activeMessageBySession = useMemo(() => {
    const active = new Map<string, string>();
    for (const message of renderedMessages) {
      if (
        message.authorKind === "agent" &&
        message.authorSessionId &&
        message.status &&
        ["queued", "running", "writing", "awaiting_user"].includes(message.status)
      ) {
        active.set(message.authorSessionId, message.id);
      }
    }
    return active;
  }, [renderedMessages]);

  const [viewportHeight, setViewportHeight] = useState(0);
  const virtualize =
    renderedMessages.length >= GROUP_MESSAGE_VIRTUALIZE_THRESHOLD && viewportHeight > 0;
  const virtualizer = useVirtualizer({
    count: virtualize ? renderedMessages.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_MESSAGE_ROW_PX,
    getItemKey: (index) => renderedMessages[index]?.id ?? index,
    overscan: 8,
    enabled: virtualize,
    initialRect: { width: 760, height: Math.max(viewportHeight, 1) },
    // Prefer clientHeight (tests can stub it); fall back to measured viewport state.
    observeElementRect: (instance, callback) => {
      const element = instance.scrollElement as HTMLElement | null;
      const report = () => {
        const height = element?.clientHeight || viewportHeight;
        callback({
          width: element?.clientWidth || 760,
          height: Math.max(height, 1),
        });
      };
      report();
      if (!element || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(report);
      observer.observe(element);
      return () => observer.disconnect();
    },
  });
  const virtualTotalSize = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    const node = scrollRef.current;
    // Re-measure when the room or transcript size changes (threshold crossing).
    void groupId;
    void renderedMessages.length;
    if (!node) {
      setViewportHeight(0);
      return;
    }
    const sync = () => setViewportHeight(node.clientHeight);
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, [groupId, renderedMessages.length]);

  // Prepending older pages preserves the reading position. Revisions of an
  // existing card never count as new messages or move a reader above the bottom.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    // Presence changes can change the scroll height without adding public messages.
    void visibleWorkingRows;
    void virtualTotalSize;
    if (previousRoomRef.current !== groupId) {
      previousRoomRef.current = groupId;
      previousLastRef.current = undefined;
      anchorRef.current = { first: undefined, height: 0, nearBottom: true };
      setNewMessageCount(0);
    }
    const previous = anchorRef.current;
    const first = roomMessages[0]?.id;
    const previousLast = previousLastRef.current;
    const lastIndex = previousLast
      ? roomMessages.findIndex((message) => message.id === previousLast)
      : -1;
    const appended = lastIndex >= 0 ? roomMessages.length - lastIndex - 1 : 0;
    if (!previous.nearBottom && appended > 0) setNewMessageCount((count) => count + appended);
    if (previous.first && first !== previous.first && node.scrollHeight > previous.height) {
      node.scrollTop += node.scrollHeight - previous.height;
    } else if (previous.nearBottom) {
      node.scrollTop = node.scrollHeight;
    }
    previousLastRef.current = roomMessages.at(-1)?.id;
    anchorRef.current = { first, height: node.scrollHeight, nearBottom: previous.nearBottom };
  }, [roomMessages, visibleWorkingRows, groupId, virtualTotalSize]);

  function jumpToLatest(): void {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    anchorRef.current.nearBottom = true;
    setNewMessageCount(0);
  }

  // A first page shorter than the viewport cannot be scrolled: load on.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || node.clientHeight === 0 || !hasOlder || loadingOlder) return;
    if (node.scrollHeight <= node.clientHeight) void loadOlder();
  }, [hasOlder, loadingOlder, loadOlder]);

  const messageRowProps = (message: GroupMessage) => {
    const liveRow =
      message.authorKind === "agent" && message.authorSessionId
        ? liveBySession.get(message.authorSessionId)
        : undefined;
    const hasActiveTurn =
      message.authorKind === "agent" &&
      message.authorSessionId &&
      activeMessageBySession.get(message.authorSessionId) === message.id &&
      liveRow &&
      !liveRow.live.collapsed;
    return {
      activeWaitingSessionIds: activeWaiting,
      avatar: message.authorSessionId ? avatars.get(message.authorSessionId) : undefined,
      cwd,
      labels,
      liveTurn: hasActiveTurn && liveRow ? { mode: liveRow.mode, live: liveRow.live } : undefined,
      members,
      message,
      onHandoffClick,
      onOpenFile,
      onReply,
      onRetry,
      replyToMessage: message.replyToMessageId ? byId.get(message.replyToMessageId) : undefined,
      role: message.authorSessionId ? roles?.get(message.authorSessionId) : undefined,
    };
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
        data-testid="group-message-list"
        data-virtualized={virtualize ? "true" : "false"}
        onScroll={(event) => {
          const node = event.currentTarget;
          anchorRef.current.nearBottom = isNearBottom(
            node.scrollHeight,
            node.scrollTop,
            node.clientHeight,
          );
          anchorRef.current.height = node.scrollHeight;
          if (anchorRef.current.nearBottom) setNewMessageCount(0);
          if (node.scrollTop < 40 && hasOlder && !loadingOlder) void loadOlder();
        }}
        ref={scrollRef}
      >
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-3 py-5 sm:px-6">
          {loadingOlder ? (
            <div className="text-center text-2xs text-fg-faint">Loading older messages…</div>
          ) : null}
          {error ? <div className="text-center text-danger text-xs">{error}</div> : null}
          {loaded && roomMessages.length === 0 && !error && visibleWorkingRows.length === 0 ? (
            <div className="py-16 text-center text-fg-faint text-sm" data-testid="group-room-empty">
              {GROUP_ROOM_EMPTY_TEXT}
            </div>
          ) : null}
          {virtualize ? (
            <div
              className="relative w-full"
              data-testid="group-message-virtualizer"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((row) => {
                const message = renderedMessages[row.index];
                if (!message) return null;
                return (
                  <div
                    className="absolute top-0 left-0 w-full pb-3"
                    data-index={row.index}
                    key={message.id}
                    ref={virtualizer.measureElement}
                    style={{ transform: `translateY(${row.start}px)` }}
                  >
                    <GroupMessageRow {...messageRowProps(message)} />
                  </div>
                );
              })}
            </div>
          ) : (
            renderedMessages.map((message) => (
              <GroupMessageRow key={message.id} {...messageRowProps(message)} />
            ))
          )}
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
      {newMessageCount > 0 ? (
        <button
          aria-label={`${newMessageCount} new ${newMessageCount === 1 ? "message" : "messages"}`}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-hairline bg-elevated px-3 py-1.5 text-xs text-fg shadow-lg hover:bg-hover"
          data-testid="group-new-messages"
          onClick={jumpToLatest}
          type="button"
        >
          {newMessageCount} new {newMessageCount === 1 ? "message" : "messages"} ↓
        </button>
      ) : null}
    </div>
  );
}
