import { useEffect, useState } from "react";
import type { AgentEventPage, AgentEventPageOptions } from "../../../../shared/agent-events";
import { createRunSourceCollector, type RunSource, type RunSourcesSnapshot } from "./runSources";

const EVENT_PAGE_SIZE = 256;
const pendingRunSources = new Map<string, Promise<RunSource[]>>();

async function loadRunSources(sessionId: string, runId: string): Promise<RunSource[]> {
  const cacheKey = `${sessionId}\0${runId}`;
  const pending = pendingRunSources.get(cacheKey);
  if (pending) return pending;

  const listEventPage = window.modus?.agent?.listEventPage;
  if (!listEventPage) return [];
  const request = (async () => {
    const collector = createRunSourceCollector(runId);
    let afterCursor = 0;
    let snapshotCursor: number | undefined;
    while (true) {
      const options: AgentEventPageOptions = {
        direction: "forward",
        runId,
        afterCursor,
        limit: EVENT_PAGE_SIZE,
        ...(snapshotCursor === undefined ? {} : { snapshotCursor }),
      };
      const page: AgentEventPage = await listEventPage(sessionId, options);
      if (snapshotCursor !== undefined && page.snapshotCursor !== snapshotCursor) {
        throw new Error("Run event page snapshot changed during pagination.");
      }
      snapshotCursor = page.snapshotCursor;
      collector.append(page.events);
      if (!page.hasMore) break;
      if (page.nextCursor === undefined || page.nextCursor <= afterCursor) {
        throw new Error("Run event page cursor did not advance.");
      }
      afterCursor = page.nextCursor;
    }
    return collector.finish();
  })();
  pendingRunSources.set(cacheKey, request);
  try {
    return await request;
  } finally {
    pendingRunSources.delete(cacheKey);
  }
}

/** Loads sources from one completed group-member run without materializing its session history. */
export function useRunSources(
  sessionId: string | undefined,
  runId: string | undefined,
  enabled: boolean,
): RunSource[] {
  const [sources, setSources] = useState<RunSource[]>([]);
  useEffect(() => {
    let cancelled = false;
    setSources([]);
    if (!sessionId || !runId || !enabled || !window.modus?.agent?.listEventPage) return;
    void loadRunSources(sessionId, runId)
      .then((sources) => {
        if (!cancelled) setSources(sources);
      })
      .catch(() => {
        if (!cancelled) setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, runId, sessionId]);
  return sources;
}

/** Loads complete source sets for the visible main-chat runs using run-scoped pages. */
export function useRunSourcesForRuns(
  sessionId: string | undefined,
  runIds: readonly string[],
): RunSourcesSnapshot {
  const [snapshot, setSnapshot] = useState<RunSourcesSnapshot & { key: string }>(() => ({
    key: "",
    requestedRunIds: new Set(),
    loadingRunIds: new Set(),
    failedRunIds: new Set(),
    sourcesByRun: new Map(),
  }));
  const runIdsKey = JSON.stringify([...new Set(runIds)].sort());
  const requestedRunIds = new Set(JSON.parse(runIdsKey) as string[]);
  const requestKey = `${sessionId ?? ""}\0${runIdsKey}`;
  const canLoad = Boolean(sessionId && window.modus?.agent?.listEventPage);

  useEffect(() => {
    let cancelled = false;
    const requestedRunIds = JSON.parse(runIdsKey) as string[];
    const requested = new Set(requestedRunIds);
    if (requestedRunIds.length === 0) {
      setSnapshot({
        key: requestKey,
        requestedRunIds: requested,
        loadingRunIds: new Set(),
        failedRunIds: new Set(),
        sourcesByRun: new Map(),
      });
      return;
    }
    if (!sessionId || !window.modus?.agent?.listEventPage) {
      setSnapshot({
        key: requestKey,
        requestedRunIds: requested,
        loadingRunIds: new Set(),
        failedRunIds: requested,
        sourcesByRun: new Map(),
      });
      return;
    }

    setSnapshot({
      key: requestKey,
      requestedRunIds: requested,
      loadingRunIds: requested,
      failedRunIds: new Set(),
      sourcesByRun: new Map(),
    });
    void Promise.all(
      requestedRunIds.map(async (runId) => {
        try {
          const sources = await loadRunSources(sessionId, runId);
          if (cancelled) return;
          setSnapshot((previous) => {
            if (previous.key !== requestKey) return previous;
            const loadingRunIds = new Set(previous.loadingRunIds);
            loadingRunIds.delete(runId);
            const sourcesByRun = new Map(previous.sourcesByRun);
            sourcesByRun.set(runId, sources);
            return { ...previous, loadingRunIds, sourcesByRun };
          });
        } catch {
          if (cancelled) return;
          setSnapshot((previous) => {
            if (previous.key !== requestKey) return previous;
            const loadingRunIds = new Set(previous.loadingRunIds);
            loadingRunIds.delete(runId);
            const failedRunIds = new Set(previous.failedRunIds);
            failedRunIds.add(runId);
            return { ...previous, loadingRunIds, failedRunIds };
          });
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [requestKey, runIdsKey, sessionId]);

  if (snapshot.key === requestKey) return snapshot;
  return {
    requestedRunIds,
    loadingRunIds: canLoad ? requestedRunIds : new Set(),
    failedRunIds: canLoad ? new Set() : requestedRunIds,
    sourcesByRun: new Map(),
  };
}
