import { useEffect, useRef, useState } from "react";
import { buildSafeChainOfThought } from "../../../../shared/group-prompt-kit";
import { inlineLiveStatusLabel } from "../../../../shared/group-room-transcript";
import { shouldShowStillWorking } from "../../../../shared/group-semantic-presence";
import {
  type GroupLiveTurnSnapshot,
  isStillWorking,
  STILL_WORKING_AFTER_MS,
} from "./groupLiveTurn";
import { PromptChainOfThought } from "./prompt-kit/PromptKit";

/**
 * Ephemeral, safe progress summary inside the agent's message card.
 * Public prose can appear alongside it; raw model thinking is never rendered.
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
    if (mode === "running" || mode === "queued") startedAtRef.current = Date.now();
  }, [mode]);
  useEffect(() => {
    if (mode !== "running" && mode !== "queued") return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [mode]);

  // Terminal runs dismantle progress; streamed text stays alongside its summary.
  if (live.collapsed) return null;
  const stream = live.streamText.trim();

  const lastActivity = live.lastEventAt > 0 ? live.lastEventAt : startedAtRef.current;
  const still =
    mode === "running" &&
    (live.presence
      ? shouldShowStillWorking(live.presence, now, STILL_WORKING_AFTER_MS)
      : isStillWorking(mode, lastActivity, now, STILL_WORKING_AFTER_MS));
  const working = mode === "running";
  const progress =
    mode === "queued"
      ? ["Waiting for its turn"]
      : buildSafeChainOfThought({
          phase: String(live.phase),
          activity: live.presence?.activity,
          tools: live.tools,
          hasStream: Boolean(stream),
        });
  if (stream) {
    const writingIndex = progress.findIndex((step) => /writ/i.test(step));
    if (writingIndex >= 0) {
      const [writingStep] = progress.splice(writingIndex, 1);
      if (writingStep) progress.push(writingStep);
    }
  }
  if (still && !stream && !progress.some((step) => /still working/i.test(step))) {
    progress.push("Still working…");
  }
  const progressItems = progress.slice(-4);
  const statusSummary = inlineLiveStatusLabel({
    phase: stream ? "Writing" : String(live.phase),
    presenceState: stream ? "writing" : live.presence?.state,
    activity: live.presence?.activity,
    waitingFor: live.presence?.waitingFor,
    stillWorking: !stream && still,
    startedAt: live.presence?.startedAt ?? (mode === "queued" ? startedAtRef.current : undefined),
    nowMs: now,
  });
  const summary = progressItems[progressItems.length - 1] ?? statusSummary;

  return (
    <div
      className="flex min-w-0 items-start gap-1.5"
      data-label={summary}
      data-testid="group-member-live-turn"
      data-tone="temporary"
    >
      <div
        className={`mt-1.5 size-1.5 shrink-0 rounded-full bg-fg-faint${working ? " animate-pulse" : ""}`}
        aria-hidden
        data-working={working || undefined}
      />
      <div className="min-w-0 flex-1" data-testid="group-live-status">
        <PromptChainOfThought items={progressItems} summary={summary} title="Progress" />
      </div>
    </div>
  );
}
