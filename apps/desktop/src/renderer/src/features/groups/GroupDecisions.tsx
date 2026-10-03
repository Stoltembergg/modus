import { IconChevronRight } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import type { GroupDecision, GroupRuntimeEvent } from "../../../../shared/contracts";
import { groupRoomIntlLocale } from "../../../../shared/group-room-locale";
import { GROUP_ROOM_TEXT_EN } from "../../../../shared/group-room-text";
import { cn } from "../../lib/cn";
import { formatClock } from "../../lib/formatClock";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { describeGroupError } from "./groupErrors";
import { useGroupText } from "./groupRoomI18n";
import { shouldRefreshGroupSidePanel } from "./groupSidePanelRefresh";
import { MemberName } from "./MemberName";
import type { MemberLabel } from "./memberLabels";

/** en catalog values (tests and callers comparing English); the UI uses the room locale. */
export const DECISIONS_EMPTY_TEXT = GROUP_ROOM_TEXT_EN["decisions.empty"];
/** Second-click label of the two-step "Delete" (like "Cancel task"). */
export const DELETE_DECISION_CONFIRM_LABEL = GROUP_ROOM_TEXT_EN["decisions.confirmDelete"];
export const FORMER_MEMBER_TEXT = GROUP_ROOM_TEXT_EN["decisions.formerMember"];

/**
 * The group's decisions (`group:list-decisions`, newest first). Reloads on
 * turn/activity and status lines — not on every chat `group.message`.
 */
export function useGroupDecisions(groupId: string) {
  const [decisions, setDecisions] = useState<GroupDecision[]>([]);
  const refresh = useCallback(async () => {
    try {
      setDecisions(await window.modus.group.listDecisions(groupId));
    } catch (error) {
      console.warn("[groups] failed to load decisions", error);
    }
  }, [groupId]);
  useEffect(() => {
    setDecisions([]);
    void refresh();
    return window.modus.group.onEvent((event: GroupRuntimeEvent) => {
      if (shouldRefreshGroupSidePanel(groupId, event)) void refresh();
    });
  }, [groupId, refresh]);
  const remove = useCallback((decisionId: string) => {
    setDecisions((current) => current.filter((item) => item.id !== decisionId));
  }, []);
  return { decisions, remove };
}

/**
 * "Decisions" at the top of the room's side panel: collapsible, with a
 * counter. The only user action is "Delete" (two clicks; posts nothing).
 */
export function GroupDecisionsSection({
  groupId,
  labels,
}: {
  groupId: string;
  labels: ReadonlyMap<string, MemberLabel>;
}) {
  const { decisions, remove } = useGroupDecisions(groupId);
  const [open, setOpen] = useState(true);
  const t = useGroupText();
  return (
    <section className="mb-3" data-testid="decision-section">
      <button
        aria-expanded={open}
        className="mb-1 flex w-full items-center gap-1 px-1 text-2xs text-fg-faint uppercase tracking-wide hover:text-fg-muted"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <IconChevronRight
          className={cn("transition-transform", open && "rotate-90")}
          size={ICON.xs}
          stroke={ICON_STROKE.xs}
        />
        {t("decisions.title")}{" "}
        <span className="tabular-nums" data-testid="decision-count">
          {decisions.length}
        </span>
      </button>
      {open && decisions.length === 0 ? (
        <div className="px-1 py-2 text-fg-faint text-xs">{t("decisions.empty")}</div>
      ) : null}
      {open
        ? decisions.map((decision) => (
            <DecisionCard
              decision={decision}
              key={decision.id}
              labels={labels}
              onDeleted={remove}
            />
          ))
        : null}
    </section>
  );
}

function DecisionCard({
  decision,
  labels,
  onDeleted,
}: {
  decision: GroupDecision;
  labels: ReadonlyMap<string, MemberLabel>;
  onDeleted(decisionId: string): void;
}) {
  const t = useGroupText();
  const intl = groupRoomIntlLocale(t.locale);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Only members record decisions: no author (session deleted) or an author who
  // left the group shows as a former member, never as the user.
  const authorLabel = decision.authorSessionId ? labels.get(decision.authorSessionId) : undefined;
  const createdAt = Date.parse(decision.createdAt);

  async function remove(): Promise<void> {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await window.modus.group.deleteDecision(decision.id);
      onDeleted(decision.id);
    } catch (cause) {
      setError(describeGroupError(cause, t.locale));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div
      className="mb-1.5 rounded-md border border-hairline bg-elevated px-2.5 py-2 text-xs"
      data-testid="group-decision"
    >
      <div className="whitespace-pre-wrap break-words text-fg">{decision.text}</div>
      <div className="mt-1 flex min-w-0 items-center gap-1 text-2xs text-fg-faint">
        <span className="min-w-0 truncate text-fg-muted" data-testid="decision-author">
          {authorLabel ? (
            <MemberName label={authorLabel} />
          ) : (
            <span className="text-fg-faint">{t("decisions.formerMember")}</span>
          )}
        </span>
        <span aria-hidden>·</span>
        <time
          className="shrink-0"
          dateTime={decision.createdAt}
          title={Number.isFinite(createdAt) ? new Date(createdAt).toLocaleString(intl) : undefined}
        >
          {formatClock(createdAt, undefined, intl)}
        </time>
      </div>
      {error ? <div className="mt-1 text-danger">{error}</div> : null}
      <button
        className={cn(
          "mt-1.5 rounded-md px-1.5 py-0.5 text-2xs transition-colors",
          confirming ? "bg-danger/10 text-danger" : "text-fg-faint hover:bg-hover hover:text-fg",
        )}
        disabled={busy}
        onBlur={() => setConfirming(false)}
        onClick={() => void remove()}
        type="button"
      >
        {confirming ? t("decisions.confirmDelete") : t("decisions.delete")}
      </button>
    </div>
  );
}
