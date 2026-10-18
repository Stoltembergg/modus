import { IconAlertCircle } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentEventItem,
  type AgentEventPage,
  type AgentEventPageOptions,
  appendUniqueAgentEvents,
  prependAgentEventPage,
} from "../../../../shared/agent-events";
import type { AgentInfo, PlanRef } from "../../../../shared/contracts";
import { useShellText } from "../../lib/shellText";
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
  /** The last older page added no events: stop auto-filling (the button still works). */
  fillStalled?: boolean;
};

function pageCursor(item: AgentEventItem): number | undefined {
  return item.event.eventCursor;
}

/**
 * Older history is only reachable through a cursor. `hasMore` without a `nextCursor` (or with
 * the cursor just used) would re-request the newest/same page, so it does not count as "older".
 */
function hasOlderPage(page: AgentEventPage, usedCursor?: number): boolean {
  return page.hasMore && page.nextCursor !== undefined && page.nextCursor !== usedCursor;
}

/** Full per-session execution history, kept outside the durable chat transcript. */
export function ActivityTimeline({
  assistantAgent,
  assistantAgentId,
  hub,
  sessionId,
  cwd,
  onOpenFile,
  onOpenPlan,
  onOpenSubagent,
}: {
  assistantAgent?: AgentInfo | undefined;
  assistantAgentId?: string | undefined;
  hub: AgentEventHub;
  sessionId: string | undefined;
  cwd: string | undefined;
  onOpenFile?(path: string, line?: number): void;
  onOpenPlan?(plan: PlanRef): void;
  onOpenSubagent?(childSessionId: string): void;
}) {
  const t = useShellText();
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
  /** Bumped by Retry after the first page failed: re-runs the initial load. */
  const [reloadToken, setReloadToken] = useState(0);
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
        const previousLength = historyRef.current.length;
        const merged = prependAgentEventPage(historyRef.current, page.events);
        historyRef.current = merged;
        setEvents(merged);
        updateHistoryPage({
          snapshotCursor: page.snapshotCursor,
          ...(page.nextCursor === undefined ? {} : { beforeCursor: page.nextCursor }),
          hasOlder: hasOlderPage(page, current.beforeCursor),
          loadingOlder: false,
          error: false,
          fillStalled: merged.length === previousLength,
        });
      } catch {
        if (requestGenerationRef.current === generation) {
          updateHistoryPage({ ...historyPageRef.current, loadingOlder: false, error: true });
        }
      }
    },
    [sessionId, updateHistoryPage],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken re-runs the initial load after Retry.
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
            hasOlder: hasOlderPage(page),
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
  }, [hub, sessionId, updateHistoryPage, reloadToken]);

  useEffect(() => {
    if (
      !historyPage.hasOlder ||
      historyPage.loadingOlder ||
      historyPage.error ||
      historyPage.fillStalled
    )
      return;
    const viewport = scrollContainerRef.current;
    if (!viewport) return;
    let disposed = false;
    const fill = (): void => {
      if (
        !disposed &&
        viewport.clientHeight > 0 &&
        viewport.scrollHeight <= viewport.clientHeight + 1
      )
        void loadOlderPage();
    };
    const observer = new ResizeObserver(fill);
    observer.observe(viewport);
    for (const child of viewport.children) observer.observe(child);
    fill();
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [historyPage, loadOlderPage]);

  // To-dos are pinned above the Composer, so Activity never repeats them.
  const activityBlocks = useMemo(
    () => splitTimelinePresentation(buildVisibleTimelineBlocks(events)).activityBlocks,
    [events],
  );

  // Older page failed: retry that page. First page failed: reload from the top.
  const retry = (): void => {
    if (historyPage.hasOlder) void loadOlderPage(true);
    else setReloadToken((token) => token + 1);
  };

  // One borderless glass surface: no header, count or empty-state copy. The
  // event count stays machine-readable on the section for tests and tooling.
  return (
    <section
      aria-label={t("shell.activity")}
      className="activity-panel surface-sidebar flex min-h-0 min-w-0 flex-1 flex-col"
      data-event-count={events.length}
      data-testid="activity-timeline"
      data-ui-surface="sidebar"
    >
      <div
        className="scroll-thin min-h-0 flex-1 overflow-y-auto pt-2"
        onScroll={(event) => {
          if (event.currentTarget.scrollTop < 40) void loadOlderPage();
        }}
        ref={scrollContainerRef}
      >
        {historyPage.error ? (
          <button
            aria-label={t("shell.activity.loadFailedRetry")}
            className="mx-auto flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs text-fg-muted transition-colors duration-(--motion-duration-fast) ease-standard hover:text-fg"
            data-activity-retry=""
            disabled={historyPage.loadingOlder}
            onClick={retry}
            type="button"
          >
            <IconAlertCircle aria-hidden className="shrink-0 text-danger" size={13} stroke={1.8} />
            {t("shell.activity.retry")}
          </button>
        ) : historyPage.hasOlder ? (
          <button
            className="w-full rounded-md px-3 py-2 text-xs text-fg-muted transition-colors duration-(--motion-duration-fast) ease-standard hover:text-fg"
            disabled={historyPage.loadingOlder}
            onClick={() => void loadOlderPage()}
            type="button"
          >
            {historyPage.loadingOlder
              ? t("shell.activity.loadingEarlier")
              : t("shell.activity.loadEarlier")}
          </button>
        ) : null}
        {sessionId && activityBlocks.length > 0 ? (
          <Timeline
            assistantAgent={assistantAgent}
            assistantAgentId={assistantAgentId}
            blocks={activityBlocks}
            cwd={cwd}
            embedded
            {...(onOpenFile ? { onOpenFile } : {})}
            {...(onOpenPlan ? { onOpenPlan } : {})}
            {...(onOpenSubagent ? { onOpenSubagent } : {})}
          />
        ) : null}
      </div>
    </section>
  );
}
