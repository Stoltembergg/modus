import { useState } from "react";
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
import { classifyGroupSystemStatus } from "../../../../shared/group-prompt-kit";
import {
  collabStatusTone,
  extractUsefulSources,
  formatNaturalCollabStatus,
  isOrchestrationOnlyRoomMessage,
  type RoomMessageTone,
  shouldPersistCollabStatusInTranscript,
  splitRoomMessageBody,
  stripAgentSelfIntro,
} from "../../../../shared/group-room-transcript";
import { cn } from "../../lib/cn";
import { formatClock } from "../../lib/formatClock";
import { MarkdownMessage } from "../agent/MarkdownMessage";
import { AgentAvatar } from "../agents/AgentAvatar";
import { GroupMemberLiveTurn } from "./GroupMemberLiveTurn";
import type { GroupLiveTurnSnapshot } from "./groupLiveTurn";
import { linkMentionsInMarkdown, type MentionMember, splitMentions } from "./groupMentions";
import { replyPreview } from "./groupThreads";
import { MemberName } from "./MemberName";
import { MentionChip } from "./MentionChip";
import type { MemberLabel } from "./memberLabels";
import {
  AttachmentChip,
  PromptChainOfThought,
  PromptMessage,
  PromptMessageBody,
  PromptMessageIdentity,
  PromptSource,
  PromptSystemMessage,
} from "./prompt-kit/PromptKit";

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

function MessageAttachments({ message }: { message: GroupMessage }) {
  const images = message.attachments ?? [];
  const files = message.contextItems ?? [];
  if (images.length === 0 && files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="group-message-attachments">
      {images.map((attachment, index) => (
        <AttachmentChip
          key={`img-${attachment.name ?? index}-${attachment.data.slice(-12)}`}
          mimeType={attachment.mimeType}
          name={attachment.name ?? `image-${index + 1}`}
          previewUrl={`data:${attachment.mimeType};base64,${attachment.data}`}
        />
      ))}
      {files.map((item) => {
        const name = item.path.split(/[/\\]/).pop() ?? item.path;
        return (
          <AttachmentChip
            key={`${item.type}:${item.path}`}
            mimeType={item.type === "folder" ? "inode/directory" : "application/octet-stream"}
            name={name}
          />
        );
      })}
    </div>
  );
}

function MessageMeta({ message }: { message: GroupMessage }) {
  const status = message.status;
  const label = status
    ? {
        queued: "Queued",
        running: "Working",
        writing: "Writing",
        awaiting_user: "Waiting for you",
        completed: "Completed",
        failed: "Failed",
        cancelled: "Cancelled",
        interrupted: "Interrupted",
      }[status]
    : undefined;
  const warning = status === "failed" || status === "interrupted";
  return (
    <span className="ml-auto inline-flex flex-wrap items-baseline gap-x-1.5 font-normal text-2xs text-fg-faint">
      <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>
        {formatClock(Date.parse(message.createdAt))}
      </time>
      {label ? (
        <span
          className={
            warning ? "text-danger" : status === "awaiting_user" ? "text-amber-400" : undefined
          }
          data-testid="group-message-status"
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}

function ReplyQuote({
  message,
  replyToMessage,
  labels,
}: {
  message: GroupMessage;
  replyToMessage: GroupMessage | undefined;
  labels: ReadonlyMap<string, MemberLabel>;
}) {
  if (!message.replyToMessageId) return null;
  const author =
    replyToMessage?.authorKind === "user"
      ? "You"
      : replyToMessage?.authorSessionId
        ? (labels.get(replyToMessage.authorSessionId)?.title ?? "Member")
        : "Message";
  return (
    <blockquote
      className="rounded-md bg-canvas/60 px-2.5 py-1.5 text-2xs text-fg-subtle"
      data-testid="group-message-quote"
    >
      <a
        className="block truncate font-medium text-fg-muted hover:text-fg"
        href={`#group-message-${message.replyToMessageId}`}
      >
        Replying to {author}
      </a>
      <span className="block break-words">
        {replyToMessage ? replyPreview(replyToMessage.body, 96) || "Attachment" : "Earlier message"}
      </span>
    </blockquote>
  );
}

function MessageError({ message }: { message: GroupMessage }) {
  if (!message.error?.trim()) return null;
  return (
    <div
      className="break-words rounded-md bg-danger/10 px-2 py-1.5 text-xs text-danger"
      data-testid="group-message-error"
    >
      {message.error}
    </div>
  );
}

function fallbackProgressLabel(status: GroupMessage["status"]): string | undefined {
  switch (status) {
    case "queued":
      return "Waiting for its turn";
    case "running":
      return "Working on the task";
    case "writing":
      return "Writing a reply";
    case "awaiting_user":
      return "Waiting for you";
    default:
      return undefined;
  }
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
  onRetry,
  role,
  activeWaitingSessionIds,
  replyToMessage,
}: {
  message: GroupMessage;
  replyToMessage?: GroupMessage | undefined;
  members: readonly MentionMember[];
  labels: ReadonlyMap<string, MemberLabel>;
  cwd?: string | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  onHandoffClick?: ((targetName: string) => void) | undefined;
  onReply?: ((message: GroupMessage) => void) | undefined;
  onRetry?: ((message: GroupMessage) => Promise<void>) | undefined;
  /** The author's avatar (a current member); a former member keeps the initial badge. */
  avatar?: WorkingMemberAvatar | undefined;
  /** Discreet role under the name (agent role or "You"). */
  role?: string | undefined;
  /** Members with a live pending ask_user / approval (amber Waiting only for these). */
  activeWaitingSessionIds?: ReadonlySet<string> | readonly string[];
  /** Ephemeral live progress for the same canonical message card. */
  liveTurn?: { mode: "running" | "queued"; live: GroupLiveTurnSnapshot } | undefined;
  /** Marks public text as streaming for transient fallback cards. */
  streaming?: boolean | undefined;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | undefined>();
  async function retry(): Promise<void> {
    if (!onRetry || retrying) return;
    setRetrying(true);
    setRetryError(undefined);
    try {
      await onRetry(message);
    } catch (cause) {
      setRetryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetrying(false);
    }
  }
  const canRetry =
    onRetry &&
    (message.status === "failed" ||
      message.status === "cancelled" ||
      message.status === "interrupted");
  const author: MemberLabel | undefined = message.authorSessionId
    ? (labels.get(message.authorSessionId) ?? { title: message.authorSessionId })
    : undefined;
  const toLabel = message.toSessionId
    ? (labels.get(message.toSessionId) ?? { title: message.toSessionId })
    : undefined;
  if (message.kind === "status") {
    const collab = parseGroupCollabStatusLine(message.body);
    // Orchestration handoffs: Activity / runtime only — never the main transcript.
    if (collab?.kind === "handoff") return null;
    const activeWaiting = isActiveWaitingStatus(
      message.body,
      message.authorSessionId,
      activeWaitingSessionIds ?? [],
    );
    const waiting = isWaitingStatus(message.body);
    const nudge = isNoNextOwnerStatus(message.body);
    const display = collab ? formatNaturalCollabStatus(collab) : message.body;
    const classified = classifyGroupSystemStatus(display);
    if (classified?.show === "hide") return null;
    if (classified?.show === "system" || activeWaiting || nudge) {
      const variant =
        activeWaiting || nudge
          ? "action"
          : (classified?.variant ?? (collab?.kind === "blocked" ? "error" : "action"));
      return (
        <PromptSystemMessage
          {...(activeWaiting || nudge ? { className: "text-amber-400" } : {})}
          data-collab={collab?.kind}
          data-kind="status"
          data-testid="group-message"
          data-waiting-active={activeWaiting || undefined}
          data-waiting-stale={waiting && !activeWaiting ? true : undefined}
          variant={variant}
        >
          {author && message.authorKind === "agent" ? (
            <span className="text-fg-subtle">
              <MemberName label={author} /> ·{" "}
            </span>
          ) : null}
          <span className={activeWaiting || nudge ? "text-amber-400" : undefined}>
            <StatusText members={members} text={display} />
          </span>
        </PromptSystemMessage>
      );
    }
    return (
      <div
        className="text-center text-2xs text-fg-faint"
        data-collab={collab?.kind}
        data-kind="status"
        data-testid="group-message"
        data-tone="temporary"
        data-waiting-stale={waiting && !activeWaiting ? true : undefined}
      >
        {author && message.authorKind === "agent" ? (
          <span className="text-fg-subtle">
            <MemberName label={author} /> ·{" "}
          </span>
        ) : null}
        <StatusText members={members} text={display} />
      </div>
    );
  }
  if (message.authorKind === "user") {
    return (
      <div className="group/msg flex w-full flex-col items-end gap-0.5" data-tone="normal">
        <PromptMessage
          className="flex-row-reverse border-accent/20 bg-accent/10"
          data-align="right"
          data-kind="user"
          data-message-id={message.id}
          data-status={message.status}
          data-testid="group-message"
          id={`group-message-${message.id}`}
        >
          <span
            aria-hidden
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-elevated font-medium text-fg-muted text-2xs"
            data-testid="group-user-avatar"
          >
            Y
          </span>
          <PromptMessageBody>
            <PromptMessageIdentity
              name="You"
              role={role?.trim() || "Human"}
              trailing={<MessageMeta message={message} />}
            />
            <ReplyQuote labels={labels} message={message} replyToMessage={replyToMessage} />
            {message.body.trim() ? (
              <div className="whitespace-pre-wrap text-fg text-sm leading-relaxed">
                <MentionText members={members} text={message.body} />
              </div>
            ) : null}
            <MessageAttachments message={message} />
            <MessageError message={message} />
          </PromptMessageBody>
        </PromptMessage>
        {onReply ? (
          <button
            aria-label="Reply to message"
            className="mr-3 self-end text-2xs text-fg-faint opacity-0 transition-opacity hover:text-fg-muted group-hover/msg:opacity-100 focus:opacity-100"
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
  const liveText = liveTurn?.live.streamText ?? "";
  const body = message.body.trim() ? message.body : liveText;
  const writing = message.status === "writing" || Boolean(streaming) || Boolean(liveText.trim());
  const { prose: rawProse, statuses: rawStatuses } = splitRoomMessageBody(body);
  const prose = stripAgentSelfIntro(rawProse);
  const statuses = rawStatuses.filter(shouldPersistCollabStatusInTranscript);
  const readyOnly =
    !prose.trim() && rawStatuses.some((status) => status.kind === "ready") && statuses.length === 0;
  const fallbackProgress =
    !liveTurn && message.authorKind === "agent" ? fallbackProgressLabel(message.status) : undefined;
  // Hide Planner→peer handoff dumps that have no user-facing prose.
  if (
    !writing &&
    !message.status &&
    !readyOnly &&
    isOrchestrationOnlyRoomMessage({ kind: message.kind, body: message.body })
  ) {
    return null;
  }
  const sources = !writing ? extractUsefulSources(prose) : [];
  const showLiveProgress = Boolean(liveTurn && !liveTurn.live.collapsed);
  return (
    <div
      className="group/msg flex w-full flex-col items-start gap-0.5"
      data-streaming={writing || undefined}
      data-to={message.toSessionId || undefined}
    >
      <PromptMessage
        data-align="left"
        data-kind="member"
        data-message-id={message.id}
        data-status={message.status}
        data-testid="group-message"
        id={`group-message-${message.id}`}
      >
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
        <PromptMessageBody>
          <PromptMessageIdentity
            name={<MemberName label={label} />}
            role={role?.trim() || "Agent"}
            trailing={
              <>
                {toLabel ? (
                  <span className="font-normal text-fg-faint" data-testid="group-message-to">
                    → <MemberName label={toLabel} />
                  </span>
                ) : null}
                <MessageMeta message={message} />
                {readyOnly ? (
                  <span
                    className="font-normal text-amber-400/90 text-2xs"
                    data-testid="group-ready-ephemeral"
                  >
                    {formatNaturalCollabStatus({ kind: "ready" })}
                  </span>
                ) : null}
              </>
            }
          />
          <ReplyQuote labels={labels} message={message} replyToMessage={replyToMessage} />
          {showLiveProgress && liveTurn ? (
            <GroupMemberLiveTurn live={liveTurn.live} mode={liveTurn.mode} />
          ) : fallbackProgress ? (
            <PromptChainOfThought items={[fallbackProgress]} summary={fallbackProgress} />
          ) : null}
          {prose ? (
            <div
              className="text-fg text-sm leading-relaxed"
              data-testid={writing ? "group-live-writing" : undefined}
            >
              {writing ? (
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
          {sources.length > 0 ? (
            <div className="flex flex-wrap gap-1" data-testid="group-message-sources">
              {sources.map((source) => (
                <PromptSource href={source.href} key={source.href} label={source.label} />
              ))}
            </div>
          ) : null}
          <MessageAttachments message={message} />
          <MessageError message={message} />
          {canRetry ? (
            <button
              className="rounded-md border border-hairline bg-canvas px-2 py-1 text-xs text-fg-muted hover:bg-hover disabled:opacity-50"
              disabled={retrying}
              onClick={() => void retry()}
              type="button"
            >
              {retrying ? "Sending…" : message.status === "failed" ? "Retry task" : "Resume task"}
            </button>
          ) : null}
          {retryError ? (
            <div className="text-xs text-danger" role="alert">
              {retryError}
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
        </PromptMessageBody>
      </PromptMessage>
      {onReply && !writing && !showLiveProgress && !fallbackProgress ? (
        <button
          aria-label="Reply to message"
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
