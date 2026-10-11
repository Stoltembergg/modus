import { Buffer } from "node:buffer";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { app } from "electron";
import type { PluginExecutionSupervisorRequest } from "./plugin-execution-dispatcher";

const MAX_SUPERVISOR_MESSAGE_BYTES = 256 * 1024 - 4;
// Matches MAX_PENDING_REQUESTS in plugin-execution-protocol/src/lib.rs.
const MAX_PENDING_REQUESTS = 16;
const SUPERVISOR_REQUEST_TIMEOUT_MS = 10_000;
const SUPERVISOR_START_TIMEOUT_MS = 5_000;
const SUPERVISOR_SHUTDOWN_GRACE_MS = 250;
const EXECUTABLE = "modus-plugin-execution-supervisor";
type SupervisorChild = ChildProcessByStdio<Writable, Readable, null>;

type SupervisorResponse =
  | { status: "completed"; requestId: string; result: unknown }
  | { status: "failed"; requestId: string; error: string }
  | { status: "cancelled"; requestId: string }
  | { status: "denied"; requestId: string; reason: string };

type PendingRequest = {
  resolve: (response: SupervisorResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
};

function resolveSupervisorPath(): string {
  const candidates = [
    app.isPackaged ? join(process.resourcesPath, "bin", EXECUTABLE) : undefined,
    resolve(process.cwd(), "target", "release", EXECUTABLE),
    resolve(process.cwd(), "..", "..", "target", "release", EXECUTABLE),
  ].filter((candidate): candidate is string => candidate !== undefined);
  const resolved = candidates.find((candidate) => isAbsolute(candidate) && existsSync(candidate));
  if (!resolved) {
    throw new Error(
      "Linux plugin worker supervisor is unavailable; external execution is blocked.",
    );
  }
  return resolved;
}

function parseResponse(value: string): SupervisorResponse {
  if (Buffer.byteLength(value, "utf8") > MAX_SUPERVISOR_MESSAGE_BYTES) {
    throw new Error("Linux plugin worker supervisor returned an oversized response.");
  }
  let response: unknown;
  try {
    response = JSON.parse(value);
  } catch {
    throw new Error("Linux plugin worker supervisor returned invalid JSON.");
  }
  if (
    !response ||
    typeof response !== "object" ||
    !("status" in response) ||
    !("requestId" in response) ||
    typeof response.requestId !== "string" ||
    response.requestId.length === 0
  ) {
    throw new Error("Linux plugin worker supervisor returned an uncorrelated response.");
  }
  if (
    response.status === "completed" &&
    "result" in response &&
    Object.keys(response).every((key) => ["status", "requestId", "result"].includes(key))
  ) {
    return response as SupervisorResponse;
  }
  if (
    response.status === "failed" &&
    "error" in response &&
    typeof response.error === "string" &&
    Object.keys(response).every((key) => ["status", "requestId", "error"].includes(key))
  ) {
    return response as SupervisorResponse;
  }
  if (
    response.status === "cancelled" &&
    Object.keys(response).every((key) => ["status", "requestId"].includes(key))
  ) {
    return response as SupervisorResponse;
  }
  if (
    response.status === "denied" &&
    "reason" in response &&
    typeof response.reason === "string" &&
    Object.keys(response).every((key) => ["status", "requestId", "reason"].includes(key))
  ) {
    return response as SupervisorResponse;
  }
  throw new Error("Linux plugin worker supervisor returned an invalid response shape.");
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

/**
 * Runtime-owned IPC client for the Linux supervisor. It never starts a plugin directly.
 * One process is reused until runtime shutdown or an IPC/lifecycle failure invalidates it.
 */
export class LinuxPluginWorkerSupervisor {
  #child: SupervisorChild | undefined;
  #startPromise: Promise<SupervisorChild> | undefined;
  #closePromise: Promise<void> | undefined;
  #failure: Error | undefined;
  #closed = false;
  #stdout = "";
  #pending = new Map<string, PendingRequest>();
  #sessions = new Map<string, Map<string, string>>();
  #requestIds = new Set<string>();
  #requestSlots = 0;

  async execute(
    request: PluginExecutionSupervisorRequest,
    signal?: AbortSignal,
  ): Promise<{ result: unknown }> {
    if (process.platform !== "linux") {
      throw new Error(`External plugin execution is blocked on ${process.platform}.`);
    }
    if (this.#closed) throw new Error("Linux plugin worker supervisor is shutting down.");
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Plugin execution was cancelled before supervisor IPC");
    }
    if (!request.requestId || request.requestId.length > 128) {
      throw new Error("Plugin execution request has an invalid host request ID.");
    }
    if (this.#requestIds.has(request.requestId)) {
      throw new Error("Plugin execution request ID is already active.");
    }
    if (this.#requestSlots >= MAX_PENDING_REQUESTS) {
      throw new Error("Linux plugin worker supervisor has reached its pending request limit.");
    }

    this.#requestIds.add(request.requestId);
    this.#requestSlots += 1;
    try {
      this.#registerSessionProvenance(request);
      const child = await this.#ensureStarted();
      if (signal?.aborted) {
        this.#invalidate(child, asError(signal.reason, "Plugin invocation cancelled"));
        throw asError(signal.reason, "Plugin invocation cancelled");
      }
      const envelope = JSON.stringify({ type: "invoke", request });
      if (Buffer.byteLength(envelope, "utf8") > MAX_SUPERVISOR_MESSAGE_BYTES) {
        throw new Error("Plugin execution request exceeds the bounded supervisor IPC size.");
      }

      const response = await new Promise<SupervisorResponse>((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          this.#invalidate(
            child,
            new Error("Linux plugin worker supervisor exceeded its request deadline."),
          );
        }, SUPERVISOR_REQUEST_TIMEOUT_MS);
        const pending: PendingRequest = {
          resolve: resolvePromise,
          reject: rejectPromise,
          timeout,
          ...(signal ? { signal } : {}),
        };
        if (signal) {
          pending.onAbort = () => {
            this.#invalidate(child, asError(signal.reason, "Plugin invocation cancelled"));
          };
          signal.addEventListener("abort", pending.onAbort, { once: true });
        }
        this.#pending.set(request.requestId, pending);
        try {
          child.stdin.write(`${envelope}\n`, (error) => {
            if (error) {
              this.#invalidate(
                child,
                new Error(
                  `Unable to send request to Linux plugin worker supervisor: ${error.message}`,
                ),
              );
            }
          });
        } catch (error) {
          this.#invalidate(
            child,
            new Error(`Unable to send request to Linux plugin worker supervisor: ${String(error)}`),
          );
        }
      });

      if (response.status === "completed") return { result: response.result };
      if (response.status === "failed") throw new Error(response.error);
      if (response.status === "cancelled") {
        throw new Error("Linux plugin worker supervisor cancelled the invocation.");
      }
      throw new Error(response.reason);
    } finally {
      this.#requestIds.delete(request.requestId);
      this.#requestSlots -= 1;
    }
  }

  /** Release every plugin provenance registration held for a Pi SDK session. */
  async releaseSession(sessionId: string): Promise<void> {
    this.#sessions.delete(sessionId);
    const child = this.#child;
    if (!child || this.#closed || this.#failure) return;
    const message = `${JSON.stringify({ type: "release_session", sessionId })}\n`;
    if (Buffer.byteLength(message, "utf8") > MAX_SUPERVISOR_MESSAGE_BYTES) return;
    await new Promise<void>((resolvePromise) => {
      try {
        child.stdin.write(message, (error) => {
          if (error) {
            this.#invalidate(
              child,
              new Error(`Unable to release Linux supervisor session: ${error.message}`),
            );
          }
          resolvePromise();
        });
      } catch (error) {
        this.#invalidate(
          child,
          new Error(`Unable to release Linux supervisor session: ${String(error)}`),
        );
        resolvePromise();
      }
    });
  }

  /** Idempotent app/runtime shutdown; the supervisor exits when its input reaches EOF. */
  async close(): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    this.#closed = true;
    this.#sessions.clear();
    this.#rejectPending(new Error("Linux plugin worker supervisor shut down."));
    this.#closePromise = (async () => {
      const child = this.#child;
      if (!child) {
        await this.#startPromise?.catch(() => undefined);
        return;
      }
      const closed = this.#waitForClose(child);
      child.stdin.end();
      if (await this.#withinShutdownGrace(closed)) return;
      child.kill("SIGTERM");
      if (await this.#withinShutdownGrace(closed)) return;
      child.kill("SIGKILL");
      await this.#withinShutdownGrace(closed);
    })();
    return await this.#closePromise;
  }

  #registerSessionProvenance(request: PluginExecutionSupervisorRequest): void {
    const session = this.#sessions.get(request.sessionId) ?? new Map<string, string>();
    const identity = JSON.stringify([
      request.pluginVersion,
      request.artifactSha256,
      request.artifactOrigin,
      request.trustLevel,
      request.workspaceId,
      request.generation,
    ]);
    const registered = session.get(request.pluginId);
    if (registered !== undefined && registered !== identity) {
      throw new Error("Plugin provenance changed while the supervisor session remained active.");
    }
    session.set(request.pluginId, identity);
    this.#sessions.set(request.sessionId, session);
  }

  async #ensureStarted(): Promise<SupervisorChild> {
    if (this.#closed) throw new Error("Linux plugin worker supervisor is shutting down.");
    if (this.#failure && this.#child) throw this.#failure;
    if (this.#failure && !this.#child) this.#failure = undefined;
    if (!this.#startPromise && this.#child) return this.#child;
    if (!this.#startPromise) {
      this.#startPromise = this.#start().finally(() => {
        this.#startPromise = undefined;
      });
    }
    const starting = this.#startPromise;
    const child = await starting;
    if (this.#child !== child) {
      throw this.#failure ?? new Error("Linux plugin worker supervisor exited during startup.");
    }
    return child;
  }

  async #start(): Promise<SupervisorChild> {
    const executable = resolveSupervisorPath();
    const child = spawn(executable, [], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
    });
    this.#child = child;
    this.#stdout = "";
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let started = false;
      const startupTimeout = setTimeout(() => {
        const error = new Error("Linux plugin worker supervisor startup timed out.");
        this.#invalidate(child, error);
        rejectPromise(error);
      }, SUPERVISOR_START_TIMEOUT_MS);
      child.once("spawn", () => {
        started = true;
        clearTimeout(startupTimeout);
        resolvePromise();
      });
      child.on("error", (error) => {
        const failure = new Error(`Unable to start Linux plugin supervisor: ${error.message}`);
        clearTimeout(startupTimeout);
        this.#invalidate(child, failure);
        if (!started) rejectPromise(failure);
      });
      child.stdin.on("error", (error) => {
        this.#invalidate(
          child,
          new Error(`Linux plugin supervisor input failed: ${error.message}`),
        );
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.#consumeOutput(child, chunk));
      child.stdout.on("error", (error) => {
        this.#invalidate(
          child,
          new Error(`Linux plugin supervisor output failed: ${error.message}`),
        );
      });
      child.once("close", (code, signal) => {
        clearTimeout(startupTimeout);
        const error = new Error(
          `Linux plugin worker supervisor exited with status ${code ?? signal ?? "unknown"}.`,
        );
        if (!started) rejectPromise(error);
        this.#handleClose(child, error);
      });
    });
    if (this.#child !== child) {
      throw this.#failure ?? new Error("Linux plugin worker supervisor exited during startup.");
    }
    return child;
  }

  #consumeOutput(child: SupervisorChild, chunk: string): void {
    let data = this.#stdout + chunk;
    this.#stdout = "";
    while (true) {
      const newline = data.indexOf("\n");
      if (newline < 0) break;
      const line = data.slice(0, newline).replace(/\r$/u, "");
      data = data.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_SUPERVISOR_MESSAGE_BYTES) {
        this.#invalidate(
          child,
          new Error("Linux plugin worker supervisor exceeded the response size limit."),
        );
        return;
      }
      let response: SupervisorResponse;
      try {
        response = parseResponse(line);
      } catch (error) {
        this.#invalidate(
          child,
          asError(error, "Linux plugin worker supervisor response failed validation."),
        );
        return;
      }
      const pending = this.#pending.get(response.requestId);
      if (!pending) {
        this.#invalidate(
          child,
          new Error("Linux plugin worker supervisor returned an unknown request ID."),
        );
        return;
      }
      this.#settle(response.requestId, pending, response);
    }
    if (Buffer.byteLength(data, "utf8") > MAX_SUPERVISOR_MESSAGE_BYTES) {
      this.#invalidate(
        child,
        new Error("Linux plugin worker supervisor exceeded the response size limit."),
      );
      return;
    }
    this.#stdout = data;
  }

  #settle(
    requestId: string,
    pending: PendingRequest,
    response?: SupervisorResponse,
    error?: Error,
  ): void {
    if (this.#pending.get(requestId) !== pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timeout);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    if (error) pending.reject(error);
    else if (response) pending.resolve(response);
    else pending.reject(new Error("Linux plugin worker supervisor returned no response."));
  }

  #rejectPending(error: Error): void {
    for (const [requestId, pending] of this.#pending) {
      this.#settle(requestId, pending, undefined, error);
    }
  }

  #invalidate(child: SupervisorChild, error: Error): void {
    if (this.#child !== child) return;
    this.#failure = error;
    this.#sessions.clear();
    this.#rejectPending(error);
    child.kill("SIGKILL");
  }

  #handleClose(child: SupervisorChild, error: Error): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#stdout = "";
    this.#sessions.clear();
    if (!this.#closed) {
      this.#failure ??= error;
      this.#rejectPending(this.#failure);
    }
  }

  #waitForClose(child: SupervisorChild): Promise<void> {
    return new Promise((resolvePromise) => {
      if (this.#child !== child) return resolvePromise();
      child.once("close", () => resolvePromise());
    });
  }

  async #withinShutdownGrace(closed: Promise<void>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(false), SUPERVISOR_SHUTDOWN_GRACE_MS);
      timer.unref?.();
    });
    const result = await Promise.race([closed.then(() => true as const), timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }
}
