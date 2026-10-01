import { IconSearch, IconX } from "@tabler/icons-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GroupMessage } from "../../../../shared/contracts";
import {
  estimateTokensByExecution,
  executionTokenAnchorIds,
  filterMessagesByGroupSearch,
  withGroupDaySeparators,
} from "../../../../shared/group-conversation-minors";
import { isNearBottom } from "../../../../shared/group-room-transcript";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { GroupMessageRow, type WorkingMemberAvatar } from "./GroupMessageRow";
import { GroupWorkingStatus } from "./GroupWorkingStatus";
import type { MentionMember } from "./groupMentions";
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
  const [searchQuery, setSearchQuery] = useState("");
  const [searchGroupId, setSearchGroupId] = useState(groupId);
  if (searchGroupId !== groupId) {
    setSearchGroupId(groupId);
    setSearchQuery("");
  }
  const labels = useMemo(() => memberLabels(members), [members]);
  const roomMessages = useMemo(
    () => messages.filter((message) => message.groupId === groupId),
    [messages, groupId],
  );
  // An agent may complete a turn silently. Keep its canonical record in the
  // store, but leave no empty "Completed" bubble in the user's conversation.
  const renderedMessages = useMemo(
    () =>
      filterMessagesByGroupSearch(
        roomMessages.filter(
          (message) =>
            !(
              message.authorKind === "agent" &&
              message.turnId &&
              message.status === "completed" &&
              !message.body.trim()
            ),
        ),
        searchQuery,
        labels,
      ),
    [roomMessages, searchQuery, labels],
  );
  const transcriptItems = useMemo(
    () => withGroupDaySeparators(renderedMessages),
    [renderedMessages],
  );
  const tokenTotals = useMemo(
    () => estimateTokensByExecution(renderedMessages),
    [renderedMessages],
  );
  const tokenAnchors = useMemo(() => executionTokenAnchorIds(renderedMessages), [renderedMessages]);
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

  // Prepending older pages preserves the reading position. Revisions of an
  // existing card never count as new messages or move a reader above the bottom.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    // Presence changes can change the scroll height without adding public messages.
    void visibleWorkingRows;
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
  }, [roomMessages, visibleWorkingRows, groupId]);

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

  const searching = searchQuery.trim().length > 0;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[760px] shrink-0 items-center gap-2 px-3 pt-3 sm:px-6">
        <label
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-hairline bg-elevated/80 px-2.5 py-1.5 text-fg-muted"
          data-testid="group-conversation-search"
        >
          <IconSearch className="shrink-0 text-fg-faint" size={ICON.sm} stroke={ICON_STROKE.sm} />
          <input
            aria-label="Search in conversation"
            className="min-w-0 flex-1 bg-transparent text-fg text-xs outline-none placeholder:text-fg-faint"
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder="Search in conversation"
            type="search"
            value={searchQuery}
          />
          {searching ? (
            <button
              aria-label="Clear search"
              className="shrink-0 text-fg-faint hover:text-fg"
              onClick={() => setSearchQuery("")}
              type="button"
            >
              <IconX size={ICON.xs} stroke={ICON_STROKE.sm} />
            </button>
          ) : null}
        </label>
      </div>
      <div
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
        data-testid="group-message-list"
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
          {searching && renderedMessages.length === 0 && roomMessages.length > 0 ? (
            <div
              className="py-10 text-center text-fg-faint text-sm"
              data-testid="group-conversation-search-empty"
            >
              No messages match “{searchQuery.trim()}”.
            </div>
          ) : null}
          {transcriptItems.map((item) => {
            if (item.type === "day") {
              return (
                <div
                  className="flex items-center gap-3 py-1"
                  data-testid="group-day-separator"
                  key={item.key}
                >
                  <span className="h-px flex-1 bg-hairline" />
                  <span className="shrink-0 text-2xs text-fg-faint">{item.label}</span>
                  <span className="h-px flex-1 bg-hairline" />
                </div>
              );
            }
            const message = item.message;
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
            return (
              <GroupMessageRow
                activeWaitingSessionIds={activeWaiting}
                avatar={message.authorSessionId ? avatars.get(message.authorSessionId) : undefined}
                cwd={cwd}
                executionTokenTotal={
                  tokenAnchors.has(message.id)
                    ? tokenTotals.get(message.chainId ?? message.id)
                    : undefined
                }
                key={message.id}
                labels={labels}
                liveTurn={
                  hasActiveTurn && liveRow ? { mode: liveRow.mode, live: liveRow.live } : undefined
                }
                members={members}
                message={message}
                onHandoffClick={onHandoffClick}
                onOpenFile={onOpenFile}
                onReply={onReply}
                onRetry={onRetry}
                replyToMessage={
                  message.replyToMessageId ? byId.get(message.replyToMessageId) : undefined
                }
                role={message.authorSessionId ? roles?.get(message.authorSessionId) : undefined}
              />
            );
          })}
          <GroupWorkingStatus
            avatars={avatars}
            groupId={groupId}
            labels={labels}
            members={members}
            rows={searching ? [] : visibleWorkingRows}
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
