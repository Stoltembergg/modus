import { join } from "node:path";
import { isFeatureFlagEnabled } from "../agent/harness/feature-flags";
import { LocalModelError, type LocalModelFailure, localModelFailureOf } from "./errors";
import { manifestBytes, RERANK03_MODEL, resolveLocalModelsBaseUrl } from "./manifest";
import { ensureModelFiles } from "./model-download";
import type { SelectReply, WorkerDoc } from "./worker-protocol";

/**
 * RERANK-03 local tool ranker: the main-process orchestrator. It downloads and
 * verifies the weights (one sha256 pass per file, inside ensureModelFiles), has
 * the model process load them, and answers `select`. The model itself runs in
 * the utilityProcess behind `backend` (tool-filter-host.ts), never in main.
 *
 * `select` never throws and never waits on a download, a load or a slow model.
 * Every failure returns all tools (today's behaviour):
 * - off, unsupported, not downloaded/verified/loaded yet → all tools;
 * - a selection still running in the model process → all tools now, no second
 *   selection is started (runs never pile up);
 * - no answer within `deadlineMs`, measured in MAIN and including the IPC
 *   round-trip → all tools; the model process's own time is reported apart
 *   (`inProcessMs`, budget `inProcessBudgetMs` = the 50 ms gate);
 * - crash / hang / inference error → all tools, and the process is respawned
 *   on a later request.
 * `failed` recovers: download and load failures retry with backoff (an app
 * opened offline downloads once it is back online); a hash mismatch and an
 * unsupported platform stay terminal until the user turns the filter on again.
 */
export const TOOL_SELECTION_TIMEOUT_MS = 50;
/**
 * Main-side deadline for one selection, IPC included. The in-process budget is
 * 50 ms. Measured in the packaged Linux app (4 runs × 300 selections, 38 docs,
 * k=8): main↔utility IPC overhead per selection p50 0.42-0.45 / p95 0.75-1.0 /
 * max 3.7 ms (ping round-trip p50 0.06-0.09 / p95 0.14-0.22 ms). 25 ms on top
 * of the budget is ~6x the worst IPC overhead seen, and still bounds what a
 * slow or hung model process can add to a turn.
 */
export const TOOL_SELECTION_DEADLINE_MS = 75;
export const DOWNLOAD_RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000] as const;
/** Three crashes/hangs inside this window turn into a backoff instead of instant respawns. */
export const CRASH_WINDOW_MS = 10 * 60_000;
export const CRASHES_BEFORE_BACKOFF = 3;

/**
 * tool_filter.enabled developer override: the Harness flag MODUS_LOCAL_TOOL_FILTER
 * (off by default). It only forces the filter on, even over a user "off"; the
 * product default (ON) lives in the tool-filter.json preference store.
 */
export function localToolFilterForced(): boolean {
  return isFeatureFlagEnabled("MODUS_LOCAL_TOOL_FILTER");
}

export type RankableTool = { name: string; doc: string };

export type ToolSelection = {
  /** Tool names to expose: all of them on fallback, else core + top-k, in the input order. */
  tools: string[];
  filtered: boolean;
  fallback?: LocalModelFailure;
  /** Wall time in main, IPC included (what the deadline applies to). */
  elapsedMs?: number;
  /** Time inside the model process (the 50 ms gate). */
  inProcessMs?: number;
};

export type ToolRankerStatus =
  | { state: "idle" }
  | { state: "downloading"; receivedBytes: number; totalBytes: number }
  | { state: "verifying"; totalBytes: number }
  | { state: "loading" }
  /** Files verified, model process not running (idle shutdown or crash): loads on next use. */
  | { state: "stopped" }
  | { state: "ready"; loadMs: number; utilityRssBytes: number }
  | {
      state: "failed";
      failure: LocalModelFailure;
      message: string;
      /** Absent = terminal (hash mismatch, unsupported platform). */
      retryAt?: number;
    };

export type RankerBackend = {
  running(): boolean;
  busy(): boolean;
  load(
    dir: string,
    cacheDir?: string,
  ): Promise<{ rssBytes: number; loadMs: number; cachedDocs?: number }>;
  warm(docs: WorkerDoc[]): Promise<void>;
  select(input: {
    query: string;
    docs: WorkerDoc[];
    k: number;
    budgetMs: number;
  }): Promise<SelectReply & { rssBytes: number }>;
  release(): void;
};

export type EnsureFiles = (
  dir: string,
  baseUrl: string,
  options: {
    signal: AbortSignal;
    onProgress: (receivedBytes: number, totalBytes: number) => void;
  },
) => Promise<void>;

export type LocalToolRankerDeps = {
  isEnabled: () => boolean;
  dir: string;
  /** On-disk doc-embedding cache, read and written by the model process (embed-cache.ts). */
  cacheDir?: string;
  backend: RankerBackend;
  baseUrl?: string;
  ensureFiles?: EnsureFiles;
  inProcessBudgetMs?: number;
  deadlineMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  log?: (message: string) => void;
  onChange?: (status: ToolRankerStatus) => void;
};

export type LocalToolRanker = {
  /** Download (if needed), verify and load in the background. Safe to call repeatedly. */
  prepare(): Promise<ToolRankerStatus>;
  /** Cancel a running download (the partial file is kept, so it resumes later). */
  cancel(): void;
  select(input: {
    query: string;
    tools: readonly RankableTool[];
    k: number;
    core?: readonly string[];
  }): Promise<ToolSelection>;
  /** Embed tool docs ahead of the first selection (no-op until loaded). */
  warm(tools: readonly RankableTool[]): void;
  status(): ToolRankerStatus;
  /** The model process exited: crash/hang count towards backoff, idle just stops. */
  onBackendExit(reason: "crashed" | "hung" | "idle" | "released"): void;
  /** Stop the model process and forget the loaded state (filter turned off). */
  release(): void;
  /** The user turned the filter on again: clear a terminal failure and start over. */
  reset(): void;
};

const TERMINAL: ReadonlySet<LocalModelFailure> = new Set(["hash-mismatch", "unsupported-platform"]);

/** Default: the real downloader with progress summed over every manifest file. */
export function defaultEnsureFiles(): EnsureFiles {
  return async (dir, baseUrl, { signal, onProgress }) => {
    const total = manifestBytes();
    const done = new Map<string, number>();
    await ensureModelFiles({
      manifest: RERANK03_MODEL,
      dir,
      baseUrl,
      signal,
      onProgress: ({ file, receivedBytes }) => {
        done.set(file, receivedBytes);
        let sum = 0;
        for (const value of done.values()) sum += value;
        onProgress(sum, total);
      },
    });
  };
}

export function createLocalToolRanker(deps: LocalToolRankerDeps): LocalToolRanker {
  const baseUrl = deps.baseUrl ?? resolveLocalModelsBaseUrl();
  const ensureFiles = deps.ensureFiles ?? defaultEnsureFiles();
  const budgetMs = deps.inProcessBudgetMs ?? TOOL_SELECTION_TIMEOUT_MS;
  const deadlineMs = deps.deadlineMs ?? TOOL_SELECTION_DEADLINE_MS;
  const retryDelays = deps.retryDelaysMs ?? DOWNLOAD_RETRY_DELAYS_MS;
  const now = deps.now ?? (() => performance.now());
  const log = deps.log ?? ((message: string) => console.info(`[local-models] ${message}`));
  const backend = deps.backend;

  let status: ToolRankerStatus = { state: "idle" };
  let preparing: Promise<ToolRankerStatus> | null = null;
  let abort: AbortController | null = null;
  let filesVerified = false;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight = false;
  let crashes: number[] = [];
  let knownDocs: WorkerDoc[] = [];

  function setStatus(next: ToolRankerStatus): void {
    status = next;
    deps.onChange?.(next);
  }

  function scheduleRetry(at: number): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(
      () => {
        retryTimer = null;
        // Node timers can fire a fraction of a millisecond before `at` on the
        // performance.now() clock; the retry is due now, so don't let the
        // `now() < retryAt` gate in prepare() skip it (it would never reschedule).
        if (status.state === "failed" && status.retryAt !== undefined) {
          status = { ...status, retryAt: Math.min(status.retryAt, now()) };
        }
        void prepare();
      },
      Math.max(0, at - now()),
    );
    retryTimer.unref?.();
  }

  function fail(error: unknown): void {
    const failure = localModelFailureOf(error);
    const message = error instanceof Error ? error.message : String(error);
    if (TERMINAL.has(failure)) {
      setStatus({ state: "failed", failure, message });
    } else {
      const delay = retryDelays[Math.min(attempts, retryDelays.length - 1)] ?? 60_000;
      attempts++;
      const retryAt = now() + delay;
      setStatus({ state: "failed", failure, message, retryAt });
      scheduleRetry(retryAt);
    }
    log(`rerank03 unavailable (${failure}): ${message}`);
  }

  async function run(): Promise<ToolRankerStatus> {
    try {
      if (!filesVerified) {
        abort = new AbortController();
        const totalBytes = manifestBytes();
        // Files already on disk are only hashed ("verifying"); bytes on the wire switch to "downloading".
        setStatus({ state: "verifying", totalBytes });
        await ensureFiles(deps.dir, baseUrl, {
          signal: abort.signal,
          onProgress: (receivedBytes, total) => {
            if (status.state === "downloading" || status.state === "verifying") {
              setStatus({ state: "downloading", receivedBytes, totalBytes: total });
            }
          },
        }).catch((error: unknown) => {
          // A raw filesystem error (e.g. ENOSPC creating the folder) is a failed
          // download, retried with backoff like any other.
          if (error instanceof LocalModelError) throw error;
          throw new LocalModelError(
            "download-failed",
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        });
        abort = null;
        // ensureModelFiles hashed every file (existing or downloaded) before
        // promoting it: no second pass over the 390 MB here.
        filesVerified = true;
      }
      if (!deps.isEnabled()) {
        setStatus({ state: "idle" });
        return status;
      }
      setStatus({ state: "loading" });
      const loaded = await backend.load(deps.dir, deps.cacheDir);
      attempts = 0;
      setStatus({ state: "ready", loadMs: loaded.loadMs, utilityRssBytes: loaded.rssBytes });
      log(
        `rerank03 ready in the model process in ${loaded.loadMs} ms, utility rss ${Math.round(loaded.rssBytes / 1e6)} MB, ${loaded.cachedDocs ?? 0} doc vectors from the disk cache`,
      );
      if (knownDocs.length > 0) void backend.warm(knownDocs).catch(() => undefined);
    } catch (error) {
      abort = null;
      if (status.state === "idle") {
        // cancel() already reset the state while the download was running.
      } else if (
        (error instanceof LocalModelError && error.code === "cancelled") ||
        (error instanceof LocalModelError && error.code === "download-failed" && !deps.isEnabled())
      ) {
        setStatus({ state: "idle" });
      } else {
        fail(error);
      }
    }
    return status;
  }

  function prepare(): Promise<ToolRankerStatus> {
    if (!deps.isEnabled()) return Promise.resolve(status);
    if (preparing) return preparing;
    if (status.state === "ready" && backend.running()) return Promise.resolve(status);
    if (status.state === "failed") {
      if (status.retryAt === undefined || now() < status.retryAt) return Promise.resolve(status);
    }
    preparing = run().finally(() => {
      preparing = null;
    });
    return preparing;
  }

  function cancel(): void {
    if (abort) {
      abort.abort(new LocalModelError("cancelled", "Download cancelled"));
      abort = null;
    }
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (status.state === "downloading" || status.state === "verifying") {
      setStatus({ state: "idle" });
    } else if (status.state === "failed" && status.retryAt !== undefined) {
      setStatus({ state: "idle" });
    }
  }

  return {
    prepare,
    cancel,
    status: () => status,
    warm(tools) {
      knownDocs = tools.map(({ name, doc }) => ({ name, doc }));
      if (status.state === "ready" && backend.running()) {
        void backend.warm(knownDocs).catch(() => undefined);
      }
    },
    onBackendExit(reason) {
      if (reason === "released") return;
      if (reason === "crashed" || reason === "hung") {
        const t = now();
        crashes = [...crashes.filter((at) => t - at < CRASH_WINDOW_MS), t];
        if (crashes.length >= CRASHES_BEFORE_BACKOFF) {
          crashes = [];
          fail(new LocalModelError(reason, `The model process ${reason} repeatedly`));
          return;
        }
      }
      if (status.state === "ready" || status.state === "loading") setStatus({ state: "stopped" });
    },
    async select({ query, tools, k, core = [] }) {
      const all = tools.map((tool) => tool.name);
      const fallback = (
        reason: LocalModelFailure,
        times: { elapsedMs?: number; inProcessMs?: number } = {},
      ): ToolSelection => ({ tools: all, filtered: false, fallback: reason, ...times });
      if (!deps.isEnabled()) return fallback("disabled");
      if (status.state === "failed") {
        void prepare();
        return fallback(status.failure);
      }
      if (status.state !== "ready" || !backend.running()) {
        if (status.state === "ready") setStatus({ state: "stopped" });
        void prepare();
        return fallback("not-ready");
      }
      const keep = new Set(core);
      const pool = tools.filter((tool) => !keep.has(tool.name));
      const docs = pool.map(({ name, doc }) => ({ name, doc }));
      knownDocs = docs;
      if (inflight || backend.busy()) return fallback("busy");
      const started = now();
      inflight = true;
      const work = backend.select({ query, docs, k, budgetMs }).finally(() => {
        inflight = false;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), deadlineMs);
      });
      try {
        const reply = await Promise.race([work, deadline]);
        const elapsedMs = now() - started;
        if (reply === "deadline") {
          // The model process keeps running this one; `inflight` stays set until it
          // answers or the host kills it as hung, so nothing piles up behind it.
          work.catch(() => undefined);
          return fallback("timeout", { elapsedMs });
        }
        const times = { elapsedMs, inProcessMs: reply.inProcessMs };
        if (elapsedMs > deadlineMs) return fallback("timeout", times);
        if (reply.status !== "ok") return fallback(reply.status, times);
        for (const name of reply.names) keep.add(name);
        return { tools: all.filter((name) => keep.has(name)), filtered: true, ...times };
      } catch (error) {
        return fallback(localModelFailureOf(error), { elapsedMs: now() - started });
      } finally {
        clearTimeout(timer);
      }
    },
    reset() {
      if (status.state === "failed") {
        attempts = 0;
        filesVerified = false;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        setStatus({ state: "idle" });
      }
    },
    release() {
      cancel();
      backend.release();
      if (status.state !== "failed" || status.retryAt !== undefined) {
        setStatus(filesVerified ? { state: "stopped" } : { state: "idle" });
      }
    },
  };
}

/** Where the weights live: `<userData>/models/rerank03-v1/`. */
export function localModelDir(userDataDir: string): string {
  return join(userDataDir, "models", RERANK03_MODEL.id);
}
