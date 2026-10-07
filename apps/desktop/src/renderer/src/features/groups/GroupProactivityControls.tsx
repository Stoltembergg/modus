import { useCallback, useEffect, useState } from "react";
import type { GroupRuntimeEvent } from "../../../../shared/contracts";
import type { GroupProactivityMode, GroupSuggestion } from "../../../../shared/group-work-state";
import { describeGroupError } from "./groupErrors";
import { useGroupText } from "./groupRoomI18n";

type MemberOption = { sessionId: string; label: string };

export function GroupProactivityControls({
  groupId,
  memberOptions,
}: {
  groupId: string;
  memberOptions: readonly MemberOption[];
}) {
  const t = useGroupText();
  const [mode, setMode] = useState<GroupProactivityMode>("suggest");
  const [suggestions, setSuggestions] = useState<GroupSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingMode, setSavingMode] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const [persistedMode, rows] = await Promise.all([
        window.modus.group.getProactivityMode(groupId),
        window.modus.group.listSuggestions(groupId),
      ]);
      setMode(persistedMode);
      setSuggestions(rows);
      setError(undefined);
    } catch (cause) {
      setError(describeGroupError(cause, t.locale));
    } finally {
      setLoading(false);
    }
  }, [groupId, t.locale]);

  useEffect(() => {
    setLoading(true);
    setSuggestions([]);
    void refresh();
    return window.modus.group.onEvent((event: GroupRuntimeEvent) => {
      if (
        "groupId" in event &&
        event.groupId === groupId &&
        (event.type === "group.suggestion-changed" ||
          event.type === "group.proactivity-mode-changed" ||
          event.type === "group.task-changed" ||
          event.type === "group.chain-ended")
      )
        void refresh();
    });
  }, [groupId, refresh]);

  async function changeMode(next: GroupProactivityMode): Promise<void> {
    if (savingMode || mode === next) return;
    const previous = mode;
    setMode(next);
    setSavingMode(true);
    setError(undefined);
    try {
      setMode(await window.modus.group.setProactivityMode(groupId, next));
    } catch (cause) {
      setMode(previous);
      setError(describeGroupError(cause, t.locale));
    } finally {
      setSavingMode(false);
    }
  }

  return (
    <section
      className="mb-3 rounded-md border border-hairline bg-elevated px-2.5 py-2"
      data-testid="group-proactivity-controls"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-fg">{t("proactivity.title")}</h3>
          <p className="mt-0.5 text-2xs text-fg-faint">{t("proactivity.defaultDescription")}</p>
        </div>
        <label className="flex shrink-0 items-center gap-1.5 text-2xs text-fg-muted">
          <input
            aria-label={t("proactivity.automaticSuggestions")}
            checked={mode === "opt_in_auto"}
            disabled={loading || savingMode}
            onChange={(event) =>
              void changeMode(event.currentTarget.checked ? "opt_in_auto" : "suggest")
            }
            type="checkbox"
          />
          {t("proactivity.automate")}
        </label>
      </div>
      {error ? (
        <p className="mt-1 text-2xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-2" data-testid="group-suggestions">
        <h4 className="mb-1 text-2xs text-fg-faint uppercase tracking-wide">
          {t("proactivity.suggestions")}{" "}
          <span data-testid="group-suggestion-count">{suggestions.length}</span>
        </h4>
        {loading ? (
          <p className="px-1 py-2 text-xs text-fg-faint">{t("proactivity.loading")}</p>
        ) : null}
        {!loading && suggestions.length === 0 ? (
          <p className="px-1 py-2 text-xs text-fg-faint">{t("proactivity.noPending")}</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {suggestions.map((suggestion) => (
            <SuggestionCard
              key={suggestion.actionId}
              memberOptions={memberOptions}
              onResolved={(actionId) =>
                setSuggestions((current) => current.filter((item) => item.actionId !== actionId))
              }
              suggestion={suggestion}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function SuggestionCard({
  suggestion,
  memberOptions,
  onResolved,
}: {
  suggestion: GroupSuggestion;
  memberOptions: readonly MemberOption[];
  onResolved(actionId: string): void;
}) {
  const t = useGroupText();
  const options = memberOptions.filter((member) =>
    suggestion.candidateSessionIds.includes(member.sessionId),
  );
  const initialTarget = suggestion.proposedTargetSessionId ?? options[0]?.sessionId ?? "";
  const [targetSessionId, setTargetSessionId] = useState(initialTarget);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const targetLabel = memberOptions.find((member) => member.sessionId === targetSessionId)?.label;
  const sourceLabel = [
    suggestion.source.kind,
    suggestion.source.eventId,
    suggestion.source.executionId,
  ]
    .filter(Boolean)
    .join(" · ");

  async function resolve(decision: "accept" | "discard"): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await window.modus.group.resolveSuggestion(
        suggestion.actionId,
        decision,
        suggestion.version,
        decision === "accept" && targetSessionId ? targetSessionId : undefined,
      );
      onResolved(suggestion.actionId);
    } catch (cause) {
      setError(describeGroupError(cause, t.locale));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className="rounded-md border border-hairline bg-base px-2.5 py-2 text-xs"
      data-testid="group-suggestion-card"
    >
      <h5 className="font-medium text-fg" data-testid="group-suggestion-task">
        {suggestion.task.title}
      </h5>
      <p className="mt-1 text-fg-muted" data-testid="group-suggestion-reason">
        {suggestion.reason}
      </p>
      <p className="mt-1 text-2xs text-fg-faint" data-testid="group-suggestion-origin">
        {t("proactivity.source")} {sourceLabel}
      </p>
      <label className="mt-2 flex items-center gap-2 text-2xs text-fg-muted">
        <span>{t("proactivity.delegateTo")}</span>
        <select
          aria-label={t("proactivity.delegateTo")}
          className="min-w-0 flex-1 rounded border border-hairline bg-base px-1.5 py-1"
          disabled={busy || options.length === 0}
          onChange={(event) => setTargetSessionId(event.currentTarget.value)}
          value={targetSessionId}
        >
          {options.map((member) => (
            <option key={member.sessionId} value={member.sessionId}>
              {member.label}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-1 text-2xs text-fg-faint" data-testid="group-suggestion-destination">
        {t("proactivity.destination")} {targetLabel ?? t("proactivity.chooseActiveMember")}
      </p>
      {error ? (
        <p className="mt-1 text-2xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          className="rounded bg-accent px-2 py-1 text-2xs text-on-accent disabled:opacity-50"
          disabled={busy || !targetSessionId}
          onClick={() => void resolve("accept")}
          type="button"
        >
          {suggestion.startNewExecution ? t("proactivity.startExecution") : t("proactivity.accept")}
        </button>
        <button
          className="rounded border border-hairline px-2 py-1 text-2xs text-fg-muted disabled:opacity-50"
          disabled={busy}
          onClick={() => void resolve("discard")}
          type="button"
        >
          {t("proactivity.discard")}
        </button>
      </div>
    </li>
  );
}
