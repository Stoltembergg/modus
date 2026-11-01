/**
 * Unified Question Tool card — ported and adapted from 21st.dev Agent Elements
 * (`lib/agent-ui/components/question/question-tool.tsx` + `question-prompt.tsx`),
 * MIT License, Copyright (c) 2026 21st.dev. See THIRD_PARTY_NOTICES.md at the
 * repo root for the full license text.
 *
 * Modus adaptations: Modus theme tokens (light/dark follow the active theme)
 * instead of the `an-*` / shadcn tokens, Tabler icons, numbered options with
 * digit shortcuts, Modus's QuestionPrompt/QuestionAnswer contracts, an
 * approval mode (the app's permission card) and a transcript summary mode.
 *
 * One card, three modes:
 * - `question` — single-choice, multi-choice and free-text prompts with an
 *   optional free-text row; paginates across prompts and resolves via
 *   onSubmit(answers) / onSkip(). Locks after an answer is sent.
 * - `approval` — a draft/request with ranked choices, Deny and a primary
 *   action (Approve / Submit), optional reason input. Locks while deciding.
 * - `summary` — transcript record of a finished ask_user call
 *   ("Asked N questions", expandable answers) or the in-flight "Asking…" line.
 *
 * Status: `pending` (interactive), `answered` and `expired` (read-only).
 */
import {
  IconChevronLeft,
  IconChevronRight,
  IconCornerDownLeft,
  IconInfoCircle,
  IconLock,
  IconMessageCircleQuestion,
  IconPencil,
  IconSelector,
} from "@tabler/icons-react";
import { m, useReducedMotion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { QuestionAnswer, QuestionPrompt } from "../../../../shared/contracts";
import { cn } from "../../lib/cn";
import { motionOffset, motionTransition, tween } from "../../lib/motion";
import { useSettingsText } from "../../lib/settingsText";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { CollapsibleMotion } from "../ui/CollapsibleMotion";
import { WorkingText } from "../ui/WorkingText";
import { questionPromptDisplay } from "./questionPromptText";

export type QuestionCardStatus = "pending" | "answered" | "expired";

export type QuestionKind = "single" | "multi" | "text";

/** Single choice by default, multi when `multiSelect`, free text when there are no options. */
export function questionKind(question: QuestionPrompt): QuestionKind {
  if (question.options.length === 0) return "text";
  return question.multiSelect ? "multi" : "single";
}

type Draft = { selected: string[]; custom: string };

const EMPTY_DRAFT: Draft = { selected: [], custom: "" };

function initialDraft(question: QuestionPrompt): Draft {
  // Single-choice prompts start on the recommended option (else the first);
  // multi-select and free text start empty.
  if (questionKind(question) === "single") {
    const preferred = question.options.find((option) => option.recommended) ?? question.options[0];
    return { selected: preferred ? [preferred.label] : [], custom: "" };
  }
  return { selected: [], custom: "" };
}

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    !!value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function"
  );
}

const SHELL =
  "mb-2 overflow-hidden rounded-xl border border-composer-border bg-elevated shadow-composer-edge outline-none focus-visible:shadow-composer-focus";

function StatusBadge({ status }: { status: QuestionCardStatus }) {
  const t = useSettingsText();
  if (status === "pending") return null;
  return (
    <span
      className={cn(
        "rounded bg-chip px-1.5 py-0.5 text-2xs",
        status === "expired" ? "text-fg-muted" : "text-success",
      )}
      data-status={status}
    >
      {status === "expired" ? t("settings.question.expired") : t("settings.question.answered")}
    </span>
  );
}

function CardHeader({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-7 items-center justify-between gap-2 border-hairline border-b px-3.5 text-fg-muted text-xs">
      <div className="inline-flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      <div className="inline-flex items-center gap-1.5">{children}</div>
    </div>
  );
}

/* ── Question mode ───────────────────────────────────────────────────── */

export type QuestionCardQuestionProps = {
  mode: "question";
  questions: QuestionPrompt[];
  status?: QuestionCardStatus;
  /** Resolves the request. A returned promise that rejects re-enables the card. */
  onSubmit?: (answers: QuestionAnswer[]) => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  submitLabel?: string;
  nextLabel?: string;
  skipLabel?: string;
  customPlaceholder?: string;
  className?: string;
};

function QuestionMode({
  questions,
  status = "pending",
  onSubmit,
  onSkip,
  submitLabel,
  nextLabel,
  skipLabel,
  customPlaceholder,
  className,
}: QuestionCardQuestionProps) {
  const t = useSettingsText();
  const [index, setIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(questions.map((question) => [question.id, initialDraft(question)])),
  );
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const containerRef = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();

  // Focus the card on mount so the scoped keyboard handler works without
  // stealing keys from the composer.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const active = questions[index];
  if (!active) {
    return null;
  }
  const kind = questionKind(active);
  const display = questionPromptDisplay(active, t);
  const draft = drafts[active.id] ?? EMPTY_DRAFT;
  const isLast = index >= questions.length - 1;
  const multiple = questions.length > 1;
  const locked = status !== "pending" || sent;

  function updateDraft(id: string, next: Partial<Draft>): void {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_DRAFT), ...next } }));
  }

  function selectAt(optionIndex: number): void {
    const option = active?.options[optionIndex];
    if (!active || !option || locked) return;
    setCursor(optionIndex);
    if (kind === "multi") {
      const current = drafts[active.id]?.selected ?? [];
      const selected = current.includes(option.label)
        ? current.filter((label) => label !== option.label)
        : [...current, option.label];
      updateDraft(active.id, { selected });
    } else {
      updateDraft(active.id, { selected: [option.label] });
    }
  }

  function moveCursor(delta: number): void {
    if (!active) return;
    const next = Math.max(0, Math.min(cursor + delta, active.options.length - 1));
    setCursor(next);
    // Single choice: the highlight IS the selection (radio behaviour).
    if (kind === "single") {
      const option = active.options[next];
      if (option) updateDraft(active.id, { selected: [option.label] });
    }
  }

  function goToPage(next: number): void {
    setIndex(Math.max(0, Math.min(next, questions.length - 1)));
    setCursor(0);
  }

  function collectAnswers(): QuestionAnswer[] {
    return questions.map((entry) => {
      const entryDraft = drafts[entry.id] ?? EMPTY_DRAFT;
      const custom = entryDraft.custom.trim();
      return { questionId: entry.id, selected: entryDraft.selected, ...(custom ? { custom } : {}) };
    });
  }

  function resolveWith(action: (() => void | Promise<void>) | undefined): void {
    if (locked || !action) return;
    setSent(true);
    setError(undefined);
    const fail = (caught: unknown) => {
      setSent(false);
      setError(errorText(caught));
    };
    try {
      const result = action();
      if (isPromise(result)) result.catch(fail);
    } catch (caught) {
      fail(caught);
    }
  }

  function primaryAction(): void {
    if (locked) return;
    if (isLast) {
      const submit = onSubmit;
      resolveWith(submit ? () => submit(collectAnswers()) : undefined);
    } else {
      goToPage(index + 1);
    }
  }

  function skip(): void {
    resolveWith(onSkip);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (locked || !active) return;
    const typing = (event.target as HTMLElement).tagName === "INPUT";
    if (event.key === "Enter") {
      event.preventDefault();
      primaryAction();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      skip();
      return;
    }
    if (typing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveCursor(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveCursor(-1);
    } else if (event.key === "ArrowRight" && !isLast) {
      event.preventDefault();
      goToPage(index + 1);
    } else if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      goToPage(index - 1);
    } else if (event.key === " ") {
      event.preventDefault();
      selectAt(cursor);
    } else if (/^[1-9]$/.test(event.key)) {
      const optionIndex = Number(event.key) - 1;
      if (optionIndex < active.options.length) {
        event.preventDefault();
        selectAt(optionIndex);
      }
    }
  }

  return (
    <m.section
      animate={{ opacity: 1, y: 0 }}
      aria-disabled={locked || undefined}
      aria-label={t("settings.question.question")}
      className={cn(SHELL, className)}
      data-kind={kind}
      data-mode="question"
      data-status={sent && status === "pending" ? "answered" : status}
      initial={{ opacity: 0, y: motionOffset(4, reduceMotion) }}
      onKeyDown={onKeyDown}
      ref={containerRef}
      tabIndex={-1}
      transition={motionTransition(tween("base"), reduceMotion)}
    >
      <CardHeader
        icon={<IconMessageCircleQuestion size={ICON.sm} stroke={ICON_STROKE.sm} />}
        label={multiple ? t("settings.question.questions") : t("settings.question.question")}
      >
        <StatusBadge status={sent && status === "pending" ? "answered" : status} />
        {multiple ? (
          <>
            <button
              aria-label={t("settings.question.previousQuestion")}
              className="flex size-5 items-center justify-center rounded outline-none transition-colors hover:bg-hover hover:text-fg-subtle focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40"
              disabled={index === 0}
              onClick={() => goToPage(index - 1)}
              type="button"
            >
              <IconChevronLeft size={ICON.sm} stroke={ICON_STROKE.sm} />
            </button>
            <span className="tabular-nums">
              {t("settings.question.pageOf", { index: index + 1, total: questions.length })}
            </span>
            <button
              aria-label={t("settings.question.nextQuestion")}
              className="flex size-5 items-center justify-center rounded outline-none transition-colors hover:bg-hover hover:text-fg-subtle focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40"
              disabled={isLast}
              onClick={() => goToPage(index + 1)}
              type="button"
            >
              <IconChevronRight size={ICON.sm} stroke={ICON_STROKE.sm} />
            </button>
          </>
        ) : null}
      </CardHeader>

      <div className="px-3.5 py-3">
        <div className="min-w-0">
          <div className="font-semibold text-md text-fg leading-snug">{display.header}</div>
          {display.detail ? (
            <div className="mt-1 text-fg-subtle text-xs leading-relaxed">{display.detail}</div>
          ) : null}
        </div>

        {active.options.length > 0 ? (
          <div className="mt-2.5 flex flex-col gap-1">
            {active.options.map((option, optionIndex) => {
              const selected = draft.selected.includes(option.label);
              const isCursor = optionIndex === cursor;
              return (
                <button
                  aria-pressed={selected}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-default",
                    selected ? "bg-build/12" : "enabled:hover:bg-hover",
                    locked && !selected && "opacity-60",
                  )}
                  disabled={locked}
                  key={option.label}
                  onClick={() => selectAt(optionIndex)}
                  type="button"
                >
                  <span
                    className={cn(
                      "flex size-[18px] shrink-0 items-center justify-center font-semibold text-2xs",
                      kind === "multi" ? "rounded" : "rounded-full",
                      selected ? "bg-build text-build-fg" : "border border-hairline text-fg-muted",
                    )}
                  >
                    {optionIndex + 1}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-sm">
                    <span className="truncate font-medium text-fg">
                      {display.optionLabel(option.label)}
                    </span>
                    {option.recommended ? (
                      <span className="shrink-0 text-fg-muted text-xs">
                        {t("settings.question.recommended")}
                      </span>
                    ) : null}
                    {option.description ? (
                      <IconInfoCircle
                        className="shrink-0 text-fg-muted"
                        size={ICON.sm}
                        stroke={ICON_STROKE.sm}
                        title={option.description}
                      />
                    ) : null}
                  </span>
                  <span className="flex-1" />
                  {isCursor && !locked ? (
                    <IconSelector
                      className="shrink-0 text-fg-faint/70"
                      size={ICON.sm}
                      stroke={ICON_STROKE.sm}
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="mt-2.5 flex items-center gap-2">
          <IconPencil className="shrink-0 text-fg-faint" size={ICON.sm} stroke={ICON_STROKE.sm} />
          <input
            aria-label={
              kind === "text"
                ? t("settings.question.yourAnswer")
                : t("settings.question.otherAnswer")
            }
            className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-faint outline-none disabled:opacity-60"
            disabled={locked}
            onChange={(event) => updateDraft(active.id, { custom: event.target.value })}
            placeholder={
              kind === "text"
                ? t("settings.question.typeAnswer")
                : (customPlaceholder ?? t("settings.question.customPlaceholder"))
            }
            value={draft.custom}
          />
          {onSkip ? (
            <button
              className="flex shrink-0 items-center gap-1 rounded-md text-fg-faint text-xs outline-none transition-colors enabled:hover:text-fg-subtle focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
              disabled={locked}
              onClick={skip}
              type="button"
            >
              {skipLabel ?? t("settings.question.dismiss")}
              <kbd className="rounded border border-hairline px-1 py-px font-sans text-2xs">
                ESC
              </kbd>
            </button>
          ) : null}
          <button
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-build px-3 py-[6px] font-medium text-sm text-build-fg outline-none transition-colors enabled:hover:bg-build-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
            disabled={locked}
            onClick={primaryAction}
            type="button"
          >
            {isLast
              ? (submitLabel ?? t("settings.question.submit"))
              : (nextLabel ?? t("settings.question.next"))}
            <span className="text-2xs text-build-fg/60">⏎</span>
          </button>
        </div>
        {error ? (
          <p className="mt-2 truncate text-danger text-xs" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </m.section>
  );
}

/* ── Approval mode ───────────────────────────────────────────────────── */

export type ApprovalChoice = {
  id: string;
  /** Keyboard shortcut shown on the row (e.g. "1"). */
  key: string;
  title: string;
  description?: string;
};

export type QuestionCardApprovalProps = {
  mode: "approval";
  title: string;
  /** Short monospace chip next to the title (e.g. the action id). */
  badge?: string;
  /** Why the agent is asking. */
  reason?: string;
  /** The draft / target being approved, shown in a code block. */
  target?: string;
  /** Exact payload (e.g. code) that will run, behind a "Show details" toggle. */
  details?: string;
  /** Message shown in place of the actions once the card expired. */
  expiredMessage?: string;
  choices: ApprovalChoice[];
  defaultChoice: string;
  /** Choice sent by the Deny button and Escape. */
  denyChoice: string;
  approveLabel?: string;
  denyLabel?: string;
  /** Show an optional free-text reason passed as the second onDecide argument. */
  allowReason?: boolean;
  status?: QuestionCardStatus;
  /** A returned promise that rejects re-enables the card and shows the error. */
  onDecide?: (choiceId: string, reason?: string) => void | Promise<void>;
  className?: string;
};

function ApprovalMode({
  title,
  badge,
  reason,
  target,
  details,
  expiredMessage,
  choices,
  defaultChoice,
  denyChoice,
  approveLabel,
  denyLabel,
  allowReason = false,
  status = "pending",
  onDecide,
  className,
}: QuestionCardApprovalProps) {
  const t = useSettingsText();
  const [selected, setSelected] = useState(defaultChoice);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();
  const locked = status !== "pending" || submitting;

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  async function submit(choice: string = selected): Promise<void> {
    if (locked || !onDecide) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const trimmed = note.trim();
      await (allowReason && trimmed ? onDecide(choice, trimmed) : onDecide(choice));
    } catch (caught) {
      setSubmitting(false);
      setError(errorText(caught));
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (locked) return;
    const typing = (event.target as HTMLElement).tagName === "INPUT";
    const choice = typing ? undefined : choices.find((item) => item.key === event.key);
    if (choice) {
      event.preventDefault();
      setSelected(choice.id);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      void submit(denyChoice);
    }
  }

  return (
    <m.section
      animate={{ opacity: 1, y: 0 }}
      aria-disabled={locked || undefined}
      aria-label={t("settings.question.toolApproval")}
      className={cn(SHELL, className)}
      data-mode="approval"
      data-status={status}
      initial={{ opacity: 0, y: motionOffset(4, reduceMotion) }}
      onKeyDown={handleKeyDown}
      ref={panelRef}
      tabIndex={-1}
      transition={motionTransition(tween("base"), reduceMotion)}
    >
      <CardHeader
        icon={<IconLock size={ICON.sm} stroke={ICON_STROKE.sm} />}
        label={t("settings.question.approval")}
      >
        <StatusBadge status={status} />
      </CardHeader>
      <div className="px-3.5 py-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="font-semibold text-md text-fg leading-snug">{title}</h2>
            {badge ? (
              <span className="rounded bg-chip px-1.5 py-0.5 font-mono text-2xs text-fg-faint">
                {badge}
              </span>
            ) : null}
          </div>
          {reason ? <p className="mt-1 line-clamp-2 text-xs text-fg-subtle">{reason}</p> : null}
        </div>

        {target ? (
          <div className="mt-2.5 min-w-0 rounded-md bg-code-bg px-3 py-2 font-mono text-xs text-fg wrap-break-word">
            {target}
          </div>
        ) : null}

        {details ? (
          <div className="mt-2">
            <button
              aria-expanded={showDetails}
              className="rounded-md text-xs text-fg-faint outline-none transition-colors hover:text-fg-subtle focus-visible:ring-2 focus-visible:ring-focus-ring"
              data-testid="approval-details-toggle"
              onClick={() => setShowDetails((value) => !value)}
              type="button"
            >
              {showDetails
                ? t("settings.question.hideDetails")
                : t("settings.question.showDetails")}
            </button>
            {showDetails ? <ApprovalDetails details={details} /> : null}
          </div>
        ) : null}

        {status === "expired" && expiredMessage ? (
          <p className="mt-2.5 text-xs text-fg-subtle" role="status">
            {expiredMessage}
          </p>
        ) : null}

        <div className="mt-2.5 flex flex-col gap-1">
          {choices.map((choice) => {
            const active = selected === choice.id;
            const deny = choice.id === denyChoice;
            return (
              <button
                aria-pressed={active}
                className={cn(
                  "flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-default",
                  active
                    ? deny
                      ? "bg-danger/8"
                      : "bg-build/12"
                    : "text-fg-muted enabled:hover:bg-hover enabled:hover:text-fg",
                  locked && !active && "opacity-60",
                )}
                disabled={locked}
                key={choice.id}
                onClick={() => setSelected(choice.id)}
                type="button"
              >
                <span
                  className={cn(
                    "mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full font-semibold text-2xs",
                    active
                      ? deny
                        ? "bg-danger text-white"
                        : "bg-build text-build-fg"
                      : "border border-hairline text-fg-muted",
                  )}
                >
                  {choice.key}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block font-medium text-sm leading-snug",
                      deny && active ? "text-danger" : "text-fg",
                    )}
                  >
                    {choice.title}
                  </span>
                  {choice.description ? (
                    <span className="mt-0.5 block text-xs leading-snug text-fg-muted">
                      {choice.description}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>

        {allowReason ? (
          <div className="mt-2.5 flex items-center gap-2">
            <IconPencil className="shrink-0 text-fg-faint" size={ICON.sm} stroke={ICON_STROKE.sm} />
            <input
              aria-label={t("settings.question.reasonOptional")}
              className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-faint outline-none disabled:opacity-60"
              disabled={locked}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("settings.question.reasonPlaceholder")}
              value={note}
            />
          </div>
        ) : null}

        <div className="mt-2.5 flex min-w-0 items-center justify-end gap-2 border-hairline-soft border-t pt-2.5">
          {error ? (
            <p className="min-w-0 flex-1 truncate text-xs text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-[6px] text-fg-faint text-xs outline-none transition-colors enabled:hover:bg-hover enabled:hover:text-fg-subtle focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
            disabled={locked}
            onClick={() => void submit(denyChoice)}
            type="button"
          >
            {denyLabel ?? t("settings.question.deny")}
            <kbd className="rounded border border-hairline px-1 py-px font-sans text-2xs">ESC</kbd>
          </button>
          <button
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-build px-3 py-[6px] font-medium text-sm text-build-fg outline-none transition-colors enabled:hover:bg-build-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
            disabled={locked}
            onClick={() => void submit()}
            type="button"
          >
            {submitting
              ? t("settings.question.submitting")
              : (approveLabel ?? t("settings.question.approve"))}
            <IconCornerDownLeft size={ICON.sm} stroke={ICON_STROKE.sm} />
          </button>
        </div>
      </div>
    </m.section>
  );
}

/* ── Summary mode (transcript record) ────────────────────────────────── */

export type QuestionSummaryItem = {
  id: string;
  header: string;
  answer: string;
  recommended?: boolean;
};

export type QuestionCardSummaryProps = {
  mode: "summary";
  /** In-flight call: renders the shimmering "Asking…" line. */
  running?: boolean;
  items: QuestionSummaryItem[];
  label?: string;
  className?: string;
};

function SummaryMode({ running = false, items, label, className }: QuestionCardSummaryProps) {
  const t = useSettingsText();
  const [open, setOpen] = useState(false);
  const count = items.length;
  const text = useMemo(
    () => label ?? t.plural("settings.question.asked", count),
    [count, label, t],
  );

  if (running) {
    return (
      <div
        className={cn("flex min-w-0 items-center gap-2 py-0.5 text-sm", className)}
        data-mode="summary"
        data-status="pending"
      >
        <WorkingText className="min-w-0 flex-1 truncate">
          {t("settings.question.asking")}
        </WorkingText>
      </div>
    );
  }

  return (
    <div className={cn("min-w-0 text-sm", className)} data-mode="summary" data-status="answered">
      <button
        aria-expanded={open}
        className="flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1 outline-none text-left text-fg-subtle transition-colors hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-focus-ring"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="font-medium">{text}</span>
        <IconChevronRight
          className="disclosure-chevron shrink-0 text-fg-faint duration-(--motion-duration-base)"
          data-open={open ? "" : undefined}
          size={13}
          stroke={1.7}
        />
      </button>

      <CollapsibleMotion open={open} preset="timeline">
        <div className="mt-1.5 flex flex-col gap-2.5 border-hairline border-l pl-3">
          {items.map((item) => (
            <div className="min-w-0" key={item.id}>
              <div className="font-medium text-sm text-fg">{item.header}</div>
              <div className="mt-0.5 text-fg-muted text-xs">
                {item.answer || "—"}
                {item.recommended ? (
                  <span className="ml-1.5 text-fg-muted">{t("settings.question.recommended")}</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </CollapsibleMotion>
    </div>
  );
}

/* ── Public entry ────────────────────────────────────────────────────── */

export type QuestionCardProps =
  | QuestionCardQuestionProps
  | QuestionCardApprovalProps
  | QuestionCardSummaryProps;

export function QuestionCard(props: QuestionCardProps) {
  if (props.mode === "approval") return <ApprovalMode {...props} />;
  if (props.mode === "summary") return <SummaryMode {...props} />;
  return <QuestionMode {...props} />;
}

const APPROVAL_DETAILS_PREVIEW_LINES = 40;

/** Exact payload behind "Show details". Long payloads collapse, always saying how much is hidden. */
export function ApprovalDetails({ details }: { details: string }) {
  const t = useSettingsText();
  const [showAll, setShowAll] = useState(false);
  const lines = details.split("\n");
  const isDiff = details.startsWith("@@");
  const hidden = Math.max(0, lines.length - APPROVAL_DETAILS_PREVIEW_LINES);
  const visible =
    showAll || hidden === 0 ? details : lines.slice(0, APPROVAL_DETAILS_PREVIEW_LINES).join("\n");
  return (
    <>
      <pre
        className="mt-1.5 max-h-96 min-w-0 overflow-auto whitespace-pre-wrap rounded-md bg-code-bg px-3 py-2 font-mono text-xs text-fg"
        data-testid="approval-details"
      >
        {visible.split("\n").map((line, index, all) => (
          <span
            className={
              !isDiff
                ? undefined
                : line.startsWith("+")
                  ? "text-success"
                  : line.startsWith("-")
                    ? "text-danger"
                    : undefined
            }
            // biome-ignore lint/suspicious/noArrayIndexKey: static lines
            key={index}
          >
            {index < all.length - 1 ? `${line}\n` : line}
          </span>
        ))}
      </pre>
      {hidden > 0 ? (
        <button
          className="mt-1 rounded-md text-xs text-fg-faint outline-none transition-colors hover:text-fg-subtle focus-visible:ring-2 focus-visible:ring-focus-ring"
          data-testid="approval-details-show-all"
          onClick={() => setShowAll((value) => !value)}
          type="button"
        >
          {showAll
            ? t("settings.question.showLess")
            : t.plural("settings.question.showAllLines", hidden)}
        </button>
      ) : null}
    </>
  );
}
