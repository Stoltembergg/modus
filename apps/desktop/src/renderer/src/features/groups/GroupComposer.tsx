import { IconArrowUp, IconClockPause } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UpdateState } from "../../../../shared/contracts";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { GroupMemberQuestions } from "./GroupMemberQuestions";
import {
  activeMentionQuery,
  type MentionMember,
  type MentionSuggestion,
  mentionSuggestions,
} from "./groupMentions";
import { MemberName } from "./MemberName";
import { memberLabels } from "./memberLabels";
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
 */
export function GroupComposer({
  members,
  updatePending,
  onSend,
}: {
  members: readonly MentionMember[];
  updatePending: boolean;
  onSend(body: string): Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [caret, setCaret] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const memberStates = useGroupMemberStates();
  const labels = useMemo(() => memberLabels(members), [members]);
  const waitingSessionIds = useMemo(() => {
    const memberIds = new Set(members.map((member) => member.sessionId));
    const waiting: string[] = [];
    for (const entry of memberStates.values()) {
      for (const sessionId of entry.waitingSessionIds) {
        if (memberIds.has(sessionId) && !waiting.includes(sessionId)) waiting.push(sessionId);
      }
    }
    return waiting;
  }, [memberStates, members]);

  const query = activeMentionQuery(value, caret);
  const suggestions =
    query && query.start !== dismissedAt ? mentionSuggestions(query.query, members) : [];
  const open = suggestions.length > 0;
  const active = Math.min(highlight, Math.max(0, suggestions.length - 1));

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
    if (!body || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await onSend(body);
      setValue("");
      setCaret(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-4">
      {updatePending ? (
        <div
          className="mb-2 flex items-center gap-2 rounded-md border border-hairline bg-elevated px-3 py-1.5 text-fg-muted text-xs"
          data-testid="group-update-banner"
          role="status"
        >
          <IconClockPause size={ICON.sm} stroke={ICON_STROKE.sm} />
          <span className="font-medium text-fg">Paused while Modus updates</span>
          <span className="text-fg-faint">
            Messages are saved; members answer after the restart.
          </span>
        </div>
      ) : null}
      <GroupMemberQuestions labels={labels} waitingSessionIds={waitingSessionIds} />
      {error ? <div className="mb-2 text-danger text-xs">{error}</div> : null}
      <div className="relative rounded-xl border border-composer-border bg-elevated">
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
        <textarea
          aria-label="Message the group"
          className="block max-h-48 min-h-[44px] w-full resize-none bg-transparent px-3.5 py-3 pr-12 text-fg text-sm outline-none placeholder:text-fg-faint"
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
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          placeholder="Message the group, @ to mention a member"
          ref={inputRef}
          rows={1}
          value={value}
        />
        <button
          aria-label="Send"
          className="absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-full bg-accent text-white transition-opacity disabled:opacity-40"
          disabled={!value.trim() || sending}
          onClick={() => void send()}
          type="button"
        >
          <IconArrowUp size={ICON.sm} stroke={ICON_STROKE.sm} />
        </button>
      </div>
    </div>
  );
}
