import { m, useReducedMotion, type Variants } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { motionPreset, reducedFade, tween } from "../../lib/motion";

/**
 * The Settings layout every page is built from. Minimal by rule (Gabriel,
 * 2026-10): a heading and its controls, no subtitles, no per-row help text, no
 * borders or dividers. Rows are grouped on one glass surface (`.settings-group`,
 * styles/app.css) and separated by spacing only. Sections and rows enter with the
 * motion tokens; under reduced motion they fade (`reducedFade`), never snap.
 *
 * `notice` is the only extra line a row or section may carry, and only for
 * information the user cannot act safely without (an error, a warning, a state
 * that disables the control). It is not a place for explanations.
 */

export type SettingsNoticeTone = "muted" | "warning" | "danger";

const NOTICE_TONE: Record<SettingsNoticeTone, string> = {
  muted: "text-fg-muted",
  warning: "text-(--color-dialog-warning)",
  danger: "text-danger",
};

export function SettingsNotice({
  children,
  className,
  role,
  tone = "muted",
}: {
  children: ReactNode;
  className?: string;
  /** Defaults to "alert" for danger; pass "status" for non-interrupting errors. */
  role?: "alert" | "status" | undefined;
  tone?: SettingsNoticeTone | undefined;
}) {
  return (
    <p
      className={cn("text-xs leading-4", NOTICE_TONE[tone], className)}
      data-settings-notice={tone}
      role={role ?? (tone === "danger" ? "alert" : undefined)}
    >
      {children}
    </p>
  );
}

export function SettingsPageHeader({
  actions,
  title,
}: {
  actions?: ReactNode | undefined;
  title: string;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 pb-1">
      <h2 className="min-w-0 text-base font-medium text-fg">{title}</h2>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Enter recipe shared by sections (token-based; fade only when motion is reduced). */
export function useSettingsEnter() {
  return motionPreset("fadeUp", useReducedMotion());
}

export function SettingsSection({
  actions,
  children,
  notice,
  noticeTone,
  title,
}: {
  actions?: ReactNode | undefined;
  children: ReactNode;
  notice?: ReactNode | undefined;
  noticeTone?: SettingsNoticeTone | undefined;
  title?: string | undefined;
}) {
  const enter = useSettingsEnter();
  return (
    <m.section
      animate={enter.animate}
      className="flex flex-col gap-3"
      data-settings-section=""
      initial={enter.initial}
      transition={enter.transition}
    >
      {title || actions ? (
        <div className="flex min-w-0 items-center justify-between gap-3">
          {title ? <h3 className="min-w-0 text-sm font-medium text-fg">{title}</h3> : <span />}
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {notice ? <SettingsNotice tone={noticeTone}>{notice}</SettingsNotice> : null}
      {children}
    </m.section>
  );
}

const LIST_STAGGER = 0.025;

function listVariants(reduced: boolean): Variants {
  return {
    hidden: {},
    shown: { transition: { staggerChildren: reduced ? 0 : LIST_STAGGER } },
  };
}

function rowVariants(reduced: boolean): Variants {
  return reduced
    ? {
        hidden: { opacity: 0 },
        shown: { opacity: 1, transition: reducedFade },
      }
    : {
        hidden: { opacity: 0, y: 4 },
        shown: { opacity: 1, y: 0, transition: tween("base") },
      };
}

/** One glass group of rows. No border; rows are separated by spacing. */
export function SettingsList({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion() ?? false;
  return (
    <m.div
      animate="shown"
      className={cn("settings-group flex flex-col gap-0.5 p-1", className)}
      data-settings-list=""
      initial="hidden"
      variants={listVariants(reduced)}
    >
      {children}
    </m.div>
  );
}

export function SettingsRow({
  control,
  notice,
  noticeTone,
  title,
}: {
  control: ReactNode;
  notice?: ReactNode | undefined;
  noticeTone?: SettingsNoticeTone | undefined;
  title: ReactNode;
}) {
  const reduced = useReducedMotion() ?? false;
  return (
    <m.div
      className="settings-row flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 rounded-md px-3 py-2.5"
      data-settings-row=""
      variants={rowVariants(reduced)}
    >
      <div className="min-w-0 flex-1 basis-48">
        <h3 className="text-sm font-normal text-fg">{title}</h3>
        {notice ? (
          <SettingsNotice className="mt-0.5" tone={noticeTone}>
            {notice}
          </SettingsNotice>
        ) : null}
      </div>
      <div className="max-w-full shrink-0">{control}</div>
    </m.div>
  );
}

export function ReadOnlyPill({ children }: { children: string }) {
  return (
    <span className="rounded-full bg-chip px-2.5 py-1 text-xs text-fg-muted tabular-nums">
      {children}
    </span>
  );
}

/** Primary action: the one accent fill (logo purple) with white text (>= 4.5:1). */
export const SETTINGS_PRIMARY_BUTTON =
  "flex items-center justify-center gap-1.5 rounded-md bg-accent text-on-accent transition-colors hover:bg-accent/90 active:bg-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-50";

/** Focus ring for settings inputs and selects: accent, visible in both themes. */
export const SETTINGS_FOCUS_RING =
  "focus-visible:border-focus-ring/60 focus-visible:ring-2 focus-visible:ring-focus-ring";

/** Selected chip/tab inside Settings: accent tint + accent text. */
export const SETTINGS_SELECTED = "bg-selected text-(--accent-text,var(--color-accent))";

const SETTINGS_QUIET_BUTTON_BASE =
  "flex items-center justify-center gap-1.5 rounded-md bg-chip transition-colors hover:bg-chip-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/50 disabled:cursor-not-allowed disabled:opacity-40";

/** Secondary action: a quiet chip, no border. */
export const SETTINGS_SECONDARY_BUTTON = `${SETTINGS_QUIET_BUTTON_BASE} text-fg`;

/** Destructive action: same chip, red label (red carries meaning here). */
export const SETTINGS_DANGER_BUTTON = `${SETTINGS_QUIET_BUTTON_BASE} text-danger`;
