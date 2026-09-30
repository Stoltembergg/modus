import type {
  AgentAvatarColor,
  AgentAvatarFace,
  AgentAvatarShape,
  GroupMessage,
} from "../../../../shared/contracts";
import type { GroupCollabStatus } from "../../../../shared/group-collab-status";
import {
  GROUP_COLLAB_NO_NEXT_OWNER,
  parseGroupCollabStatusLine,
} from "../../../../shared/group-collab-status";
import {
  collabStatusTone,
  formatNaturalCollabStatus,
  type RoomMessageTone,
  splitRoomMessageBody,
} from "../../../../shared/group-room-transcript";
import { cn } from "../../lib/cn";
import { MarkdownMessage } from "../agent/MarkdownMessage";
import { AgentAvatar } from "../agents/AgentAvatar";
import { GroupMemberLiveTurn } from "./GroupMemberLiveTurn";
import type { GroupLiveTurnSnapshot } from "./groupLiveTurn";
import { linkMentionsInMarkdown, type MentionMember, splitMentions } from "./groupMentions";
import { MemberName } from "./MemberName";
import { MentionChip } from "./MentionChip";
import type { MemberLabel } from "./memberLabels";

/** Avatar fields shared by room messages and in-flight rows. */
export type WorkingMemberAvatar = {
  agentId: string;
  face: AgentAvatarFace;
  color: AgentAvatarColor;
  shape: AgentAvatarShape;
  archived: boolean;
};

/** Peel trailing collab status lines (+ ops packet) for transcript rendering. */
export function splitTrailingCollabStatuses(body: string): {
  prose: string;
  statuses: GroupCollabStatus[];
} {
  const { prose, statuses } = splitRoomMessageBody(body);
  return { prose, statuses };
}

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

function toneClass(tone: RoomMessageTone): string | undefined {
  switch (tone) {
    case "ask":
      return "text-amber-400";
    case "block":
      return "border-l-2 border-amber-400/70 pl-2 text-amber-100/90";
    case "temporary":
      return "text-fg-subtle italic";
    default:
      return undefined;
  }
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

/**
 * Amber "Waiting for you" is only for an *active* pending ask_user/approval.
 * Historical status lines stay in the transcript but lose the sticky amber tone.
 */
export function isActiveWaitingStatus(
  body: string,
  authorSessionId: string | undefined,
  activeWaitingSessionIds: ReadonlySet<string> | readonly string[],
): boolean {
  if (!isWaitingStatus(body) || !authorSessionId) return false;
  if (typeof (activeWaitingSessionIds as ReadonlySet<string>).has === "function") {
    return (activeWaitingSessionIds as ReadonlySet<string>).has(authorSessionId);
  }
  return (activeWaitingSessionIds as readonly string[]).includes(authorSessionId);
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
  const text = formatNaturalCollabStatus(status);
  const tone = collabStatusTone(status);
  if (status.kind === "handoff" && onHandoffClick && status.targetName.trim()) {
    return (
      <button
        className={cn(
          "block max-w-full text-left text-sm text-fg transition-colors hover:text-fg",
          toneClass(tone),
        )}
        data-collab={status.kind}
        data-testid="group-collab-status"
        data-tone={tone}
        onClick={() => onHandoffClick(status.targetName.trim())}
        type="button"
      >
        <StatusText members={members} text={text} />
      </button>
    );
  }
  return (
    <div
      className={cn("text-sm", toneClass(tone) ?? "text-fg-subtle")}
      data-collab={status.kind}
      data-testid="group-collab-status"
      data-tone={tone}
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
  role,
  activeWaitingSessionIds,
  liveTurn,
  streaming,
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
  /** Discreet role under the name (agent role or "You"). */
  role?: string | undefined;
  /** Members with a live pending ask_user / approval (amber Waiting only for these). */
  activeWaitingSessionIds?: ReadonlySet<string> | readonly string[];
  /** In-flight live turn: status yields to streamed body on this definitive row. */
  liveTurn?: { mode: "running" | "queued"; live: GroupLiveTurnSnapshot } | undefined;
  /** True while this row is the in-flight stream (not yet persist-reconciled). */
  streaming?: boolean | undefined;
}) {
  const author: MemberLabel | undefined = message.authorSessionId
    ? (labels.get(message.authorSessionId) ?? { title: message.authorSessionId })
    : undefined;
  const toLabel = message.toSessionId
    ? (labels.get(message.toSessionId) ?? { title: message.toSessionId })
    : undefined;
  if (message.kind === "status") {
    const activeWaiting = isActiveWaitingStatus(
      message.body,
      message.authorSessionId,
      activeWaitingSessionIds ?? [],
    );
    const waiting = isWaitingStatus(message.body);
    const nudge = isNoNextOwnerStatus(message.body);
    const collab = parseGroupCollabStatusLine(message.body);
    const tone: RoomMessageTone = activeWaiting || nudge || collab?.kind === "ready"
      ? "ask"
      : collab?.kind === "blocked"
        ? "block"
        : "normal";
    const display = collab ? formatNaturalCollabStatus(collab) : message.body;
    return (
      <div
        className={cn("text-center text-2xs text-fg-faint", toneClass(tone))}
        data-collab={collab?.kind}
        data-kind="status"
        data-testid="group-message"
        data-tone={tone}
        data-waiting-active={activeWaiting || undefined}
        data-waiting-stale={waiting && !activeWaiting ? true : undefined}
      >
        {author && message.authorKind === "agent" ? (
          <span className="text-fg-subtle">
            <MemberName label={author} /> ·{" "}
          </span>
        ) : null}
        <span
          className={activeWaiting || nudge ? "text-amber-400" : undefined}
          data-nudge={nudge || undefined}
          data-waiting={activeWaiting || undefined}
        >
          <StatusText members={members} text={display} />
        </span>
      </div>
    );
  }
  if (message.authorKind === "user") {
    return (
      <div className="group/msg flex flex-col gap-0.5" data-tone="normal">
        <div className="flex gap-2.5" data-kind="user" data-testid="group-message">
          <span
            aria-hidden
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-elevated font-medium text-fg-muted text-2xs"
            data-testid="group-user-avatar"
          >
            Y
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-baseline gap-x-1.5 font-medium text-fg-muted text-xs">
              <span>You</span>
              <span className="font-normal text-fg-faint">{role?.trim() || "Human"}</span>
            </div>
            <div className="whitespace-pre-wrap text-fg text-sm">
              <MentionText members={members} text={message.body} />
            </div>
          </div>
        </div>
        {onReply ? (
          <button
            aria-label="Reply in thread"
            className="ml-7 self-start text-2xs text-fg-faint opacity-0 transition-opacity hover:text-fg-muted group-hover/msg:opacity-100 focus:opacity-100"
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
  const streamBody = liveTurn ? liveTurn.live.streamText : message.body;
  const { prose, statuses } = splitRoomMessageBody(streamBody);
  const showLiveStatus = Boolean(liveTurn && !prose.trim());
  return (
    <div
      className="group/msg flex flex-col gap-0.5"
      data-streaming={streaming || undefined}
      data-to={message.toSessionId || undefined}
    >
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
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-baseline gap-x-1.5 font-medium text-fg-muted text-xs">
            <MemberName label={label} />
            {role?.trim() ? (
              <span className="font-normal text-fg-faint">{role.trim()}</span>
            ) : null}
            {toLabel ? (
              <span className="font-normal text-fg-faint" data-testid="group-message-to">
                → <MemberName label={toLabel} />
              </span>
            ) : null}
          </div>
          {prose ? (
            <div
              className="text-fg text-sm"
              data-testid={streaming ? "group-live-writing" : undefined}
            >
              {streaming ? (
                <p className="whitespace-pre-wrap">{prose}</p>
              ) : (
                <MarkdownMessage
                  content={linkMentionsInMarkdown(prose, members)}
                  cwd={cwd}
                  onOpenFile={onOpenFile}
                />
              )}
            </div>
          ) : null}
          {showLiveStatus && liveTurn ? (
            <GroupMemberLiveTurn live={liveTurn.live} mode={liveTurn.mode} />
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
      {onReply && !streaming ? (
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
