import { useEffect, useRef, useState } from "react";
import { ThinkingStates } from "../../components/ui/ThinkingStates";
import { SessionStatusDot } from "../agent/SessionStatusDot";
import {
  type GroupLiveTurnSnapshot,
  isStillWorking,
  STILL_WORKING_AFTER_MS,
} from "./groupLiveTurn";

/**
 * Compact live turn under a group member: phase + thought/tools/writing previews.
 * ChatPane's WorkFold is heavier; this is the room-facing stream so Stop ≠ silence.
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

  const lastActivity = live.lastEventAt > 0 ? live.lastEventAt : startedAtRef.current;
  const still = isStillWorking(mode, lastActivity, now, STILL_WORKING_AFTER_MS);
  const phaseLabel = still ? "Still working…" : String(live.phase);
  const working = mode === "running";

  return (
    <div className="min-w-0 space-y-1" data-testid="group-member-live-turn">
      <div className="flex min-w-0 items-center gap-1.5 text-fg-subtle text-sm">
        {working ? (
          <SessionStatusDot
            activity={{ running: true, needsInput: false, unread: false, failed: false }}
            className="-my-1"
          />
        ) : null}
        <span className="sr-only">{phaseLabel}</span>
        <ThinkingStates className="text-fg-subtle" label={phaseLabel} />
      </div>
      {live.thoughtPreview ? (
        <p className="line-clamp-2 text-2xs text-fg-faint" data-testid="group-live-thought">
          {live.thoughtPreview}
        </p>
      ) : null}
      {live.tools.length > 0 ? (
        <ul className="space-y-0.5" data-testid="group-live-tools">
          {live.tools.map((tool) => (
            <li
              className="truncate font-mono text-2xs text-fg-faint"
              data-done={tool.done || undefined}
              key={tool.id}
            >
              {tool.done ? "✓" : "·"} {tool.label}
              {tool.name !== tool.label ? ` · ${tool.name}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {live.writingPreview ? (
        <p className="line-clamp-3 text-2xs text-fg-muted" data-testid="group-live-writing">
          {live.writingPreview}
        </p>
      ) : null}
    </div>
  );
}
