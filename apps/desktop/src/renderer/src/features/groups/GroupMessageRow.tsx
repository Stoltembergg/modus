import { IconFilter } from "@tabler/icons-react";
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
import { messageExecutionId } from "../../../../shared/group-execution-link";
import { classifyGroupSystemStatus } from "../../../../shared/group-prompt-kit";
import { parseGroupFinalResultCard } from "../../../../shared/group-result-card";
import {
  groupMemberCardText,
  groupStatusLabel,
  isLegacyWaitingForYouBody,
  localizeGroupStatusBody,
} from "../../../../shared/group-room-locale";
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
import { CopyButton } from "../../components/ui/CopyButton";
import { cn } from "../../lib/cn";
import { formatTokenCount } from "../../lib/tokenUsage";
import { MarkdownMessage } from "../agent/MarkdownMessage";
import { AgentAvatar } from "../agents/AgentAvatar";
import { PromptSources } from "../sources/PromptSources";
import type { RunSource } from "../sources/runSources";
import { useRunSources } from "../sources/useRunSources";
import { GroupFinalResultCard } from "./GroupFinalResultCard";
import { GroupMemberLiveTurn } from "./GroupMemberLiveTurn";
import { GroupDeliveryFooter, GroupMessageHeader } from "./GroupMessageHeader";
import type { GroupDelivery } from "./groupDelivery";
import { describeGroupError } from "./groupErrors";
import type { GroupLiveTurnSnapshot } from "./groupLiveTurn";
import { linkMentionsInMarkdown, type MentionMember, splitMentions } from "./groupMentions";
import { useGroupText } from "./groupRoomI18n";
import { replyPreview } from "./groupThreads";
import { groupMessageWaitingState, isGroupMessageWaitingForYou } from "./groupWaiting";
import { MemberName } from "./MemberName";
import { MentionChip } from "./MentionChip";
import type { MemberLabel } from "./memberLabels";
import {
  AttachmentChip,
  PromptChainOfThought,
  PromptMessage,
  PromptMessageBody,
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

export { isGroupMessageWaitingForYou } from "./groupWaiting";

/**
 * Legacy text check of a "Waiting for you" status body (rows from before the
 * structured `awaiting_user` card status). Prefer `isGroupMessageWaitingForYou`.
 */
export function isWaitingStatus(body: string): boolean {
  return isLegacyWaitingForYouBody(body);
}

export function isNoNextOwnerStatus(body: string): boolean {
  return body === GROUP_COLLAB_NO_NEXT_OWNER;
}

/**
 * Amber "Waiting for you" is only for an *active* pending ask_user/approval.
 * Historical status lines stay in the transcript but lose the sticky amber tone.
 * Text-only (legacy rows); the row uses `groupMessageWaitingState`.
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
  const t = useGroupText();
  const text = formatNaturalCollabStatus(status, t.locale);
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

function MessageMeta({
  message,
  executionTokenTotal,
  onExecutionFilter,
  locale,
}: {
  message: GroupMessage;
  locale?: string | null | undefined;
  executionTokenTotal?: number | undefined;
  onExecutionFilter?: ((executionId: string | undefined) => void) | undefined;
}) {
  const t = useGroupText(locale);
  const status = message.status;
  const executionId = messageExecutionId(message);
  const showChip = message.authorKind === "user" || Boolean(message.chainId);
  const executionChip = showChip ? (
    <button
      aria-label={t("row.filterExecution")}
      className="flex size-5 shrink-0 items-center justify-center rounded text-fg-faint transition-colors hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring-soft)]"
      data-execution-id={executionId}
      data-testid="group-execution-filter"
      onClick={() => onExecutionFilter?.(executionId)}
      title={t("row.filterExecution")}
      type="button"
    >
      <IconFilter aria-hidden size={12} stroke={1.8} />
    </button>
  ) : null;
  const tokenLabel =
    typeof executionTokenTotal === "number" && executionTokenTotal > 0
      ? formatTokenCount(executionTokenTotal)
      : "";
  // Live turns already show concrete phases — do not stamp opaque "Working".
  // Hoist executionChip so running/writing rows still expose the filter control.
  // The time lives in the header (`name · time`).
  if (!status || status === "running" || status === "writing") {
    if (!executionChip && !tokenLabel) return null;
    return (
      <span className="ml-auto inline-flex flex-wrap items-center gap-x-1.5 font-normal text-2xs text-fg-faint">
        {executionChip}
        {tokenLabel ? (
          <span
            className="rounded-md bg-chip-faint px-1.5 py-0.5 text-fg-subtle tabular-nums"
            data-testid="group-execution-tokens"
            title={t("row.tokensTitle")}
          >
            {t("row.tokens", { count: tokenLabel })}
          </span>
        ) : null}
      </span>
    );
  }
  const label = groupStatusLabel(
    (
      {
        queued: "queued",
        awaiting_user: "waitingForYou",
        completed: "completed",
        failed: "failed",
        cancelled: "cancelled",
        interrupted: "interrupted",
      } as const
    )[status],
    t.locale,
  );
  const warning = status === "failed" || status === "interrupted";
  return (
    <span className="ml-auto inline-flex flex-wrap items-center gap-x-1.5 font-normal text-2xs text-fg-faint">
      {executionChip}
      {tokenLabel ? (
        <span
          className="rounded-md bg-chip-faint px-1.5 py-0.5 text-fg-subtle tabular-nums"
          data-testid="group-execution-tokens"
          title={t("row.tokensTitle")}
        >
          {t("row.tokens", { count: tokenLabel })}
        </span>
      ) : null}
      {label ? (
        <span
          className={
            warning
              ? "text-danger"
              : isGroupMessageWaitingForYou(message)
                ? "text-amber-400"
                : undefined
          }
          data-testid="group-message-status"
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}

function MessageActions({
  copyText,
  onReply,
  message,
  align,
}: {
  copyText: string;
  onReply?: ((message: GroupMessage) => void) | undefined;
  message: GroupMessage;
  align: "start" | "end";
}) {
  const t = useGroupText();
  if (!copyText.trim() && !onReply) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100",
        align === "end" ? "mr-3 self-end" : "ml-8 self-start",
      )}
      data-testid="group-message-actions"
    >
      {copyText.trim() ? <CopyButton label={t("row.copyMessage")} text={copyText} /> : null}
      {onReply ? (
        <button
          aria-label={t("row.replyToMessage")}
          className="text-2xs text-fg-faint hover:text-fg-muted"
          data-testid="group-message-reply"
          onClick={() => onReply(message)}
          type="button"
        >
          {t("row.reply")}
        </button>
      ) : null}
    </div>
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
  const t = useGroupText();
  if (!message.replyToMessageId) return null;
  const author =
    replyToMessage?.authorKind === "user"
      ? t("row.you")
      : replyToMessage?.authorSessionId
        ? (labels.get(replyToMessage.authorSessionId)?.title ?? t("row.member"))
        : t("row.message");
  return (
    <blockquote
      className="rounded-md bg-canvas/60 px-2.5 py-1.5 text-2xs text-fg-subtle"
      data-testid="group-message-quote"
    >
      <a
        className="block truncate font-medium text-fg-muted hover:text-fg"
        href={`#group-message-${message.replyToMessageId}`}
      >
        {t("row.replyingTo", { name: author })}
      </a>
      <span className="block break-words">
        {replyToMessage
          ? replyPreview(replyToMessage.body, 96) || t("row.attachment")
          : t("row.earlierMessage")}
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

function fallbackProgressLabel(
  status: GroupMessage["status"],
  locale?: string | null,
): string | undefined {
  switch (status) {
    case "queued":
      return groupMemberCardText("waitingForTurn", locale);
    case "running":
      return groupMemberCardText("workingOnTask", locale);
    case "writing":
      return groupMemberCardText("writingReply", locale);
    case "awaiting_user":
      return groupStatusLabel("waitingForYou", locale);
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
  onExecutionFilter,
  role,
  activeWaitingSessionIds,
  liveTurn,
  streaming,
  replyToMessage,
  executionTokenTotal,
  delivery,
  locale: localeProp,
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
  /** Click the execution chip to filter the transcript. */
  onExecutionFilter?: ((executionId: string | undefined) => void) | undefined;
  /** Estimated token total for this ask-spanning execution (shown on the chain’s last message). */
  executionTokenTotal?: number | undefined;
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
  /** Delivery footer (queued / delivered / working / answered), derived by the list. */
  delivery?: GroupDelivery | undefined;
  /** Room locale override (tests); defaults to the room provider, then the browser locale. */
  locale?: string | null | undefined;
}) {
  const t = useGroupText(localeProp);
  const locale = t.locale;
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | undefined>();
  const runSources = useRunSources(
    message.authorSessionId,
    message.runId,
    message.authorKind === "agent" &&
      message.kind === "message" &&
      (message.status === "completed" || message.status === undefined),
  );
  async function retry(): Promise<void> {
    if (!onRetry || retrying) return;
    setRetrying(true);
    setRetryError(undefined);
    try {
      await onRetry(message);
    } catch (cause) {
      setRetryError(describeGroupError(cause, locale));
    } finally {
      setRetrying(false);
    }
  }
  const canRetry =
    onRetry &&
    Boolean(message.turnId) &&
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
    // Keep handoffs and protocol agreement summaries out of the conversational transcript.
    if (collab?.kind === "handoff" || collab?.kind === "agreed") return null;
    // Structured `awaiting_user` first, legacy "Waiting for you" text second.
    const waitingState = groupMessageWaitingState(message, activeWaitingSessionIds ?? []);
    const activeWaiting = waitingState === "active";
    const waiting = waitingState !== undefined;
    const nudge = isNoNextOwnerStatus(message.body);
    // Classify the canonical English text (what the runtime stores); show it localised.
    const canonical = collab ? formatNaturalCollabStatus(collab, "en") : message.body;
    const display = collab
      ? formatNaturalCollabStatus(collab, locale)
      : localizeGroupStatusBody(message.body, locale);
    const classified =
      waitingState === "active" && !isLegacyWaitingForYouBody(canonical)
        ? ({ show: "system", variant: "action" } as const)
        : classifyGroupSystemStatus(canonical);
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
          data-align="right"
          data-kind="user"
          data-message-id={message.id}
          data-status={message.status}
          data-testid="group-message"
          id={`group-message-${message.id}`}
        >
          <PromptMessageBody>
            <GroupMessageHeader
              avatar={
                <span
                  aria-hidden
                  className="flex size-4 shrink-0 items-center justify-center rounded-full bg-elevated font-medium text-[9px] text-fg-muted"
                  data-testid="group-user-avatar"
                >
                  {t("row.youInitial")}
                </span>
              }
              createdAt={message.createdAt}
              locale={locale}
              name={t("row.you")}
              memberRole={role?.trim() || t("row.human")}
              trailing={
                <MessageMeta
                  executionTokenTotal={executionTokenTotal}
                  locale={locale}
                  message={message}
                  onExecutionFilter={onExecutionFilter}
                />
              }
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
        {delivery ? (
          <GroupDeliveryFooter align="end" delivery={delivery} labels={labels} locale={locale} />
        ) : null}
        <MessageActions align="end" copyText={message.body} message={message} onReply={onReply} />
      </div>
    );
  }
  const sessionId = message.authorSessionId ?? "";
  const label = author ?? { title: t("row.member") };
  const cardWaiting = groupMessageWaitingState(message, activeWaitingSessionIds ?? []);
  const title = label.title;
  const liveText = liveTurn?.live.streamText ?? "";
  const body = message.body.trim() ? message.body : liveText;
  const writing = message.status === "writing" || Boolean(streaming) || Boolean(liveText.trim());
  const { prose: rawProse, statuses: rawStatuses } = splitRoomMessageBody(body);
  const resultParsed = !writing ? parseGroupFinalResultCard(rawProse) : undefined;
  const prose = stripAgentSelfIntro(resultParsed?.prose ?? rawProse);
  const statuses = rawStatuses.filter(shouldPersistCollabStatusInTranscript);
  const readyOnly =
    !prose.trim() &&
    !resultParsed &&
    rawStatuses.some((status) => status.kind === "ready") &&
    statuses.length === 0;
  const fallbackProgress =
    !liveTurn && message.authorKind === "agent"
      ? fallbackProgressLabel(message.status, locale)
      : undefined;
  // Hide Planner→peer handoff dumps that have no user-facing prose.
  if (
    !writing &&
    !message.status &&
    !readyOnly &&
    isOrchestrationOnlyRoomMessage({ kind: message.kind, body: message.body })
  ) {
    return null;
  }
  const sources = (() => {
    if (writing || message.authorKind !== "agent") return runSources;
    const combined = new Map<string, RunSource>();
    for (const source of runSources) combined.set(source.id, source);
    for (const source of extractUsefulSources(prose)) {
      const href = source.href;
      if (![...combined.values()].some((existing) => existing.href === href)) {
        combined.set(`url:${href}`, {
          id: `url:${href}`,
          kind: "url",
          label: source.label ?? href,
          href,
        });
      }
    }
    return [...combined.values()].slice(0, 24);
  })();
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
        data-waiting-active={cardWaiting === "active" || undefined}
        data-waiting-stale={cardWaiting === "stale" || undefined}
        id={`group-message-${message.id}`}
      >
        <PromptMessageBody>
          <GroupMessageHeader
            avatar={
              avatar ? (
                <AgentAvatar
                  animated={false}
                  color={avatar.color}
                  face={avatar.face}
                  seed={avatar.agentId}
                  shape={avatar.shape}
                  size={16}
                  state={avatar.archived ? "archived" : "idle"}
                />
              ) : (
                <span
                  aria-hidden
                  className="flex size-4 shrink-0 items-center justify-center rounded-full font-medium text-[9px] text-white"
                  data-testid="group-member-initial"
                  style={{ backgroundColor: memberColor(sessionId) }}
                >
                  {title.trim().charAt(0).toLocaleUpperCase() || "?"}
                </span>
              )
            }
            createdAt={message.createdAt}
            locale={locale}
            name={<MemberName label={label} />}
            memberRole={role?.trim() || t("row.agent")}
            trailing={
              <>
                {toLabel ? (
                  <span className="font-normal text-fg-faint" data-testid="group-message-to">
                    → <MemberName label={toLabel} />
                  </span>
                ) : null}
                <MessageMeta
                  executionTokenTotal={executionTokenTotal}
                  locale={locale}
                  message={message}
                  onExecutionFilter={onExecutionFilter}
                />
                {readyOnly ? (
                  <span
                    className="font-normal text-amber-400/90 text-2xs"
                    data-testid="group-ready-ephemeral"
                  >
                    {formatNaturalCollabStatus({ kind: "ready" }, locale)}
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
          {resultParsed ? <GroupFinalResultCard card={resultParsed.card} /> : null}
          <PromptSources onOpenFile={onOpenFile} sources={sources} />
          <MessageAttachments message={message} />
          <MessageError message={message} />
          {canRetry ? (
            <button
              className="rounded-md border border-hairline bg-canvas px-2 py-1 text-xs text-fg-muted hover:bg-hover disabled:opacity-50"
              disabled={retrying}
              onClick={() => void retry()}
              type="button"
            >
              {groupMemberCardText(
                retrying ? "sending" : message.status === "failed" ? "retryTask" : "resumeTask",
                locale,
              )}
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
      {delivery ? (
        <GroupDeliveryFooter align="start" delivery={delivery} labels={labels} locale={locale} />
      ) : null}
      <MessageActions
        align="start"
        copyText={prose || message.body}
        message={message}
        onReply={onReply}
      />
    </div>
  );
}
