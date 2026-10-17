import { utilityProcess } from "electron";
import { LocalModelError } from "./errors";
import type { MainToWorker, SelectReply, WorkerDoc, WorkerToMain } from "./worker-protocol";

/**
 * Main-side owner of the tool-filter model process. The model never runs in
 * main: this host spawns an Electron utilityProcess (tool-filter-worker.ts) when
 * the filter is used, kills it after `idleMs` without requests, and kills it
 * when a request goes unanswered for `hangMs` (a hung or wedged process). A
 * crash or OOM kill only ends that process: pending requests reject, the caller
 * falls back to all tools, and the next use spawns a fresh process.
 */
export type ModelProcess = {
  readonly pid?: number | undefined;
  postMessage(message: MainToWorker): void;
  onMessage(handler: (message: WorkerToMain) => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
};

export type HostExitReason = "crashed" | "hung" | "idle" | "released";

export type ToolFilterHostOptions = {
  spawn: () => ModelProcess;
  /** Kill the process after this long without a request (default 10 minutes). */
  idleMs?: number;
  /** A select/warm/ping/stats reply later than this means the process is hung (default 5 s). */
  hangMs?: number;
  /** Loading 390 MB of weights can take a while on a slow disk (default 3 minutes). */
  loadTimeoutMs?: number;
  probeTimeoutMs?: number;
  onExit?: (reason: HostExitReason, code: number | null) => void;
};

export const TOOL_FILTER_IDLE_MS = 10 * 60_000;

type Pending = {
  resolve(message: WorkerToMain): void;
  reject(error: LocalModelError): void;
  timer: ReturnType<typeof setTimeout>;
  kind: MainToWorker["type"];
};

type Request = MainToWorker extends infer M
  ? M extends { id: number }
    ? Omit<M, "id">
    : never
  : never;

export class ToolFilterHost {
  private process: ModelProcess | null = null;
  private loaded = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private expectedExit: HostExitReason | null = null;
  private selecting = 0;
  private readonly idleMs: number;
  private readonly hangMs: number;
  private readonly loadTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  /** Spawns since start (tests and the status report). */
  spawnCount = 0;

  constructor(private readonly options: ToolFilterHostOptions) {
    this.idleMs = options.idleMs ?? TOOL_FILTER_IDLE_MS;
    this.hangMs = options.hangMs ?? 5_000;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 180_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 30_000;
  }

  /** A process is up and has the model loaded. */
  running(): boolean {
    return this.process !== null && this.loaded;
  }

  /** A selection is in flight in the model process. */
  busy(): boolean {
    return this.selecting > 0;
  }

  pid(): number | undefined {
    return this.process?.pid;
  }

  /** Real availability probe: load onnxruntime-node in the model process and run a tiny graph. */
  async probe(): Promise<void> {
    await this.request({ type: "probe" }, this.probeTimeoutMs, true);
  }

  async load(dir: string): Promise<{ rssBytes: number; loadMs: number }> {
    const reply = await this.request({ type: "load", dir }, this.loadTimeoutMs, true);
    this.loaded = true;
    return reply.type === "ok"
      ? { rssBytes: reply.rssBytes, loadMs: reply.loadMs ?? 0 }
      : { rssBytes: 0, loadMs: 0 };
  }

  async warm(docs: WorkerDoc[]): Promise<void> {
    this.requireLoaded();
    // Embedding ~40 docs takes far longer than one selection: no hang limit below the load one.
    await this.request({ type: "warm", docs }, this.loadTimeoutMs, false);
  }

  async select(input: {
    query: string;
    docs: WorkerDoc[];
    k: number;
    budgetMs: number;
  }): Promise<SelectReply & { rssBytes: number }> {
    this.requireLoaded();
    this.selecting++;
    try {
      const reply = await this.request({ type: "select", ...input }, this.hangMs, false);
      if (reply.type !== "select")
        throw new LocalModelError("inference-failed", "Unexpected reply");
      const { type: _type, id: _id, ...rest } = reply;
      return rest;
    } finally {
      this.selecting--;
    }
  }

  async ping(): Promise<void> {
    await this.request({ type: "ping" }, this.hangMs, true);
  }

  async stats(): Promise<number> {
    const reply = await this.request({ type: "stats" }, this.hangMs, false);
    return reply.type === "ok" ? reply.rssBytes : 0;
  }

  /** Stop the process (filter turned off, app quitting). */
  release(): void {
    this.stop("released");
  }

  private requireLoaded(): void {
    if (!this.running()) throw new LocalModelError("not-ready", "The model process is not running");
  }

  private ensureProcess(): ModelProcess {
    if (this.process) return this.process;
    const child = this.options.spawn();
    this.spawnCount++;
    this.process = child;
    this.loaded = false;
    child.onMessage((message) => {
      if (this.process !== child) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === "error") {
        pending.reject(new LocalModelError(message.code, message.message));
      } else {
        pending.resolve(message);
      }
    });
    child.onExit((code) => {
      if (this.process !== child) return;
      const reason = this.expectedExit ?? "crashed";
      this.expectedExit = null;
      this.process = null;
      this.loaded = false;
      this.clearIdle();
      this.rejectAll(
        new LocalModelError(
          reason === "hung" ? "hung" : "crashed",
          reason === "crashed"
            ? `The model process exited unexpectedly (code ${code})`
            : `The model process was stopped (${reason})`,
        ),
      );
      this.options.onExit?.(reason, code);
    });
    return child;
  }

  private request(body: Request, timeoutMs: number, spawnIfNeeded: boolean): Promise<WorkerToMain> {
    const child = spawnIfNeeded ? this.ensureProcess() : this.process;
    if (!child) {
      return Promise.reject(new LocalModelError("not-ready", "The model process is not running"));
    }
    this.touch();
    const id = this.nextId++;
    return new Promise<WorkerToMain>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        // No answer in time: the process is hung. Only this process dies.
        this.stop("hung");
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, kind: body.type });
      try {
        child.postMessage({ ...body, id } as MainToWorker);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new LocalModelError("crashed", "Could not reach the model process", { cause: error }),
        );
      }
    });
  }

  private stop(reason: HostExitReason): void {
    const child = this.process;
    if (!child) return;
    this.expectedExit = reason;
    this.process = null;
    this.loaded = false;
    this.clearIdle();
    this.rejectAll(
      new LocalModelError(
        reason === "hung" ? "hung" : "crashed",
        `The model process was stopped (${reason})`,
      ),
    );
    try {
      child.kill();
    } catch {
      // already gone
    }
    this.options.onExit?.(reason, null);
    this.expectedExit = null;
  }

  private rejectAll(error: LocalModelError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private touch(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size > 0) {
        this.touch();
        return;
      }
      this.stop("idle");
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/** Electron utilityProcess running the bundled worker (out/main/tool-filter-worker.js). */
export function spawnUtilityModelProcess(modulePath: string): ModelProcess {
  const child = utilityProcess.fork(modulePath, [], {
    serviceName: "Modus Tool Filter",
    stdio: "inherit",
    env: { ...process.env, MODUS_TOOL_FILTER_WORKER: "1" },
  });
  return {
    get pid() {
      return child.pid;
    },
    postMessage: (message) => child.postMessage(message),
    onMessage: (handler) => child.on("message", (message) => handler(message as WorkerToMain)),
    onExit: (handler) => child.on("exit", (code) => handler(code)),
    kill: () => {
      const pid = child.pid;
      child.kill();
      // A wedged native call may ignore SIGTERM: make sure it is gone.
      if (pid !== undefined && process.platform !== "win32") {
        setTimeout(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already exited
          }
        }, 2_000).unref();
      }
    },
  };
}
