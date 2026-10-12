import { VortexMark } from "../../components/ui/VortexMark";

/**
 * "Working on your request" — the live run indicator. It lives in the slot at
 * the top edge of the Composer (the same slot as the composer status strip),
 * absolutely positioned above the dock so showing/hiding it never pushes the
 * Composer or the transcript (no layout shift). Render it only while the run
 * is active: it unmounts as soon as the run finishes or is cancelled.
 */
export function ChatRunStatus({
  retrying,
  onOpenActivity,
}: {
  retrying: boolean;
  onOpenActivity?: () => void;
}) {
  return (
    <div
      className="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 flex max-w-full"
      data-testid="chat-run-status-slot"
    >
      <div
        className="pointer-events-auto flex h-7 min-w-0 items-center gap-2 rounded-full bg-canvas/90 pr-1 pl-2 text-xs text-fg-muted backdrop-blur-sm"
        data-testid="chat-run-status"
        role="status"
      >
        <VortexMark className="size-4 shrink-0" />
        <span className="truncate">
          {retrying ? "Retrying the current turn" : "Working on your request"}
        </span>
        {onOpenActivity ? (
          <button
            className="rounded px-1.5 py-0.5 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
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
