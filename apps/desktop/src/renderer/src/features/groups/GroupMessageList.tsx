import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { GroupMessage } from "../../../../shared/contracts";
import {
  formatGroupCollabStatus,
  GROUP_COLLAB_NO_NEXT_OWNER,
  type GroupCollabStatus,
  parseGroupCollabStatusLine,
} from "../../../../shared/group-collab-status";
import { MarkdownMessage } from "../agent/MarkdownMessage";
import { AgentAvatar } from "../agents/AgentAvatar";
import { GroupWorkingStatus, type WorkingMemberAvatar } from "./GroupWorkingStatus";
import { linkMentionsInMarkdown, type MentionMember, splitMentions } from "./groupMentions";
import { buildGroupThreads } from "./groupThreads";
import { MemberName } from "./MemberName";
import { MentionChip } from "./MentionChip";
import { type MemberLabel, memberLabels } from "./memberLabels";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";
import type { GroupMemberStatesById } from "./useWorkingGroups";

/** Peel trailing collab status lines off an agent reply for transcript rendering. */
export function splitTrailingCollabStatuses(body: string): {
  prose: string;
  statuses: GroupCollabStatus[];
} {
  const lines = body.split("\n");
  const statuses: GroupCollabStatus[] = [];
  while (lines.length > 0) {
    const parsed = parseGroupCollabStatusLine(lines[lines.length - 1] ?? "");
    if (!parsed) break;
    statuses.unshift(parsed);
    lines.pop();
  }
  return { prose: lines.join("\n").replace(/\s+$/u, ""), statuses };
}

export const GROUP_ROOM_EMPTY_TEXT =
  "Write to the group. Members pick up what fits — or @mention someone.";

const MEMBER_COLORS = [
  "#e8784a",
  "#4a9ee8",
  "#57b87a",
  "#b57ae8",
  "#e8b04a",
  "#e85a8c",
  "#4ac2c2",
  "#8f9ae8",
];

/** Stable per-member color for the initial badge. */
export function memberColor(sessionId: string): string {
  let hash = 0;
  for (const char of sessionId) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return MEMBER_COLORS[hash % MEMBER_COLORS.length] ?? "#8f9ae8";
}

export function GroupMessageList({
  avatars,
  members,
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
}: {
  avatars: ReadonlyMap<string, WorkingMemberAvatar>;
  /** Kept for callers / future room-scoped list behavior. */
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
  /** P2: click a Handoff card to seed `@Name` in the composer. */
  onHandoffClick?: ((targetName: string) => void) | undefined;
  /** N3: start a thread reply from a room message. */
  onReply?: ((message: GroupMessage) => void) | undefined;
  /** Shared live-turn rows from GroupRoom (also feeds Activity). */
  workingRows: readonly GroupMemberWorkingRow[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ first: string | undefined; height: number; nearBottom: boolean }>({
    first: undefined,
    height: 0,
    nearBottom: true,
  });
  const labels = useMemo(() => memberLabels(members), [members]);
  const threads = useMemo(() => buildGroupThreads(messages), [messages]);

  // Older page prepended: keep the view where it was. New message / working strip:
  // follow the bottom when the user was already there.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    // Touch workingRows so layout re-runs when the Thinking strip appears/updates.
    void workingRows;
    const previous = anchorRef.current;
    const first = messages[0]?.id;
    if (previous.first && first !== previous.first && node.scrollHeight > previous.height) {
      node.scrollTop += node.scrollHeight - previous.height;
    } else if (previous.nearBottom) {
      node.scrollTop = node.scrollHeight;
    }
    anchorRef.current = { first, height: node.scrollHeight, nearBottom: previous.nearBottom };
  }, [messages, workingRows]);

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
        anchorRef.current.nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
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
        {loaded && messages.length === 0 && !error && workingRows.length === 0 ? (
          <div className="py-16 text-center text-fg-faint text-sm" data-testid="group-room-empty">
            {GROUP_ROOM_EMPTY_TEXT}
          </div>
        ) : null}
        {threads.map((thread) => (
          <div className="flex flex-col gap-2" data-testid="group-thread" key={thread.root.id}>
            <GroupMessageRow
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
            />
            {thread.replies.length > 0 ? (
              <div
                className="ml-4 flex flex-col gap-2 border-hairline border-l pl-3"
                data-testid="group-thread-replies"
              >
                {thread.replies.map((message) => (
                  <GroupMessageRow
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
                  />
                ))}
              </div>
            ) : null}
          </div>
        ))}
        <GroupWorkingStatus avatars={avatars} labels={labels} rows={workingRows} />
      </div>
    </div>
  );
}

function MentionText({ text, members }: { text: string; members: readonly MentionMember[] }) {
  return (
    <>
      {splitMentions(text, members).map((segment, index) =>
        segment.kind === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
          <span key={index}>{segment.text}</span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
          <MentionChip key={index}>@{segment.label}</MentionChip>
        ),
      )}
    </>
  );
}

/** Status bodies: only `inline code` spans are formatted (no full markdown). */
export function StatusText({ text, members }: { text: string; members: readonly MentionMember[] }) {
  return (
    <>
      {text.split(/`([^`\n]+)`/).map((part, index) =>
        index % 2 === 1 ? (
          <code
            className="rounded-sm bg-elevated px-1 py-px font-mono text-[0.95em]"
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
            key={index}
          >
            {part}
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
          <MentionText key={index} members={members} text={part} />
        ),
      )}
    </>
  );
}

/** "Waiting for you" and its limit / budget variants (amber, like the waiting dot). */
export function isWaitingStatus(body: string): boolean {
  return body.startsWith("Waiting for you");
}

export function isNoNextOwnerStatus(body: string): boolean {
  return body === GROUP_COLLAB_NO_NEXT_OWNER;
}

function CollabStatusLine({
  status,
  members,
  onHandoffClick,
}: {
  status: GroupCollabStatus;
  members: readonly MentionMember[];
  onHandoffClick?: ((targetName: string) => void) | undefined;
}) {
  const text = formatGroupCollabStatus(status);
  if (status.kind === "handoff" && onHandoffClick && status.targetName.trim()) {
    return (
      <button
        className="block max-w-full rounded-md border border-hairline bg-elevated/60 px-2 py-1 text-left text-2xs text-fg-subtle transition-colors hover:border-hairline-strong hover:text-fg"
        data-collab={status.kind}
        data-testid="group-collab-status"
        onClick={() => onHandoffClick(status.targetName.trim())}
        type="button"
      >
        <StatusText members={members} text={text} />
      </button>
    );
  }
  return (
    <div
      className="text-2xs text-fg-subtle"
      data-collab={status.kind}
      data-testid="group-collab-status"
    >
      <StatusText members={members} text={text} />
    </div>
  );
}

export function GroupMessageRow({
  avatar,
  message,
  members,
  labels,
  cwd,
  onOpenFile,
  onHandoffClick,
  onReply,
}: {
  message: GroupMessage;
  members: readonly MentionMember[];
  labels: ReadonlyMap<string, MemberLabel>;
  cwd?: string | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  onHandoffClick?: ((targetName: string) => void) | undefined;
  onReply?: ((message: GroupMessage) => void) | undefined;
  /** The author's avatar (a current member); a former member keeps the initial badge. */
  avatar?: WorkingMemberAvatar | undefined;
}) {
  const author: MemberLabel | undefined = message.authorSessionId
    ? (labels.get(message.authorSessionId) ?? { title: message.authorSessionId })
    : undefined;
  const toLabel = message.toSessionId
    ? (labels.get(message.toSessionId) ?? { title: message.toSessionId })
    : undefined;
  if (message.kind === "status") {
    const waiting = isWaitingStatus(message.body);
    const nudge = isNoNextOwnerStatus(message.body);
    const collab = parseGroupCollabStatusLine(message.body);
    return (
      <div
        className="text-center text-2xs text-fg-faint"
        data-collab={collab?.kind}
        data-kind="status"
        data-testid="group-message"
      >
        {author && message.authorKind === "agent" ? (
          <span className="text-fg-subtle">
            <MemberName label={author} /> ·{" "}
          </span>
        ) : null}
        <span
          className={waiting || nudge ? "text-amber-400" : undefined}
          data-nudge={nudge || undefined}
          data-waiting={waiting || undefined}
        >
          <StatusText members={members} text={message.body} />
        </span>
      </div>
    );
  }
  if (message.authorKind === "user") {
    return (
      <div className="group/msg flex flex-col items-end gap-1">
        <div className="flex max-w-[80%] justify-end" data-kind="user" data-testid="group-message">
          <div className="whitespace-pre-wrap rounded-2xl bg-elevated px-3.5 py-2 text-fg text-sm">
            <MentionText members={members} text={message.body} />
          </div>
        </div>
        {onReply ? (
          <button
            aria-label="Reply in thread"
            className="text-2xs text-fg-faint opacity-0 transition-opacity hover:text-fg-muted group-hover/msg:opacity-100 focus:opacity-100"
            data-testid="group-message-reply"
            onClick={() => onReply(message)}
            type="button"
          >
            Reply
          </button>
        ) : null}
      </div>
    );
  }
  const sessionId = message.authorSessionId ?? "";
  const label = author ?? { title: "Member" };
  const title = label.title;
  const { prose, statuses } = splitTrailingCollabStatuses(message.body);
  return (
    <div className="group/msg flex flex-col gap-1" data-to={message.toSessionId || undefined}>
      <div className="flex gap-2.5" data-kind="member" data-testid="group-message">
        {avatar ? (
          <AgentAvatar
            animated={false}
            className="mt-0.5"
            color={avatar.color}
            face={avatar.face}
            seed={avatar.agentId}
            shape={avatar.shape}
            size={20}
            state={avatar.archived ? "archived" : "idle"}
          />
        ) : (
          <span
            aria-hidden
            className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full font-medium text-white text-xs"
            style={{ backgroundColor: memberColor(sessionId) }}
          >
            {title.trim().charAt(0).toLocaleUpperCase() || "?"}
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="mb-0.5 flex flex-wrap items-baseline gap-x-1.5 font-medium text-fg-muted text-xs">
            <MemberName label={label} />
            {toLabel ? (
              <span className="font-normal text-fg-faint" data-testid="group-message-to">
                → <MemberName label={toLabel} />
              </span>
            ) : null}
          </div>
          {prose ? (
            <div className="text-fg text-sm">
              <MarkdownMessage
                content={linkMentionsInMarkdown(prose, members)}
                cwd={cwd}
                onOpenFile={onOpenFile}
              />
            </div>
          ) : null}
          {statuses.map((status, index) => (
            <CollabStatusLine
              // biome-ignore lint/suspicious/noArrayIndexKey: trailing status lines are positional
              key={`${status.kind}-${index}`}
              members={members}
              onHandoffClick={onHandoffClick}
              status={status}
            />
          ))}
        </div>
      </div>
      {onReply ? (
        <button
          aria-label="Reply in thread"
          className="ml-8 self-start text-2xs text-fg-faint opacity-0 transition-opacity hover:text-fg-muted group-hover/msg:opacity-100 focus:opacity-100"
          data-testid="group-message-reply"
          onClick={() => onReply(message)}
          type="button"
        >
          Reply
        </button>
      ) : null}
    </div>
  );
}
