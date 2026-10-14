import { VortexMark } from "../../components/ui/VortexMark";
import { useShellText } from "../../lib/shellText";
import { type RunStage, runStageText } from "./runStage";
import { useThrottledValue } from "./useThrottledValue";

/** Minimum time a stage label stays on screen, so quick hops don't flicker. */
export const RUN_STAGE_MIN_MS = 600;

/**
 * Live run indicator ("Thinking…", "Running npm test", "Editing App.tsx", …).
 * It lives in the slot at the top edge of the Composer, absolutely positioned
 * above the dock so showing/hiding it or changing its text never pushes the
 * Composer or the transcript (no layout shift). The label is one line,
 * truncated. Render it only while the run is active: it unmounts as soon as
 * the run finishes or is cancelled.
 */
export function ChatRunStatus({
  retrying,
  stage = { kind: "working" },
  onOpenActivity,
}: {
  retrying: boolean;
  stage?: RunStage;
  onOpenActivity?: () => void;
}) {
  const t = useShellText();
  const text = runStageText(stage);
  const live = retrying ? t("shell.run.retrying") : t(text.key, text.vars);
  const label = useThrottledValue(live, RUN_STAGE_MIN_MS);
  return (
    <div
      className="pointer-events-none absolute bottom-full inset-x-0 z-20 mb-2 flex justify-center px-2"
      data-testid="chat-run-status-slot"
    >
      <div
        className="pointer-events-auto flex h-7 min-w-0 max-w-full items-center gap-2 chat-run-status pr-1 pl-2 text-xs text-fg-muted"
        data-testid="chat-run-status"
        role="status"
      >
        <VortexMark className="size-4 shrink-0" />
        <span
          className="min-w-0 truncate whitespace-nowrap"
          data-testid="chat-run-status-label"
          title={label}
        >
          {label}
        </span>
        {onOpenActivity ? (
          <button
            className="shrink-0 rounded px-1.5 py-0.5 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
            onClick={onOpenActivity}
            type="button"
          >
            Activity
          </button>
        ) : null}
      </div>
    </div>
  );
}
