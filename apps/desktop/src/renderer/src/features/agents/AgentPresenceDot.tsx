import { cn } from "../../lib/cn";
import type { GroupActivityState } from "../groups/useWorkingGroups";

export type AgentPresenceState = GroupActivityState | "archived";

export const AGENT_PRESENCE_LABEL: Record<AgentPresenceState, string> = {
  idle: "Idle",
  queued: "Queued",
  working: "Working",
  waiting: "Waiting for you",
  archived: "Archived",
};

/** Compact presence marker with reduced-motion-aware activity animation. */
export function AgentPresenceDot({
  state,
  className,
}: {
  state: AgentPresenceState;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        state === "working"
          ? "bg-success motion-safe:animate-pulse"
          : state === "waiting"
            ? "bg-amber-400 motion-safe:animate-pulse"
            : state === "queued"
              ? "bg-focus-ring-soft"
              : state === "archived"
                ? "bg-fg-faint/60"
                : "bg-fg-faint",
        className,
      )}
      data-presence={state}
      title={AGENT_PRESENCE_LABEL[state]}
    />
  );
}
