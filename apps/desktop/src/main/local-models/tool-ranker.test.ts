import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalModelError } from "./errors";
import { manifestBytes } from "./manifest";
import {
  createLocalToolRanker,
  type EnsureFiles,
  type LocalToolRankerDeps,
  type RankerBackend,
  TOOL_SELECTION_DEADLINE_MS,
  TOOL_SELECTION_TIMEOUT_MS,
} from "./tool-ranker";
import type { SelectReply } from "./worker-protocol";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const TOOLS = [
  { name: "read", doc: "read: Read a file." },
  { name: "web_search", doc: "web_search: Search the web." },
  { name: "terminal_run", doc: "terminal_run: Run a shell command." },
  { name: "browser_open", doc: "browser_open: Open a web page." },
];
const ALL = TOOLS.map((tool) => tool.name);

type Reply = SelectReply & { rssBytes: number };

function fakeBackend(overrides: Partial<RankerBackend> = {}) {
  let running = false;
  let selecting = 0;
  const backend = {
    running: vi.fn(() => running),
    busy: vi.fn(() => selecting > 0),
    load: vi.fn(async () => {
      running = true;
      return { rssBytes: 700e6, loadMs: 2000 };
    }),
    warm: vi.fn(async () => undefined),
    select: vi.fn(async (): Promise<Reply> => {
      selecting++;
      try {
        return { status: "ok", names: ["web_search"], inProcessMs: 4, rssBytes: 700e6 };
      } finally {
        selecting--;
      }
    }),
    release: vi.fn(() => {
      running = false;
    }),
    ...overrides,
    /** Test helpers. */
    die: () => {
      running = false;
    },
  };
  return backend;
}

function ranker(overrides: Partial<LocalToolRankerDeps> = {}) {
  const backend = (overrides.backend as ReturnType<typeof fakeBackend>) ?? fakeBackend();
  const ensureFiles = vi.fn<EnsureFiles>(async () => undefined);
  const deps: LocalToolRankerDeps = {
    isEnabled: () => true,
    dir: "/tmp/modus-models-test",
    baseUrl: "http://127.0.0.1:9/",
    ensureFiles,
    log: () => undefined,
    ...overrides,
    backend,
  };
  return { ranker: createLocalToolRanker(deps), backend, ensureFiles: deps.ensureFiles };
}

const select = (r: ReturnType<typeof createLocalToolRanker>) =>
  r.select({ query: "search the web", tools: TOOLS, k: 1, core: ["read"] });

describe("local tool ranker (main orchestrator)", () => {
  it("defaults: 50 ms in the model process; the main deadline adds IPC headroom", () => {
    expect(TOOL_SELECTION_TIMEOUT_MS).toBe(50);
    expect(TOOL_SELECTION_DEADLINE_MS).toBeGreaterThan(TOOL_SELECTION_TIMEOUT_MS);
  });

  it("off: never downloads, loads, or filters", async () => {
    const { ranker: r, backend, ensureFiles } = ranker({ isEnabled: () => false });
    await r.prepare();
    expect(ensureFiles).not.toHaveBeenCalled();
    expect(backend.load).not.toHaveBeenCalled();
    expect(await select(r)).toMatchObject({ tools: ALL, filtered: false, fallback: "disabled" });
  });

  it("before ready: all tools, and the first call starts preparing", async () => {
    const { ranker: r, backend } = ranker();
    expect(await select(r)).toMatchObject({ tools: ALL, filtered: false, fallback: "not-ready" });
    await r.prepare();
    expect(backend.load).toHaveBeenCalledTimes(1);
    expect(r.status()).toMatchObject({ state: "ready", loadMs: 2000 });
  });

  it("ready: core + top-k in input order, reports main and in-process time apart", async () => {
    const { ranker: r, backend } = ranker();
    await r.prepare();
    const result = await select(r);
    expect(result).toMatchObject({ tools: ["read", "web_search"], filtered: true, inProcessMs: 4 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(backend.select).toHaveBeenCalledWith(
      expect.objectContaining({ k: 1, budgetMs: 50, docs: TOOLS.slice(1) }),
    );
  });

  it("the model process missing its in-process budget falls back", async () => {
    const backend = fakeBackend({
      select: vi.fn(async () => ({ status: "timeout" as const, inProcessMs: 61, rssBytes: 1 })),
    });
    const { ranker: r } = ranker({ backend });
    await r.prepare();
    expect(await select(r)).toMatchObject({ tools: ALL, fallback: "timeout", inProcessMs: 61 });
  });

  it("a model process error falls back with its code", async () => {
    const backend = fakeBackend({
      select: vi.fn(async () => {
        throw new LocalModelError("crashed", "gone");
      }),
    });
    const { ranker: r } = ranker({ backend });
    await r.prepare();
    expect(await select(r)).toMatchObject({ tools: ALL, filtered: false, fallback: "crashed" });
  });

  describe("Debbie 3: the deadline is measured in main and includes IPC", () => {
    it("a slow/hung model process never holds the turn past deadlineMs", async () => {
      const backend = fakeBackend({ select: vi.fn(() => new Promise<Reply>(() => undefined)) });
      const { ranker: r } = ranker({ backend, deadlineMs: 30 });
      await r.prepare();
      const started = performance.now();
      const result = await select(r);
      const waited = performance.now() - started;
      expect(result).toMatchObject({ tools: ALL, filtered: false, fallback: "timeout" });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(25);
      expect(waited).toBeLessThan(500);
    });

    it("an in-budget model answer that arrives late in main (IPC) still falls back", async () => {
      let clock = 0;
      const backend = fakeBackend({
        select: vi.fn(async () => {
          clock += 80; // 80 ms of main wall time, e.g. a congested IPC channel
          return { status: "ok" as const, names: ["web_search"], inProcessMs: 3, rssBytes: 1 };
        }),
      });
      const { ranker: r } = ranker({ backend, deadlineMs: 75, now: () => clock });
      await r.prepare();
      expect(await select(r)).toMatchObject({
        tools: ALL,
        fallback: "timeout",
        elapsedMs: 80,
        inProcessMs: 3,
      });
    });
  });

  describe("Debbie 2: no overlapping selections", () => {
    it("while one selection runs in the model process, the next falls back at once without starting another", async () => {
      let release: (reply: Reply) => void = () => undefined;
      const backend = fakeBackend({
        select: vi.fn(
          () =>
            new Promise<Reply>((resolve) => {
              release = resolve;
            }),
        ),
      });
      const { ranker: r } = ranker({ backend, deadlineMs: 20 });
      await r.prepare();
      // First one misses the main deadline but keeps running in the model process.
      expect(await select(r)).toMatchObject({ fallback: "timeout" });
      expect(await select(r)).toMatchObject({ tools: ALL, filtered: false, fallback: "busy" });
      expect(await select(r)).toMatchObject({ fallback: "busy" });
      expect(backend.select).toHaveBeenCalledTimes(1);
      release({ status: "ok", names: ["web_search"], inProcessMs: 5, rssBytes: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      vi.mocked(backend.select).mockResolvedValueOnce({
        status: "ok",
        names: ["web_search"],
        inProcessMs: 5,
        rssBytes: 1,
      });
      expect(await select(r)).toMatchObject({ filtered: true });
      expect(backend.select).toHaveBeenCalledTimes(2);
    });

    it("a selection the host still counts as running (backend.busy) also falls back", async () => {
      const backend = fakeBackend({ busy: vi.fn(() => true) });
      const { ranker: r } = ranker({ backend });
      await r.prepare();
      expect(await select(r)).toMatchObject({ fallback: "busy" });
      expect(backend.select).not.toHaveBeenCalled();
    });
  });

  describe("Debbie 1: failed recovers, hash-mismatch stays terminal", () => {
    it("download-failed (app opened offline) retries with backoff until it succeeds", async () => {
      vi.useFakeTimers();
      let clock = 0;
      const ensureFiles = vi
        .fn<EnsureFiles>()
        .mockRejectedValueOnce(new LocalModelError("download-failed", "offline"))
        .mockRejectedValueOnce(new LocalModelError("download-failed", "offline"))
        .mockResolvedValue(undefined);
      const { ranker: r, backend } = ranker({
        ensureFiles,
        retryDelaysMs: [1000, 5000],
        now: () => clock,
      });
      await r.prepare();
      expect(r.status()).toMatchObject({
        state: "failed",
        failure: "download-failed",
        retryAt: 1000,
      });
      // A turn during backoff: all tools, no extra attempt before retryAt.
      expect(await select(r)).toMatchObject({ fallback: "download-failed" });
      expect(ensureFiles).toHaveBeenCalledTimes(1);
      clock = 1000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(ensureFiles).toHaveBeenCalledTimes(2);
      expect(r.status()).toMatchObject({ state: "failed", retryAt: 6000 });
      clock = 6000;
      await vi.advanceTimersByTimeAsync(5000);
      expect(ensureFiles).toHaveBeenCalledTimes(3);
      expect(r.status()).toMatchObject({ state: "ready" });
      expect(backend.load).toHaveBeenCalledTimes(1);
    });

    it("load-failed also retries", async () => {
      vi.useFakeTimers();
      let clock = 0;
      const backend = fakeBackend();
      vi.mocked(backend.load).mockRejectedValueOnce(new LocalModelError("load-failed", "bad"));
      const { ranker: r } = ranker({ backend, retryDelaysMs: [100], now: () => clock });
      await r.prepare();
      expect(r.status()).toMatchObject({ state: "failed", failure: "load-failed", retryAt: 100 });
      clock = 100;
      await vi.advanceTimersByTimeAsync(100);
      expect(r.status()).toMatchObject({ state: "ready" });
    });

    it("hash-mismatch is terminal: no timer, no retry from turns, until the user turns it on again", async () => {
      vi.useFakeTimers();
      let clock = 0;
      const ensureFiles = vi
        .fn<EnsureFiles>()
        .mockRejectedValueOnce(new LocalModelError("hash-mismatch", "sha256 differs"))
        .mockResolvedValue(undefined);
      const { ranker: r } = ranker({ ensureFiles, retryDelaysMs: [10], now: () => clock });
      await r.prepare();
      expect(r.status()).toEqual({
        state: "failed",
        failure: "hash-mismatch",
        message: "sha256 differs",
      });
      clock = 3_600_000;
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(await select(r)).toMatchObject({ fallback: "hash-mismatch" });
      await r.prepare();
      expect(ensureFiles).toHaveBeenCalledTimes(1);
      r.reset();
      await r.prepare();
      expect(ensureFiles).toHaveBeenCalledTimes(2);
      expect(r.status()).toMatchObject({ state: "ready" });
    });
  });

  it("verifies the 390 MB once: a respawn after an idle shutdown reloads without re-hashing", async () => {
    const { ranker: r, backend, ensureFiles } = ranker();
    await r.prepare();
    backend.die();
    r.onBackendExit("idle");
    expect(r.status()).toEqual({ state: "stopped" });
    expect(await select(r)).toMatchObject({ fallback: "not-ready" });
    await r.prepare();
    expect(ensureFiles).toHaveBeenCalledTimes(1);
    expect(backend.load).toHaveBeenCalledTimes(2);
    expect(await select(r)).toMatchObject({ filtered: true });
  });

  it("crash/hang: respawn on the next use; three inside the window back off", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const { ranker: r, backend } = ranker({ retryDelaysMs: [1000], now: () => clock });
    await r.prepare();
    for (const reason of ["crashed", "hung"] as const) {
      backend.die();
      r.onBackendExit(reason);
      expect(r.status()).toEqual({ state: "stopped" });
      await r.prepare();
      expect(r.status()).toMatchObject({ state: "ready" });
    }
    backend.die();
    r.onBackendExit("crashed");
    expect(r.status()).toMatchObject({ state: "failed", failure: "crashed", retryAt: 1000 });
    expect(await select(r)).toMatchObject({ fallback: "crashed" });
    clock = 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.status()).toMatchObject({ state: "ready" });
    expect(backend.load).toHaveBeenCalledTimes(4);
  });

  it("progress: verifying first, downloading once bytes move; cancel keeps the partial and returns to idle", async () => {
    const states: string[] = [];
    let seen: AbortSignal | undefined;
    const ensureFiles: EnsureFiles = (_dir, _url, { signal, onProgress }) =>
      new Promise((_resolve, reject) => {
        seen = signal;
        onProgress(1000, manifestBytes());
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    const { ranker: r, backend } = ranker({
      ensureFiles,
      onChange: (status) => states.push(status.state),
    });
    const pending = r.prepare();
    await Promise.resolve();
    expect(r.status()).toEqual({
      state: "downloading",
      receivedBytes: 1000,
      totalBytes: manifestBytes(),
    });
    r.cancel();
    await pending;
    expect(seen?.aborted).toBe(true);
    expect(r.status()).toEqual({ state: "idle" });
    expect(states).toEqual(["verifying", "downloading", "idle"]);
    expect(backend.load).not.toHaveBeenCalled();
  });

  it("warm: docs are embedded once loaded, and again after a respawn", async () => {
    const { ranker: r, backend } = ranker();
    r.warm(TOOLS);
    expect(backend.warm).not.toHaveBeenCalled();
    await r.prepare();
    expect(backend.warm).toHaveBeenCalledWith(TOOLS);
    backend.die();
    r.onBackendExit("idle");
    await r.prepare();
    expect(backend.warm).toHaveBeenCalledTimes(2);
  });

  it("release stops the model process and leaves verified files reusable", async () => {
    const { ranker: r, backend, ensureFiles } = ranker();
    await r.prepare();
    r.release();
    expect(backend.release).toHaveBeenCalled();
    expect(r.status()).toEqual({ state: "stopped" });
    await r.prepare();
    expect(ensureFiles).toHaveBeenCalledTimes(1);
  });
});
