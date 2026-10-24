import { IconHandStop } from "@tabler/icons-react";
import { ThinkingOrb } from "thinking-orbs";
import { cn } from "../../lib/cn";
import { useEffectiveTheme } from "../../lib/theme";
import type { SessionActivity } from "./agentEventHub";

/**
 * Sidebar session glyph: ThinkingOrb while running (same package/preset as
 * WorkFold — only size 20|64 are valid), the neutral hand-stop + dot for
 * needs-input (same as a blocked subagent / to-do; `.status-ping` only moves
 * without reduced motion), danger for failed, success for unread, soft
 * secondary idle dot otherwise.
 */
export function SessionStatusDot({
  activity,
  className,
}: {
  activity: SessionActivity | undefined;
  className?: string;
}) {
  const mode = useEffectiveTheme();

  if (activity?.needsInput) {
    return (
      <span
        className={cn("flex h-5 w-5 shrink-0 items-center justify-center gap-px", className)}
        data-status="needs-input"
        title="Needs your input"
      >
        <IconHandStop aria-hidden className="shrink-0 text-fg-muted" size={12} stroke={1.7} />
        <span className="relative flex size-1.5 shrink-0">
          <span className="status-ping absolute inset-0 rounded-full bg-fg-muted/50" />
          <span className="relative size-1.5 rounded-full bg-fg-muted" />
        </span>
        <span className="sr-only">Needs your input</span>
      </span>
    );
  }
  if (activity?.running) {
    return (
      <span
        className={cn("flex size-5 shrink-0 items-center justify-center", className)}
        title="Agent running"
      >
        <ThinkingOrb
          aria-label="Working"
          className="shrink-0"
          size={20}
          state="solving"
          theme={mode === "light" ? "light" : "dark"}
        />
        <span className="sr-only">Agent running</span>
      </span>
    );
  }
  if (activity?.failed) {
    return (
      <span
        className={cn("size-1.5 shrink-0 rounded-full bg-danger", className)}
        title="Last run failed"
      />
    );
  }
  if (activity?.unread) {
    return (
      <span
        className={cn("size-1.5 shrink-0 rounded-full bg-success", className)}
        title="Finished while in the background"
      />
    );
  }
  return (
    <span className={cn("size-1 shrink-0 rounded-full bg-fg-faint/40", className)} title="Idle" />
  );
}
