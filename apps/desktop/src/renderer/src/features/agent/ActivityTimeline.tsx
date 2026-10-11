import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentEventItem,
  type AgentEventPage,
  type AgentEventPageOptions,
  appendUniqueAgentEvents,
  prependAgentEventPage,
} from "../../../../shared/agent-events";
import type { PlanRef } from "../../../../shared/contracts";
import type { AgentEventHub } from "./agentEventHub";
import { buildVisibleTimelineBlocks, Timeline } from "./Timeline";
import { splitTimelinePresentation } from "./timelinePresentation";

const ACTIVITY_PAGE_SIZE = 128;

type ActivityHistoryPage = {
  snapshotCursor?: number;
  beforeCursor?: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  error: boolean;
};

function pageCursor(item: AgentEventItem): number | undefined {
  return item.event.eventCursor;
}

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
  const [historyPage, setHistoryPage] = useState<ActivityHistoryPage>({
    hasOlder: false,
    loadingOlder: false,
    error: false,
  });
  const historyRef = useRef(events);
  const historyPageRef = useRef(historyPage);
  const requestGenerationRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  historyRef.current = events;
  historyPageRef.current = historyPage;

  const updateHistoryPage = useCallback((next: ActivityHistoryPage): void => {
    historyPageRef.current = next;
    setHistoryPage(next);
  }, []);

  const loadOlderPage = useCallback(
    async (force = false): Promise<void> => {
      const current = historyPageRef.current;
      const generation = requestGenerationRef.current;
      if (
        !sessionId ||
        !current.hasOlder ||
        current.loadingOlder ||
        (current.error && !force) ||
        current.snapshotCursor === undefined
      ) {
        return;
      }
      const listEventPage = window.modus?.agent?.listEventPage;
      if (!listEventPage) return;
      updateHistoryPage({ ...current, loadingOlder: true, error: false });
      try {
        const options: AgentEventPageOptions = {
          direction: "backward",
          snapshotCursor: current.snapshotCursor,
          limit: ACTIVITY_PAGE_SIZE,
          ...(current.beforeCursor === undefined ? {} : { beforeCursor: current.beforeCursor }),
        };
        const page: AgentEventPage = await listEventPage(sessionId, options);
        if (requestGenerationRef.current !== generation) return;
        const merged = prependAgentEventPage(historyRef.current, page.events);
        historyRef.current = merged;
        setEvents(merged);
        updateHistoryPage({
          snapshotCursor: page.snapshotCursor,
          ...(page.nextCursor === undefined ? {} : { beforeCursor: page.nextCursor }),
          hasOlder: page.hasMore && page.nextCursor !== current.beforeCursor,
          loadingOlder: false,
          error: false,
        });
      } catch {
        if (requestGenerationRef.current === generation) {
          updateHistoryPage({ ...historyPageRef.current, loadingOlder: false, error: true });
        }
      }
    },
    [sessionId, updateHistoryPage],
  );

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    let disposed = false;
    if (!sessionId) {
      setEvents([]);
      historyRef.current = [];
      updateHistoryPage({ hasOlder: false, loadingOlder: false, error: false });
      return;
    }
    updateHistoryPage({ hasOlder: false, loadingOlder: false, error: false });
    const initialHistory = hub.getHistory(sessionId);
    historyRef.current = initialHistory;
    setEvents(initialHistory);
    const active = (): boolean => !disposed && requestGenerationRef.current === generation;
    const unsubscribe = hub.subscribeHistory(sessionId, (incoming) => {
      if (!active()) return;
      const snapshotCursor = historyPageRef.current.snapshotCursor;
      const liveItems = incoming.filter((item) => {
        const cursor = pageCursor(item);
        return snapshotCursor === undefined || cursor === undefined || cursor > snapshotCursor;
      });
      const merged = appendUniqueAgentEvents(historyRef.current, liveItems);
      historyRef.current = merged;
      setEvents(merged);
    });
    const listEventPage = window.modus?.agent?.listEventPage;
    if (listEventPage) {
      void listEventPage(sessionId, { direction: "backward", limit: ACTIVITY_PAGE_SIZE })
        .then((page: AgentEventPage) => {
          if (!active()) return;
          const current = hub.getHistory(sessionId);
          const liveItems = current.filter((item) => {
            const cursor = pageCursor(item);
            return cursor === undefined || cursor > page.snapshotCursor;
          });
          const merged = appendUniqueAgentEvents(page.events, liveItems);
          historyRef.current = merged;
          setEvents(merged);
          updateHistoryPage({
            snapshotCursor: page.snapshotCursor,
            ...(page.nextCursor === undefined ? {} : { beforeCursor: page.nextCursor }),
            hasOlder: page.hasMore,
            loadingOlder: false,
            error: false,
          });
        })
        .catch(() => {
          if (!active()) return;
          updateHistoryPage({ hasOlder: false, loadingOlder: false, error: true });
        });
    }
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [hub, sessionId, updateHistoryPage]);

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
      <div
        className="scroll-thin min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          if (event.currentTarget.scrollTop < 40) void loadOlderPage();
        }}
        ref={scrollContainerRef}
      >
        {historyPage.hasOlder ? (
          <button
            className="w-full px-3 py-2 text-xs text-fg-muted hover:text-fg"
            disabled={historyPage.loadingOlder}
            onClick={() => void loadOlderPage(historyPage.error)}
            type="button"
          >
            {historyPage.loadingOlder ? "Loading earlier activity…" : "Load earlier activity"}
          </button>
        ) : null}
        {historyPage.error ? (
          <p className="px-4 py-2 text-center text-xs text-fg-danger">
            Unable to load activity history. Try again.
          </p>
        ) : null}
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
