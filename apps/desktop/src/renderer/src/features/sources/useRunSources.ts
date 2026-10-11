import { useEffect, useState } from "react";
import type { AgentEventPage, AgentEventPageOptions } from "../../../../shared/agent-events";
import {
  createRunSourceCollector,
  type RunSource,
  type RunSourceLookupSnapshot,
  type RunSourcesSnapshot,
} from "./runSources";

const EVENT_PAGE_SIZE = 256;
const MAX_ACTIVE_SOURCE_LOOKUPS = 4;
const MAX_QUEUED_SOURCE_LOOKUPS = 256;
const SOURCE_LOOKUP_CANCELLED = new Error("Run source lookup was cancelled.");
const SOURCE_LOOKUP_OVERLOADED = new Error("Run source lookup queue is full.");

type PendingRunSources = {
  promise: Promise<RunSource[]>;
  subscribers: number;
  cancelled: boolean;
  cancelQueued: () => void;
};

type SourceLookupJob = {
  started: boolean;
  cancelled: boolean;
  start: () => void;
  reject: (error: Error) => void;
};

const pendingRunSources = new Map<string, PendingRunSources>();
const sourceLookupQueue: SourceLookupJob[] = [];
let activeSourceLookups = 0;

function pumpSourceLookupQueue(): void {
  while (activeSourceLookups < MAX_ACTIVE_SOURCE_LOOKUPS && sourceLookupQueue.length > 0) {
    const job = sourceLookupQueue.shift();
    if (!job || job.cancelled) continue;
    job.start();
  }
}

function scheduleSourceLookup<T>(work: () => Promise<T>): {
  promise: Promise<T>;
  cancelQueued: () => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const job: SourceLookupJob = {
    started: false,
    cancelled: false,
    reject: rejectPromise,
    start: () => {
      job.started = true;
      activeSourceLookups++;
      void work()
        .then(resolvePromise, rejectPromise)
        .finally(() => {
          activeSourceLookups--;
          pumpSourceLookupQueue();
        });
    },
  };

  if (
    activeSourceLookups >= MAX_ACTIVE_SOURCE_LOOKUPS &&
    sourceLookupQueue.length >= MAX_QUEUED_SOURCE_LOOKUPS
  ) {
    rejectPromise(SOURCE_LOOKUP_OVERLOADED);
  } else {
    sourceLookupQueue.push(job);
    pumpSourceLookupQueue();
  }

  return {
    promise,
    cancelQueued: () => {
      if (job.started || job.cancelled) return;
      job.cancelled = true;
      const index = sourceLookupQueue.indexOf(job);
      if (index >= 0) sourceLookupQueue.splice(index, 1);
      job.reject(SOURCE_LOOKUP_CANCELLED);
      pumpSourceLookupQueue();
    },
  };
}

async function collectRunSources(
  sessionId: string,
  runId: string,
  request: PendingRunSources,
): Promise<RunSource[]> {
  const listEventPage = window.modus?.agent?.listEventPage;
  if (!listEventPage) return [];
  const collector = createRunSourceCollector(runId);
  let afterCursor = 0;
  let snapshotCursor: number | undefined;
  while (true) {
    if (request.cancelled) throw SOURCE_LOOKUP_CANCELLED;
    const options: AgentEventPageOptions = {
      direction: "forward",
      runId,
      afterCursor,
      limit: EVENT_PAGE_SIZE,
      ...(snapshotCursor === undefined ? {} : { snapshotCursor }),
    };
    const page: AgentEventPage = await listEventPage(sessionId, options);
    if (request.cancelled) throw SOURCE_LOOKUP_CANCELLED;
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
}

function subscribeRunSources(
  sessionId: string,
  runId: string,
): {
  promise: Promise<RunSource[]>;
  release: () => void;
} {
  const cacheKey = JSON.stringify([sessionId, runId]);
  let request = pendingRunSources.get(cacheKey);
  if (!request || request.cancelled) {
    const created: PendingRunSources = {
      promise: Promise.resolve([]),
      subscribers: 0,
      cancelled: false,
      cancelQueued: () => {},
    };
    const scheduled = scheduleSourceLookup(() => collectRunSources(sessionId, runId, created));
    created.promise = scheduled.promise;
    created.cancelQueued = scheduled.cancelQueued;
    request = created;
    pendingRunSources.set(cacheKey, created);
    const cleanup = () => {
      if (pendingRunSources.get(cacheKey) === created) pendingRunSources.delete(cacheKey);
    };
    void created.promise.then(cleanup, cleanup);
  }

  const subscribedRequest = request;
  subscribedRequest.subscribers++;
  let released = false;
  return {
    promise: subscribedRequest.promise,
    release: () => {
      if (released) return;
      released = true;
      subscribedRequest.subscribers--;
      if (subscribedRequest.subscribers !== 0) return;
      subscribedRequest.cancelled = true;
      if (pendingRunSources.get(cacheKey) === subscribedRequest) pendingRunSources.delete(cacheKey);
      subscribedRequest.cancelQueued();
    },
  };
}

/** Loads sources from one completed group-member run without materializing its session history. */
export function useRunSources(
  sessionId: string | undefined,
  runId: string | undefined,
  enabled: boolean,
): RunSourceLookupSnapshot {
  const requestKey = `${sessionId ?? ""}\0${runId ?? ""}\0${enabled ? "enabled" : "disabled"}`;
  const [snapshot, setSnapshot] = useState<RunSourceLookupSnapshot & { key: string }>(() => ({
    key: "",
    sources: [],
    status: "loading",
  }));
  useEffect(() => {
    let cancelled = false;
    if (!sessionId || !runId || !enabled) {
      setSnapshot({ key: requestKey, sources: [], status: "loaded" });
      return;
    }
    if (!window.modus?.agent?.listEventPage) {
      setSnapshot({ key: requestKey, sources: [], status: "unavailable" });
      return;
    }
    setSnapshot({ key: requestKey, sources: [], status: "loading" });
    const request = subscribeRunSources(sessionId, runId);
    void request.promise
      .then((sources) => {
        if (!cancelled) setSnapshot({ key: requestKey, sources, status: "loaded" });
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ key: requestKey, sources: [], status: "unavailable" });
      });
    return () => {
      cancelled = true;
      request.release();
    };
  }, [enabled, requestKey, runId, sessionId]);
  if (snapshot.key === requestKey) return snapshot;
  return {
    sources: [],
    status: enabled && sessionId && runId ? "loading" : "loaded",
  };
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
    const activeRequests = new Set<ReturnType<typeof subscribeRunSources>>();
    const releaseRequest = (request: ReturnType<typeof subscribeRunSources>) => {
      request.release();
      activeRequests.delete(request);
    };
    let nextRunIndex = 0;
    const workerCount = Math.min(MAX_ACTIVE_SOURCE_LOOKUPS, requestedRunIds.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (!cancelled) {
        const runId = requestedRunIds[nextRunIndex];
        if (runId === undefined) return;
        nextRunIndex++;
        const request = subscribeRunSources(sessionId, runId);
        activeRequests.add(request);
        try {
          const sources = await request.promise;
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
        } finally {
          releaseRequest(request);
        }
      }
    });
    void Promise.all(workers);
    return () => {
      cancelled = true;
      for (const request of activeRequests) releaseRequest(request);
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
