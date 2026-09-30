import { useEffect, useRef, useState } from "react";
import { inlineLiveStatusLabel } from "../../../../shared/group-room-transcript";
import { shouldShowStillWorking } from "../../../../shared/group-semantic-presence";
import { ThinkingStates } from "../../components/ui/ThinkingStates";
import {
  type GroupLiveTurnSnapshot,
  isStillWorking,
  STILL_WORKING_AFTER_MS,
} from "./groupLiveTurn";
import { PromptTool } from "./prompt-kit/PromptKit";

/**
 * Ephemeral Thinking State + active Tool under the agent name.
 * Hidden once `message.delta` has produced stream text, and dismantled on run end.
 * Never persists into the transcript.
 */
export function GroupMemberLiveTurn({
  mode,
  live,
}: {
  mode: "running" | "queued";
  live: GroupLiveTurnSnapshot;
}) {
  const [now, setNow] = useState(() => Date.now());
  const startedAtRef = useRef(Date.now());
  useEffect(() => {
    if (mode === "running") startedAtRef.current = Date.now();
  }, [mode]);
  useEffect(() => {
    if (mode !== "running") return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [mode]);

  // Terminal runs and streamed text dismantle all transients immediately.
  if (live.collapsed) return null;
  const stream = live.streamText.trim();
  if (stream) return null;

  const lastActivity = live.lastEventAt > 0 ? live.lastEventAt : startedAtRef.current;
  const still =
    mode === "running" &&
    (live.presence
      ? shouldShowStillWorking(live.presence, now, STILL_WORKING_AFTER_MS)
      : isStillWorking(mode, lastActivity, now, STILL_WORKING_AFTER_MS));
  const statusLabel = inlineLiveStatusLabel({
    phase: String(live.phase),
    presenceState: live.presence?.state,
    activity: live.presence?.activity,
    waitingFor: live.presence?.waitingFor,
    stillWorking: still,
  });
  const working = mode === "running";
  // Only the active (not-done) tool — disappears as soon as it finishes.
  const activeTool = live.tools.find((tool) => !tool.done);

  return (
    <div className="min-w-0 space-y-1" data-testid="group-member-live-turn" data-tone="temporary">
      <div
        className="flex min-w-0 items-center gap-1.5 text-fg-subtle text-sm"
        data-testid="group-live-status"
      >
        {working ? (
          <span
            aria-hidden
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-fg-faint"
            data-testid="group-live-pulse"
          />
        ) : null}
        <span className="sr-only">{statusLabel}</span>
        <ThinkingStates className="text-fg-subtle" label={statusLabel} />
      </div>
      {activeTool ? (
        <PromptTool name={activeTool.label || activeTool.name} state="running" />
      ) : null}
    </div>
  );
}
