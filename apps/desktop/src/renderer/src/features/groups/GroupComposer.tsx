import { IconArrowUp, IconClockPause, IconPaperclip } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GroupExecutionMode,
  GroupMessageAttachment,
  GroupMessageContextItem,
  UpdateState,
} from "../../../../shared/contracts";
import {
  clearGroupComposerDraft,
  readGroupComposerDraft,
  writeGroupComposerDraft,
} from "../../../../shared/group-conversation-minors";
import { groupRoomLabel } from "../../../../shared/group-room-locale";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { GroupMemberQuestions } from "./GroupMemberQuestions";
import {
  COLLAB_PIPELINE_APPROVAL,
  COLLAB_PIPELINE_NEXT,
  formatGroupKickoffDraft,
} from "./groupKickoff";
import {
  activeMentionQuery,
  type MentionMember,
  type MentionSuggestion,
  mentionSuggestions,
} from "./groupMentions";
import { MemberName } from "./MemberName";
import { memberLabels } from "./memberLabels";
import { AttachmentChip } from "./prompt-kit/PromptKit";
import { MAX_GROUP_ATTACHMENTS, useGroupComposerAttachments } from "./useGroupComposerAttachments";
import { useGroupMemberStates } from "./useWorkingGroups";

/** Same rule as the main process: new group turns wait while an update restarts the app. */
export function isUpdatePending(state: UpdateState | undefined): boolean {
  return state?.status === "waiting-for-agents" || state?.status === "installing";
}

type UpdateApi = {
  getState(): Promise<UpdateState>;
  onStateChange(listener: (state: UpdateState) => void): () => void;
};

export function useUpdatePending(api: UpdateApi | undefined): boolean {
  const [state, setState] = useState<UpdateState | undefined>();
  useEffect(() => {
    if (!api) return;
    let disposed = false;
    const unsubscribe = api.onStateChange((next) => setState(next));
    api
      .getState()
      .then((next) => {
        if (!disposed) setState((current) => current ?? next);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [api]);
  return isUpdatePending(state);
}

/**
 * Room composer: Enter sends, Shift+Enter adds a line. Typing `@` opens member
 * suggestions by title; a title shared by several members inserts
 * `@<session id>` (the list still shows the title). Pending ask_user questions
 * for waiting members of this room render above the field (group-scoped).
 * Native multi-file upload chips reuse Modus attachments / context items.
 */
export type GroupComposerReply = {
  messageId: string;
  preview: string;
};

export type GroupComposerSendPayload = {
  body: string;
  replyToMessageId?: string;
  attachments?: GroupMessageAttachment[];
  contextItems?: GroupMessageContextItem[];
  executionMode?: GroupExecutionMode;
  executionId?: string;
};

export function GroupComposer({
  groupId,
  members,
  updatePending,
  onSend,
  showKickoff = false,
  seed,
  onSeedConsumed,
  replyTo,
  onClearReply,
  activeExecutionId,
  activeExecutionTitle,
}: {
  groupId?: string;
  members: readonly MentionMember[];
  updatePending: boolean;
  onSend(payload: GroupComposerSendPayload): Promise<void>;
  /** Empty room: show the guided Outcome + first-owner kickoff (P2). */
  showKickoff?: boolean;
  /** External insert (e.g. clickable Handoff card) — applied once then cleared. */
  seed?: string | undefined;
  onSeedConsumed?: (() => void) | undefined;
  /** N3: active thread reply target. */
  replyTo?: GroupComposerReply | undefined;
  onClearReply?: (() => void) | undefined;
  /** Latest ask-spanning execution; enables Complementar. */
  activeExecutionId?: string | undefined;
  /** Short label for the active execution chip. */
  activeExecutionTitle?: string | undefined;
}) {
  const [value, setValue] = useState(() => (groupId ? readGroupComposerDraft(groupId) : ""));
  const [caret, setCaret] = useState(() => {
    const initial = groupId ? readGroupComposerDraft(groupId) : "";
    return initial.length;
  });
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [dragOver, setDragOver] = useState(false);
  const [kickoffOutcome, setKickoffOutcome] = useState("");
  const [kickoffOwner, setKickoffOwner] = useState("");
  const [draftGroupId, setDraftGroupId] = useState(groupId);
  const [executionMode, setExecutionMode] = useState<GroupExecutionMode>("new");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const memberStates = useGroupMemberStates();

  // Persist drafts across room switches / remounts (text only).
  if (draftGroupId !== groupId) {
    setDraftGroupId(groupId);
    const restored = groupId ? readGroupComposerDraft(groupId) : "";
    setValue(restored);
    setCaret(restored.length);
  }

  useEffect(() => {
    if (!groupId) return;
    writeGroupComposerDraft(groupId, value);
  }, [groupId, value]);
  const {
    addFiles,
    attachments,
    clear,
    formatSize,
    hasReady,
    remove,
    toContextItems,
    toPromptAttachments,
  } = useGroupComposerAttachments();
  const labels = useMemo(() => memberLabels(members), [members]);
  const waitingSessionIds = useMemo(() => {
    const memberIds = new Set(members.map((member) => member.sessionId));
    const waiting: string[] = [];
    const entries = groupId
      ? [memberStates.get(groupId)].filter((entry) => entry !== undefined)
      : [...memberStates.values()];
    for (const entry of entries) {
      for (const sessionId of entry.waitingSessionIds) {
        if (memberIds.has(sessionId) && !waiting.includes(sessionId)) waiting.push(sessionId);
      }
    }
    return waiting;
  }, [memberStates, members, groupId]);

  useEffect(() => {
    if (!seed) return;
    setValue(seed);
    setCaret(seed.length);
    onSeedConsumed?.();
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(seed.length, seed.length);
    });
  }, [seed, onSeedConsumed]);

  useEffect(() => {
    if (!showKickoff || kickoffOwner || members.length === 0) return;
    // Prefer a Planner-named member, else the first roster entry.
    const planner = members.find((member) => /^planner$/i.test(member.title.trim()));
    setKickoffOwner((planner ?? members[0])?.title ?? "");
  }, [showKickoff, members, kickoffOwner]);

  useEffect(() => {
    if (!activeExecutionId && executionMode === "complement") {
      setExecutionMode("new");
    }
  }, [activeExecutionId, executionMode]);

  const query = activeMentionQuery(value, caret);
  const suggestions =
    query && query.start !== dismissedAt ? mentionSuggestions(query.query, members) : [];
  const open = suggestions.length > 0;
  const active = Math.min(highlight, Math.max(0, suggestions.length - 1));
  const canSend = Boolean(value.trim() || hasReady) && !sending;

  function pick(suggestion: MentionSuggestion): void {
    if (!query) return;
    const insert = `@${suggestion.insert} `;
    const next = value.slice(0, query.start) + insert + value.slice(caret);
    const nextCaret = query.start + insert.length;
    setValue(next);
    setCaret(nextCaret);
    setHighlight(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  async function send(): Promise<void> {
    const body = value.trim();
    if ((!body && !hasReady) || sending) return;
    setSending(true);
    setError(undefined);
    try {
      const imageAttachments = toPromptAttachments();
      const contextItems = toContextItems();
      await onSend({
        body,
        ...(replyTo?.messageId ? { replyToMessageId: replyTo.messageId } : {}),
        ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}),
        ...(contextItems.length > 0 ? { contextItems } : {}),
        executionMode,
        ...(executionMode === "complement" && activeExecutionId
          ? { executionId: activeExecutionId }
          : {}),
      });
      setValue("");
      setCaret(0);
      if (groupId) clearGroupComposerDraft(groupId);
      clear();
      onClearReply?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[760px] px-3 pb-4 sm:px-6">
      {updatePending ? (
        <div
          className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-hairline bg-elevated px-3 py-1.5 text-fg-muted text-xs"
          data-testid="group-update-banner"
          role="status"
        >
          <IconClockPause size={ICON.sm} stroke={ICON_STROKE.sm} />
          <span className="font-medium text-fg">Paused while Modus updates</span>
          <span className="text-fg-faint">
            Messages are saved. Pending tasks resume after restart. Interrupted runs stay visible
            for you to resume.
          </span>
        </div>
      ) : null}
      <GroupMemberQuestions labels={labels} waitingSessionIds={waitingSessionIds} />
      {waitingSessionIds.length > 0 ? (
        <div
          className="mb-2 text-2xs text-amber-400/90"
          data-testid="group-composer-ready"
          role="status"
        >
          {groupRoomLabel("ready")}
          <span className="text-fg-faint">
            {" · "}
            {waitingSessionIds
              .map((id) => labels.get(id)?.title ?? id)
              .filter(Boolean)
              .slice(0, 3)
              .join(", ")}
          </span>
        </div>
      ) : null}
      {replyTo ? (
        <div
          className="mb-2 flex items-center gap-2 rounded-md border border-hairline bg-elevated px-2.5 py-1.5 text-2xs text-fg-muted"
          data-testid="group-composer-reply"
        >
          <span className="min-w-0 flex-1 truncate">
            Replying · <span className="text-fg-faint">{replyTo.preview}</span>
          </span>
          <button
            className="shrink-0 text-fg-faint hover:text-fg"
            onClick={() => onClearReply?.()}
            type="button"
          >
            Cancel
          </button>
        </div>
      ) : null}
      {activeExecutionId ? (
        <fieldset
          className="mb-2 flex flex-wrap items-center gap-1.5 border-0 p-0 text-2xs"
          data-testid="group-composer-execution-mode"
        >
          <legend className="sr-only">Execution mode</legend>
          <button
            className={cn(
              "rounded-md border px-2 py-1 font-medium transition-colors",
              executionMode === "new"
                ? "border-accent/40 bg-accent/15 text-fg"
                : "border-hairline bg-elevated text-fg-muted hover:text-fg",
            )}
            data-testid="group-composer-mode-new"
            onClick={() => setExecutionMode("new")}
            type="button"
          >
            Nova tarefa
          </button>
          <button
            className={cn(
              "rounded-md border px-2 py-1 font-medium transition-colors",
              executionMode === "complement"
                ? "border-accent/40 bg-accent/15 text-fg"
                : "border-hairline bg-elevated text-fg-muted hover:text-fg",
            )}
            data-testid="group-composer-mode-complement"
            onClick={() => setExecutionMode("complement")}
            type="button"
          >
            Complementar
          </button>
          {executionMode === "complement" ? (
            <span className="text-fg-faint" data-testid="group-composer-active-execution">
              · {activeExecutionTitle ?? activeExecutionId.slice(0, 8)}
            </span>
          ) : null}
        </fieldset>
      ) : null}
      {error ? <div className="mb-2 text-danger text-xs">{error}</div> : null}
      {showKickoff && !value.trim() && attachments.length === 0 ? (
        <div
          className="mb-2 space-y-2 rounded-xl border border-hairline bg-elevated px-3 py-2.5"
          data-testid="group-kickoff"
        >
          <p className="font-medium text-fg text-xs">Kick off the group</p>
          <p className="text-2xs text-fg-faint">
            Outcome + first owner — the room stays the source of truth.
          </p>
          <label className="block text-2xs text-fg-muted">
            Outcome
            <input
              className="mt-1 h-8 w-full rounded-lg border border-hairline bg-canvas px-2.5 text-fg text-sm outline-none placeholder:text-fg-faint"
              data-testid="group-kickoff-outcome"
              onChange={(event) => setKickoffOutcome(event.currentTarget.value)}
              placeholder="What should the group deliver?"
              value={kickoffOutcome}
            />
          </label>
          <label className="block text-2xs text-fg-muted">
            First owner
            <select
              className="mt-1 h-8 w-full rounded-lg border border-hairline bg-canvas px-2.5 text-fg text-sm outline-none"
              data-testid="group-kickoff-owner"
              onChange={(event) => setKickoffOwner(event.currentTarget.value)}
              value={kickoffOwner}
            >
              {members.map((member) => (
                <option key={member.sessionId} value={member.title}>
                  {member.title}
                </option>
              ))}
            </select>
          </label>
          <button
            className="rounded-lg bg-accent px-2.5 py-1.5 font-medium text-2xs text-white disabled:opacity-40"
            data-testid="group-kickoff-insert"
            disabled={!kickoffOwner.trim()}
            onClick={() => {
              const draft = formatGroupKickoffDraft({
                outcome: kickoffOutcome,
                firstOwner: kickoffOwner,
                nextSteps: COLLAB_PIPELINE_NEXT,
                approval: COLLAB_PIPELINE_APPROVAL,
              });
              setValue(draft);
              setCaret(draft.length);
              requestAnimationFrame(() => {
                inputRef.current?.focus();
                inputRef.current?.setSelectionRange(draft.length, draft.length);
              });
            }}
            type="button"
          >
            Insert kickoff
          </button>
        </div>
      ) : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-drop is a pointer-only enhancement; keyboard users attach via the paperclip button or paste. */}
      <div
        className={cn(
          "composer-dock-shell relative transition-colors",
        )}
        data-composer-surface
        data-dragging={dragOver ? "" : undefined}
        data-testid="group-composer-dropzone"
        data-ui-surface="raised"
        onDragEnter={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setDragOver(false);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          void addFiles(event.dataTransfer.files);
        }}
      >
        {open ? (
          <div
            className="absolute bottom-full left-2 mb-1 max-h-56 min-w-[220px] overflow-auto popup-chrome p-1"
            data-testid="mention-suggestions"
            role="listbox"
          >
            {suggestions.map((suggestion, index) => (
              <button
                aria-selected={index === active}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
                  index === active ? "bg-hover text-fg" : "text-fg-muted",
                )}
                key={suggestion.sessionId}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(suggestion);
                }}
                role="option"
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">
                  <MemberName
                    label={
                      suggestion.suffix
                        ? { title: suggestion.title, suffix: suggestion.suffix }
                        : { title: suggestion.title }
                    }
                  />
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div
            className="flex flex-wrap gap-1.5 px-3 pt-3"
            data-testid="group-composer-attachments"
          >
            {attachments.map((item) => (
              <AttachmentChip
                error={item.error}
                key={item.id}
                mimeType={item.mimeType}
                name={item.name}
                onRemove={() => remove(item.id)}
                previewUrl={item.dataUrl}
                sizeLabel={formatSize(item.size)}
              />
            ))}
          </div>
        ) : null}
        <textarea
          aria-label="Message the group"
          className="block max-h-48 min-h-[44px] w-full resize-none bg-transparent px-3.5 py-3 pr-20 text-fg text-sm outline-none placeholder:text-fg-faint"
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setCaret(event.currentTarget.selectionStart);
            setDismissedAt(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (open) {
              const current = suggestions[active];
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setHighlight((active + step + suggestions.length) % suggestions.length);
                return;
              }
              if ((event.key === "Enter" || event.key === "Tab") && current) {
                event.preventDefault();
                pick(current);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissedAt(query?.start ?? null);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          onPaste={(event) => {
            const files = event.clipboardData?.files;
            if (files && files.length > 0) {
              event.preventDefault();
              void addFiles(files);
            }
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          placeholder="Message the group, @ to mention, attach files"
          ref={inputRef}
          rows={1}
          value={value}
        />
        <input
          accept="image/png,image/jpeg,image/gif,image/webp,*/*"
          className="hidden"
          data-testid="group-composer-file-input"
          multiple
          onChange={(event) => {
            if (event.currentTarget.files) void addFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
          ref={fileInputRef}
          type="file"
        />
        <button
          aria-label="Attach files"
          className="absolute right-10 bottom-2 flex size-7 items-center justify-center rounded-full text-fg-faint transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
          data-testid="group-composer-attach"
          disabled={attachments.length >= MAX_GROUP_ATTACHMENTS || sending}
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          <IconPaperclip size={ICON.sm} stroke={ICON_STROKE.sm} />
        </button>
        <button
          aria-label="Send"
          className="absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-full bg-accent text-white transition-opacity disabled:opacity-40"
          disabled={!canSend}
          onClick={() => void send()}
          type="button"
        >
          <IconArrowUp size={ICON.sm} stroke={ICON_STROKE.sm} />
        </button>
      </div>
    </div>
  );
}
