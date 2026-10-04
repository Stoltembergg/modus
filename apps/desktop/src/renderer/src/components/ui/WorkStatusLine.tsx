import { IconChevronRight, IconSparkles } from "@tabler/icons-react";
import { useReducedMotion } from "motion/react";
import { type ReactNode, useId, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { WorkingText } from "./WorkingText";

type WorkStatusLineProps = {
  working: boolean;
  /** Label while working (also the live announcement for the working phase). */
  label?: string | undefined;
  /** Label once finished, e.g. "Thought", "Worked for", "Stopped by you". */
  doneLabel?: string | undefined;
  /** Custom visual for the label; receives the plain text and the working flag. */
  renderLabel?: ((text: string, working: boolean) => ReactNode) | undefined;
  /** Finished-state step list, behind a disclosure that starts closed. */
  steps?: readonly string[] | undefined;
  collapsible?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  /** Append the formatted `elapsed` to the done label. */
  showTimer?: boolean | undefined;
  /** Seconds, supplied (and ticked) by the caller. */
  elapsed?: number | undefined;
  /** Use the WorkingText sweep for the working label. */
  shimmer?: boolean | undefined;
  fontSize?: number | undefined;
  color?: string | undefined;
  className?: string | undefined;
};

/** `12.3s` under a minute, `1m 05.0s` from a minute on. */
export function formatElapsed(seconds: number): string {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths - minutes * 600) / 10;
  return `${minutes}m ${rest.toFixed(1).padStart(4, "0")}s`;
}

/**
 * Agent "working / done" status line. A sparkle glyph breathes while working and rests
 * dimmed when done; the working and done labels crossfade inside one grid cell so the
 * line keeps the width of the longer one. Optional finished-state steps sit behind a
 * disclosure that always starts closed (no open-then-close shift on mount). A sr-only
 * status region announces the working → done change. Reduced motion: no breath, no
 * sweep, instant swap.
 */
export function WorkStatusLine({
  working,
  label = "Working…",
  doneLabel = "Done",
  renderLabel,
  steps,
  collapsible = true,
  defaultOpen = false,
  showTimer = false,
  elapsed,
  shimmer = true,
  fontSize,
  color,
  className,
}: WorkStatusLineProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const listId = useId();
  const [open, setOpen] = useState(defaultOpen);

  // Announce one stable phrase per working phase (a streaming preview label must not
  // make the live region chatter on every token).
  const announcedWorking = useRef<string | null>(working ? label : null);
  if (working && announcedWorking.current === null) announcedWorking.current = label;
  if (!working) announcedWorking.current = null;

  const timer = !working && showTimer && elapsed !== undefined ? formatElapsed(elapsed) : null;
  const doneText = timer ? `${doneLabel} ${timer}` : doneLabel;
  const announcement = working ? (announcedWorking.current ?? label) : doneText;

  const workingNode = renderLabel ? (
    renderLabel(label, true)
  ) : shimmer ? (
    <WorkingText className="text-inherit">{label}</WorkingText>
  ) : (
    label
  );
  const doneNode = renderLabel ? renderLabel(doneText, false) : doneText;

  const hasSteps = Boolean(steps && steps.length > 0);
  const disclosure = collapsible && hasSteps && !working;

  const labels = (
    <span className="work-status-line__labels" data-reduced={reduceMotion ? "" : undefined}>
      <span
        aria-hidden={working ? undefined : "true"}
        className="work-status-line__label"
        data-layer="working"
        data-visible={working ? "true" : "false"}
      >
        {workingNode}
      </span>
      <span
        aria-hidden={working ? "true" : undefined}
        className="work-status-line__label"
        data-layer="done"
        data-visible={working ? "false" : "true"}
      >
        {doneNode}
      </span>
    </span>
  );

  const glyph = (
    <IconSparkles
      aria-hidden="true"
      className="work-status-line__glyph"
      data-working={working ? "" : undefined}
      size={Math.round((fontSize ?? 13) * 1.05)}
      stroke={1.7}
    />
  );

  return (
    <div
      className={cn("work-status-line", className)}
      data-state={working ? "working" : "done"}
      style={{
        ...(fontSize !== undefined ? { fontSize } : {}),
        ...(color !== undefined ? { color } : {}),
      }}
    >
      {disclosure ? (
        <button
          aria-controls={listId}
          aria-expanded={open}
          className="work-status-line__row work-status-line__toggle"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {glyph}
          {labels}
          <IconChevronRight
            aria-hidden="true"
            className="work-status-line__chevron"
            data-open={open ? "" : undefined}
            size={12}
            stroke={1.8}
          />
        </button>
      ) : (
        <div className="work-status-line__row">
          {glyph}
          {labels}
        </div>
      )}
      {disclosure ? (
        <ol className="work-status-line__steps" hidden={!open} id={listId}>
          {steps?.map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are plain strings that may repeat; order is stable.
            <li key={index}>{step}</li>
          ))}
        </ol>
      ) : null}
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </div>
  );
}
