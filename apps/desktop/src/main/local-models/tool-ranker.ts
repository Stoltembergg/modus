import { join } from "node:path";
import { isFeatureFlagEnabled } from "../agent/harness/feature-flags";
import { cosine, type LocalEmbedder, loadLocalEmbedder } from "./embedder";
import { LocalModelError, type LocalModelFailure, localModelFailureOf } from "./errors";
import { RERANK03_MODEL, resolveLocalModelsBaseUrl } from "./manifest";
import { ensureModelFiles, verifyModelFiles } from "./model-download";
import { loadOnnxRuntime, type OnnxRuntime } from "./onnx-runtime";

/**
 * RERANK-03 local tool ranker (runtime only, PR 1). Nothing calls `select`
 * yet, and nothing is downloaded or loaded unless the tool-filter flag is on
 * (off by default). Contract for the future caller: `select` never throws and
 * never blocks on a download or a load. Every failure (flag off, unsupported
 * platform, missing model, wrong hash, load error, inference error, selection
 * slower than `timeoutMs`) returns all tools, i.e. today's behaviour.
 */
export const TOOL_SELECTION_TIMEOUT_MS = 50;

/** tool_filter.enabled: the Harness flag MODUS_LOCAL_TOOL_FILTER, false by default. */
export function localToolFilterEnabled(): boolean {
  return isFeatureFlagEnabled("MODUS_LOCAL_TOOL_FILTER");
}

export type RankableTool = { name: string; doc: string };

export type ToolSelection = {
  /** Tool names to expose: all of them on fallback, else core + top-k in the input order. */
  tools: string[];
  filtered: boolean;
  fallback?: LocalModelFailure;
  elapsedMs?: number;
};

export type ToolRankerStatus =
  | { state: "idle" }
  | { state: "preparing" }
  | { state: "ready"; rssBeforeBytes: number; rssAfterBytes: number; loadMs: number }
  | { state: "failed"; failure: LocalModelFailure; message: string };

export type LocalToolRankerDeps = {
  isEnabled: () => boolean;
  dir: string;
  baseUrl?: string;
  timeoutMs?: number;
  ensureFiles?: (dir: string, baseUrl: string) => Promise<void>;
  verifyFiles?: (dir: string) => Promise<void>;
  loadRuntime?: () => Promise<OnnxRuntime>;
  loadEmbedder?: (ort: OnnxRuntime, dir: string) => Promise<LocalEmbedder>;
  now?: () => number;
  rss?: () => number;
  log?: (message: string) => void;
};

export type LocalToolRanker = {
  /** Download (if needed), verify and load in the background. Safe to call repeatedly. */
  prepare(): Promise<ToolRankerStatus>;
  select(input: {
    query: string;
    tools: readonly RankableTool[];
    k: number;
    core?: readonly string[];
  }): Promise<ToolSelection>;
  status(): ToolRankerStatus;
  release(): Promise<void>;
};

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new LocalModelError("timeout", `Tool selection took longer than ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createLocalToolRanker(deps: LocalToolRankerDeps): LocalToolRanker {
  const baseUrl = deps.baseUrl ?? resolveLocalModelsBaseUrl();
  const timeoutMs = deps.timeoutMs ?? TOOL_SELECTION_TIMEOUT_MS;
  const ensureFiles =
    deps.ensureFiles ??
    ((dir: string, url: string) =>
      ensureModelFiles({ manifest: RERANK03_MODEL, dir, baseUrl: url }));
  const verifyFiles = deps.verifyFiles ?? ((dir: string) => verifyModelFiles(RERANK03_MODEL, dir));
  const loadRuntime = deps.loadRuntime ?? (() => loadOnnxRuntime());
  const loadEmbedder = deps.loadEmbedder ?? loadLocalEmbedder;
  const now = deps.now ?? (() => performance.now());
  const rss = deps.rss ?? (() => process.memoryUsage().rss);
  const log = deps.log ?? ((message: string) => console.info(`[local-models] ${message}`));

  let status: ToolRankerStatus = { state: "idle" };
  let preparing: Promise<ToolRankerStatus> | null = null;
  let embedder: LocalEmbedder | null = null;
  const docVectors = new Map<string, Float32Array>();

  async function load(): Promise<ToolRankerStatus> {
    status = { state: "preparing" };
    try {
      await ensureFiles(deps.dir, baseUrl);
      // Hashes are checked again right before loading, whatever ensureFiles did.
      await verifyFiles(deps.dir);
      const before = rss();
      const started = now();
      const ort = await loadRuntime();
      embedder = await loadEmbedder(ort, deps.dir);
      // One warm-up run so the first real selection is not the slow one.
      await embedder.embed("warm-up: list the files in src", RERANK03_MODEL.queryMaxLength);
      status = {
        state: "ready",
        rssBeforeBytes: before,
        rssAfterBytes: rss(),
        loadMs: Math.round(now() - started),
      };
      log(
        `rerank03 ready in ${status.loadMs} ms, rss ${Math.round(before / 1e6)} -> ${Math.round(status.rssAfterBytes / 1e6)} MB`,
      );
    } catch (error) {
      embedder = null;
      status = {
        state: "failed",
        failure: localModelFailureOf(error),
        message: error instanceof Error ? error.message : String(error),
      };
      log(`rerank03 unavailable (${status.failure}): ${status.message}`);
    }
    return status;
  }

  function prepare(): Promise<ToolRankerStatus> {
    if (!deps.isEnabled()) return Promise.resolve(status);
    if (status.state === "ready" || status.state === "failed") return Promise.resolve(status);
    preparing ??= load().finally(() => {
      preparing = null;
    });
    return preparing;
  }

  async function rank(
    model: LocalEmbedder,
    query: string,
    tools: readonly RankableTool[],
  ): Promise<{ name: string; score: number }[]> {
    for (const tool of tools) {
      if (!docVectors.has(tool.doc)) {
        docVectors.set(tool.doc, await model.embed(tool.doc, RERANK03_MODEL.docMaxLength));
      }
    }
    const queryVector = await model.embed(query, RERANK03_MODEL.queryMaxLength);
    return tools.map((tool) => ({
      name: tool.name,
      score: cosine(queryVector, docVectors.get(tool.doc) as Float32Array),
    }));
  }

  return {
    prepare,
    status: () => status,
    async select({ query, tools, k, core = [] }) {
      const all = tools.map((tool) => tool.name);
      const fallback = (reason: LocalModelFailure, elapsedMs?: number): ToolSelection => ({
        tools: all,
        filtered: false,
        fallback: reason,
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
      });
      if (!deps.isEnabled()) return fallback("disabled");
      if (status.state === "failed") return fallback(status.failure);
      const model = embedder;
      if (status.state !== "ready" || !model) {
        void prepare();
        return fallback("not-ready");
      }
      // Tool docs are embedded outside the selection budget: on a cold cache,
      // fall back now and fill the cache in the background.
      const missing = tools.filter((tool) => !docVectors.has(tool.doc));
      if (missing.length > 0) {
        void rank(model, query, missing).catch(() => undefined);
        return fallback("not-ready");
      }
      const started = now();
      try {
        const scores = await withTimeout(rank(model, query, tools), timeoutMs);
        const elapsedMs = now() - started;
        if (elapsedMs > timeoutMs) return fallback("timeout", elapsedMs);
        const keep = new Set(core);
        for (const { name } of [...scores]
          .filter(({ name }) => !keep.has(name))
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(0, k))) {
          keep.add(name);
        }
        return { tools: all.filter((name) => keep.has(name)), filtered: true, elapsedMs };
      } catch (error) {
        return fallback(localModelFailureOf(error), now() - started);
      }
    },
    async release() {
      const model = embedder;
      embedder = null;
      docVectors.clear();
      status = { state: "idle" };
      await model?.release().catch(() => undefined);
    },
  };
}

let shared: LocalToolRanker | null = null;

/** App-wide ranker, weights under `<userData>/models/rerank03-v1/`. */
export function getLocalToolRanker(userDataDir: string): LocalToolRanker {
  shared ??= createLocalToolRanker({
    isEnabled: () => localToolFilterEnabled(),
    dir: join(userDataDir, "models", RERANK03_MODEL.id),
  });
  return shared;
}
