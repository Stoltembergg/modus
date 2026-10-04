import { useEffect, useMemo, useRef, useState } from "react";
import type { PlanRef } from "../../../../shared/contracts";
import type { AgentEventHub } from "./agentEventHub";
import { buildVisibleTimelineBlocks, Timeline } from "./Timeline";
import { splitTimelinePresentation } from "./timelinePresentation";

/** Full per-session execution history, kept outside the durable chat transcript. */
export function ActivityTimeline({
  hub,
  sessionId,
  cwd,
  onOpenFile,
  onOpenPlan,
  onOpenSubagent,
}: {
  hub: AgentEventHub;
  sessionId: string | undefined;
  cwd: string | undefined;
  onOpenFile?(path: string, line?: number): void;
  onOpenPlan?(plan: PlanRef): void;
  onOpenSubagent?(childSessionId: string): void;
}) {
  const [events, setEvents] = useState(() => (sessionId ? hub.getHistory(sessionId) : []));
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      return;
    }
    return hub.subscribeHistory(sessionId, setEvents);
  }, [hub, sessionId]);

  const activityBlocks = useMemo(
    () => splitTimelinePresentation(buildVisibleTimelineBlocks(events)).activityBlocks,
    [events],
  );

  return (
    <section
      aria-label="Activity"
      className="surface-sidebar flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="activity-timeline"
      data-ui-surface="sidebar"
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-hairline px-3">
        <h2 className="text-xs font-medium text-fg-muted">Execution history</h2>
        <span className="text-2xs text-fg-faint tabular-nums" data-testid="activity-event-count">
          {events.length} {events.length === 1 ? "event" : "events"}
        </span>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" ref={scrollContainerRef}>
        {sessionId && activityBlocks.length > 0 ? (
          <Timeline
            blocks={activityBlocks}
            cwd={cwd}
            embedded
            {...(onOpenFile ? { onOpenFile } : {})}
            {...(onOpenPlan ? { onOpenPlan } : {})}
            {...(onOpenSubagent ? { onOpenSubagent } : {})}
          />
        ) : (
          <p className="px-4 py-8 text-center text-xs text-fg-faint">
            {sessionId
              ? "No execution activity recorded yet."
              : "Select a Direct Message to view activity."}
          </p>
        )}
      </div>
    </section>
  );
}
