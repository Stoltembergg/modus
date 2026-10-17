import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type HostExitReason, type ModelProcess, ToolFilterHost } from "./tool-filter-host";
import type { MainToWorker, WorkerToMain } from "./worker-protocol";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

/** In-memory model process: the test decides what it answers and when it dies. */
function fakeProcess(answer: (message: MainToWorker) => WorkerToMain | null) {
  let onMessage: (message: WorkerToMain) => void = () => undefined;
  let onExit: (code: number | null) => void = () => undefined;
  const proc = {
    pid: 4242,
    killed: false,
    posted: [] as MainToWorker[],
    postMessage(message: MainToWorker) {
      proc.posted.push(message);
      const reply = answer(message);
      if (reply) queueMicrotask(() => onMessage(reply));
    },
    onMessage(handler: (message: WorkerToMain) => void) {
      onMessage = handler;
    },
    onExit(handler: (code: number | null) => void) {
      onExit = handler;
    },
    kill: vi.fn(() => {
      proc.killed = true;
    }),
    crash(code = 134) {
      onExit(code);
    },
  };
  return proc;
}

const okAnswer = (message: MainToWorker): WorkerToMain | null => {
  switch (message.type) {
    case "ping":
      return { type: "pong", id: message.id };
    case "select":
      return {
        type: "select",
        id: message.id,
        status: "ok",
        names: ["a"],
        inProcessMs: 2,
        rssBytes: 1,
      };
    default:
      return { type: "ok", id: message.id, rssBytes: 1, loadMs: 5 };
  }
};

const docs = [{ name: "a", doc: "a: A." }];
const selectInput = { query: "q", docs, k: 1, budgetMs: 50 };

describe("ToolFilterHost (fake process)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns lazily on first use, never at construction", async () => {
    const spawn = vi.fn(() => fakeProcess(okAnswer));
    const host = new ToolFilterHost({ spawn });
    expect(spawn).not.toHaveBeenCalled();
    expect(host.running()).toBe(false);
    await host.load("/models");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(host.running()).toBe(true);
    host.release();
  });

  it("crash: pending requests reject, onExit('crashed'), the next use respawns", async () => {
    const procs: ReturnType<typeof fakeProcess>[] = [];
    const exits: HostExitReason[] = [];
    const host = new ToolFilterHost({
      spawn: () => {
        const proc = fakeProcess((message) =>
          message.type === "select" ? null : okAnswer(message),
        );
        procs.push(proc);
        return proc;
      },
      onExit: (reason) => exits.push(reason),
    });
    await host.load("/models");
    const pending = host.select(selectInput);
    expect(host.busy()).toBe(true);
    procs[0]?.crash();
    await expect(pending).rejects.toMatchObject({ code: "crashed" });
    expect(host.busy()).toBe(false);
    expect(exits).toEqual(["crashed"]);
    expect(host.running()).toBe(false);
    await expect(host.select(selectInput)).rejects.toMatchObject({ code: "not-ready" });
    await host.load("/models");
    expect(procs).toHaveLength(2);
    expect(host.spawnCount).toBe(2);
  });

  it("hang: no answer within hangMs kills only that process", async () => {
    vi.useFakeTimers();
    const exits: HostExitReason[] = [];
    const proc = fakeProcess((message) => (message.type === "select" ? null : okAnswer(message)));
    const host = new ToolFilterHost({
      spawn: () => proc,
      hangMs: 1000,
      onExit: (r) => exits.push(r),
    });
    await host.load("/models");
    const pending = host.select(selectInput);
    const settled = expect(pending).rejects.toMatchObject({ code: "hung" });
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(exits).toEqual(["hung"]);
    expect(host.running()).toBe(false);
  });

  it("idle shutdown after idleMs without requests (default 10 minutes); requests reset the timer", async () => {
    vi.useFakeTimers();
    const exits: HostExitReason[] = [];
    const proc = fakeProcess(okAnswer);
    const host = new ToolFilterHost({ spawn: () => proc, onExit: (r) => exits.push(r) });
    await host.load("/models");
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await host.select(selectInput);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(exits).toEqual(["idle"]);
    expect(host.running()).toBe(false);
  });

  it("worker errors reject with the worker's code", async () => {
    const host = new ToolFilterHost({
      spawn: () =>
        fakeProcess((message) =>
          message.type === "load"
            ? { type: "error", id: message.id, code: "hash-mismatch", message: "bad" }
            : okAnswer(message),
        ),
    });
    await expect(host.load("/models")).rejects.toMatchObject({ code: "hash-mismatch" });
    host.release();
  });
});

/**
 * The real worker bundle in a real child process (Node fork; Electron's
 * utilityProcess speaks the same protocol through process.parentPort).
 */
const appRoot = resolve(__dirname, "../../..");
const outDir = join(appRoot, "node_modules/.cache/tool-filter-worker-test");
const workerFile = join(outDir, "worker.mjs");
const children: ChildProcess[] = [];

function forkWorker(): ModelProcess {
  const child = fork(workerFile, [], {
    env: { ...process.env, MODUS_TOOL_FILTER_WORKER: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.push(child);
  return {
    pid: child.pid,
    postMessage: (message) => child.send(message),
    onMessage: (handler) => child.on("message", (message) => handler(message as WorkerToMain)),
    onExit: (handler) => child.on("exit", (code) => handler(code)),
    kill: () => child.kill("SIGKILL"),
  };
}

const alive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => boolean, ms = 5000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe.skipIf(process.platform === "win32")("ToolFilterHost (real forked worker)", () => {
  beforeAll(async () => {
    mkdirSync(outDir, { recursive: true });
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        ssr: resolve(__dirname, "tool-filter-worker.ts"),
        outDir,
        emptyOutDir: true,
        minify: false,
        rollupOptions: {
          external: ["onnxruntime-node", "@huggingface/tokenizers", "electron"],
          output: { format: "es", entryFileNames: "worker.mjs" },
        },
      },
    });
  }, 60_000);
  afterAll(() => {
    for (const child of children) child.kill("SIGKILL");
    rmSync(outDir, { recursive: true, force: true });
  });

  it("probe: loads onnxruntime-node and runs the tiny graph in the child, not in this process", async () => {
    const host = new ToolFilterHost({ spawn: forkWorker });
    await host.probe();
    expect(host.pid()).not.toBe(process.pid);
    expect(alive(host.pid())).toBe(true);
    host.release();
  }, 30_000);

  it("crash (SIGKILL, like an OOM kill) → 'crashed', and the next use respawns a new process", async () => {
    const exits: HostExitReason[] = [];
    const host = new ToolFilterHost({ spawn: forkWorker, onExit: (r) => exits.push(r) });
    await host.ping();
    const first = host.pid();
    process.kill(first as number, "SIGKILL");
    await waitFor(() => exits.length > 0);
    expect(exits).toEqual(["crashed"]);
    expect(host.pid()).toBeUndefined();
    await host.ping();
    expect(host.pid()).not.toBe(first);
    expect(alive(host.pid())).toBe(true);
    expect(host.spawnCount).toBe(2);
    host.release();
  });

  it("hang (SIGSTOP) → killed after hangMs, the caller is not held", async () => {
    const exits: HostExitReason[] = [];
    const host = new ToolFilterHost({
      spawn: forkWorker,
      hangMs: 300,
      onExit: (r) => exits.push(r),
    });
    await host.ping();
    const pid = host.pid();
    process.kill(pid as number, "SIGSTOP");
    const started = Date.now();
    await expect(host.ping()).rejects.toMatchObject({ code: "hung" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(exits).toEqual(["hung"]);
    await waitFor(() => !alive(pid));
    await host.ping();
    expect(host.pid()).not.toBe(pid);
    host.release();
  });

  it("idle shutdown kills the process; the next request respawns it", async () => {
    const exits: HostExitReason[] = [];
    const host = new ToolFilterHost({
      spawn: forkWorker,
      idleMs: 200,
      onExit: (r) => exits.push(r),
    });
    await host.ping();
    const pid = host.pid();
    await waitFor(() => exits.includes("idle"));
    await waitFor(() => !alive(pid));
    expect(host.pid()).toBeUndefined();
    await host.ping();
    expect(alive(host.pid())).toBe(true);
    expect(host.spawnCount).toBe(2);
    host.release();
  });

  const modelDir = process.env.MODUS_RERANK03_DIR;
  it.skipIf(!modelDir)(
    "real weights: load, warm and select inside the child within the 50 ms budget",
    async () => {
      const host = new ToolFilterHost({ spawn: forkWorker });
      const loaded = await host.load(modelDir as string);
      expect(loaded.rssBytes).toBeGreaterThan(100e6);
      const pool = [
        { name: "web_search", doc: "web_search: Search the web." },
        { name: "terminal_run", doc: "terminal_run: Run a command in a terminal." },
        { name: "todo_write", doc: "todo_write: Write a todo list." },
      ];
      await host.warm(pool);
      const reply = await host.select({
        query: "search the web for electron",
        docs: pool,
        k: 1,
        budgetMs: 50,
      });
      expect(reply).toMatchObject({ status: "ok", names: ["web_search"] });
      expect(reply.inProcessMs).toBeLessThan(50);
      host.release();
    },
    60_000,
  );
});
