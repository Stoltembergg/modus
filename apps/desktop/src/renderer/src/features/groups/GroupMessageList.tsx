import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { GroupMessage } from "../../../../shared/contracts";
import { MarkdownMessage } from "../agent/MarkdownMessage";
import { AgentAvatar } from "../agents/AgentAvatar";
import { GroupWorkingStatus, type WorkingMemberAvatar } from "./GroupWorkingStatus";
import { linkMentionsInMarkdown, type MentionMember, splitMentions } from "./groupMentions";
import { MemberName } from "./MemberName";
import { MentionChip } from "./MentionChip";
import { type MemberLabel, memberLabels } from "./memberLabels";
import { useGroupMemberWorking } from "./useGroupMemberWorking";
import { useGroupMessages } from "./useGroupMessages";
import type { GroupMemberStatesById } from "./useWorkingGroups";

export const GROUP_ROOM_EMPTY_TEXT = "Write to the group. The lead answers, or @mention a member.";

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
  groupId,
  members,
  memberStates,
  cwd,
  onOpenFile,
}: {
  avatars: ReadonlyMap<string, WorkingMemberAvatar>;
  groupId: string;
  members: readonly MentionMember[];
  memberStates: GroupMemberStatesById;
  cwd: string | undefined;
  onOpenFile: ((path: string) => void) | undefined;
}) {
  const { messages, loaded, hasOlder, loadingOlder, error, loadOlder } = useGroupMessages(groupId);
  const workingRows = useGroupMemberWorking(groupId, memberStates);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ first: string | undefined; height: number; nearBottom: boolean }>({
    first: undefined,
    height: 0,
    nearBottom: true,
  });
  const labels = useMemo(() => memberLabels(members), [members]);

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
        {messages.map((message) => (
          <GroupMessageRow
            avatar={message.authorSessionId ? avatars.get(message.authorSessionId) : undefined}
            cwd={cwd}
            key={message.id}
            labels={labels}
            members={members}
            message={message}
            onOpenFile={onOpenFile}
          />
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

export function GroupMessageRow({
  avatar,
  message,
  members,
  labels,
  cwd,
  onOpenFile,
}: {
  message: GroupMessage;
  members: readonly MentionMember[];
  labels: ReadonlyMap<string, MemberLabel>;
  cwd?: string | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  /** The author's avatar (a current member); a former member keeps the initial badge. */
  avatar?: WorkingMemberAvatar | undefined;
}) {
  const author: MemberLabel | undefined = message.authorSessionId
    ? (labels.get(message.authorSessionId) ?? { title: message.authorSessionId })
    : undefined;
  if (message.kind === "status") {
    const waiting = isWaitingStatus(message.body);
    return (
      <div
        className="text-center text-2xs text-fg-faint"
        data-kind="status"
        data-testid="group-message"
      >
        {author && message.authorKind === "agent" ? (
          <span className="text-fg-subtle">
            <MemberName label={author} /> ·{" "}
          </span>
        ) : null}
        <span
          className={waiting ? "text-amber-400" : undefined}
          data-waiting={waiting || undefined}
        >
          <StatusText members={members} text={message.body} />
        </span>
      </div>
    );
  }
  if (message.authorKind === "user") {
    return (
      <div className="flex justify-end" data-kind="user" data-testid="group-message">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-elevated px-3.5 py-2 text-fg text-sm">
          <MentionText members={members} text={message.body} />
        </div>
      </div>
    );
  }
  const sessionId = message.authorSessionId ?? "";
  const label = author ?? { title: "Member" };
  const title = label.title;
  return (
    <div className="flex gap-2.5" data-kind="member" data-testid="group-message">
      {avatar ? (
        <AgentAvatar
          animated={false}
          className="mt-0.5"
          color={avatar.color}
          face={avatar.face}
          seed={avatar.agentId}
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
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 font-medium text-fg-muted text-xs">
          <MemberName label={label} />
        </div>
        <div className="text-fg text-sm">
          <MarkdownMessage
            content={linkMentionsInMarkdown(message.body, members)}
            cwd={cwd}
            onOpenFile={onOpenFile}
          />
        </div>
      </div>
    </div>
  );
}
