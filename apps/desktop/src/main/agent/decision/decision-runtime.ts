import { Buffer } from "node:buffer";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { openTrustedExecutable } from "./artifact-trust.ts";

const REQUEST_BYTES = 64 * 1024;
const RESPONSE_BYTES = 16 * 1024;
const INFERENCE_MS = 5_000;
const STARTUP_MS = 60_000;
const key = z.enum(["context_sufficient", "retrieve_local_context", "insufficient_information"]);
const inputSchema = z
  .object({
    question: z.string(),
    state: z.string(),
    options: z.array(z.object({ key, description: z.string() }).strict()).length(3),
  })
  .strict();
const number = z.number().finite();
const decision = z
  .object({
    choices: z.array(key).length(3),
    choice: key,
    logits: z.array(number).length(3),
    probabilities: z.array(number.min(0).max(1)).length(3),
    confidence: number.min(0).max(1),
    temperature: z.literal(2.55),
  })
  .strict();
const base = { version: z.literal(1), generation: z.string().min(1).max(128) };
const correlated = { ...base, requestId: z.string().min(1).max(128) };
const resultSchema = z
  .object({
    ...correlated,
    type: z.literal("result"),
    decision,
    tokens: number.int().min(65).max(1024),
    durationMs: number.min(0),
    rssKiB: number.int().nonnegative().nullable(),
  })
  .strict();
const responseSchema = z.discriminatedUnion("type", [
  resultSchema,
  z
    .object({
      ...base,
      type: z.literal("ready"),
      manifestSha256: z.string(),
      device: z.literal("cpu"),
      intraOpThreads: z.literal(2),
      interOpThreads: z.literal(1),
    })
    .strict(),
  z.object({ ...correlated, type: z.literal("started") }).strict(),
  z.object({ ...correlated, type: z.literal("cancelled") }).strict(),
  z
    .object({
      ...correlated,
      type: z.literal("error"),
      code: z.enum([
        "inference_timeout",
        "observation_unavailable",
        "queue_full",
        "unknown_request",
      ]),
    })
    .strict(),
  z.object({ ...base, type: z.literal("stopped") }).strict(),
]);
export type ObservationInput = z.infer<typeof inputSchema>;
export type Observation = z.infer<typeof resultSchema>;
export type OperationalDiagnostic = {
  category: string;
  processId?: number;
  processState: string;
  manifestSha256: string;
  durationMs?: number;
  rssKiB?: number | null;
};
export type DecisionRuntimeConfig = {
  executablePath: string;
  executableSha256: string;
  manifestPath: string;
  manifestSha256: string;
  diagnostic?: (event: OperationalDiagnostic) => void;
};
type Child = ChildProcessByStdio<Writable, Readable, null>;
type Pending = {
  id: string;
  input: ObservationInput;
  resolve: (value: Observation) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
  timer?: NodeJS.Timeout;
  cancelled: boolean;
  started: boolean;
};
function failure(code: string): Error {
  return new Error(`decision_runtime:${code}`);
}
async function verifyFile(
  path: string,
  expected: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  if (
    !isAbsolute(path) ||
    !/^[a-f0-9]{64}$/u.test(expected) ||
    (await realpath(path)) !== resolve(path)
  )
    throw failure("artifact");
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw failure("artifact");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, signal ? { signal } : {})) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw failure("artifact");
}
/** Experimental owner. Construction is inert; only initialize() can spawn/load the model. */
export class DecisionRuntime {
  readonly #config: DecisionRuntimeConfig;
  #state = "idle";
  #closed = false;
  #child: Child | undefined;
  #generation = "";
  #start: Promise<void> | undefined;
  #startup:
    | { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    | undefined;
  #exit: Promise<void> | undefined;
  #close: Promise<void> | undefined;
  #buffer = Buffer.alloc(0);
  #active: Pending | undefined;
  #queue: Pending[] = [];
  constructor(config: DecisionRuntimeConfig) {
    this.#config = Object.freeze({ ...config });
  }

  initialize(): Promise<void> {
    if (this.#closed) return Promise.reject(failure("closed"));
    if (this.#start) return this.#start;
    if (this.#state === "ready") return Promise.resolve();
    if (this.#child) return Promise.reject(failure("process_alive"));
    this.#start = this.#initialize().finally(() => {
      this.#start = undefined;
    });
    return this.#start;
  }
  async #initialize(): Promise<void> {
    if (process.platform !== "linux" || process.arch !== "x64")
      throw failure("platform_unvalidated");
    this.#state = "starting";
    const startedAt = Date.now();
    let executable: FileHandle | undefined;
    const abortVerification = new AbortController();
    let verificationTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          executable = await openTrustedExecutable(this.#config, abortVerification.signal);
          if (abortVerification.signal.aborted) {
            await executable.close();
            executable = undefined;
            throw failure("startup_timeout");
          }
          await verifyFile(
            this.#config.manifestPath,
            this.#config.manifestSha256,
            REQUEST_BYTES,
            abortVerification.signal,
          );
        })(),
        new Promise<never>((_, reject) => {
          verificationTimer = setTimeout(() => {
            abortVerification.abort();
            reject(failure("startup_timeout"));
          }, STARTUP_MS);
        }),
      ]);
    } catch {
      await executable?.close().catch(() => undefined);
      this.#state = "failed";
      throw failure(abortVerification.signal.aborted ? "startup_timeout" : "artifact");
    } finally {
      if (verificationTimer) clearTimeout(verificationTimer);
    }
    if (this.#closed) {
      await executable?.close();
      throw failure("closed");
    }
    if (!executable) throw failure("artifact");
    this.#generation = randomUUID();
    this.#buffer = Buffer.alloc(0);
    let child: Child;
    try {
      child = spawn(
        "/proc/self/fd/3",
        [
          "--manifest",
          this.#config.manifestPath,
          "--manifest-sha256",
          this.#config.manifestSha256,
          "--generation",
          this.#generation,
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore", executable.fd],
          env: { LANG: "C.UTF-8", TOKENIZERS_PARALLELISM: "false" },
        },
      ) as Child;
    } catch {
      await executable.close();
      this.#state = "failed";
      throw failure("spawn");
    }
    this.#child = child;
    this.#exit = new Promise((resolveExit) => {
      child.once("close", () => {
        if (this.#child === child) {
          if (!this.#closed) this.#invalidate("crash");
          this.#child = undefined;
          this.#buffer = Buffer.alloc(0);
        }
        resolveExit();
      });
    });
    const started = new Promise<void>((resolveStart, rejectStart) => {
      const timer = setTimeout(
        () => this.#invalidate("startup_timeout"),
        Math.max(1, STARTUP_MS - (Date.now() - startedAt)),
      );
      this.#startup = { resolve: resolveStart, reject: rejectStart, timer };
    });
    child.on("error", () => {
      if (this.#child === child) this.#invalidate("spawn");
    });
    child.stdin.on("error", () => {
      if (this.#child === child) this.#invalidate("communication");
    });
    child.stdout.on("error", () => {
      if (this.#child === child) this.#invalidate("communication");
    });
    child.stdout.on("data", (data: Buffer) => {
      if (this.#child === child) this.#consume(data);
    });
    child.stdout.on("end", () => {
      if (this.#child === child && !this.#closed) this.#invalidate("communication");
    });
    try {
      await started;
    } finally {
      await executable.close();
    }
  }

  observe(raw: unknown, signal?: AbortSignal): Promise<Observation> {
    if (this.#closed || this.#state !== "ready") return Promise.reject(failure("not_ready"));
    if (signal?.aborted) return Promise.reject(failure("cancelled"));
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success || new Set(parsed.data.options.map((o) => o.key)).size !== 3)
      return Promise.reject(failure("input"));
    const input = parsed.data;
    const id = randomUUID();
    if (
      Buffer.byteLength(
        JSON.stringify(this.#envelope({ type: "observe", requestId: id, input })),
        "utf8",
      ) > REQUEST_BYTES
    )
      return Promise.reject(failure("frame"));
    if (this.#active && this.#queue.length >= 4) return Promise.reject(failure("queue_full"));
    return new Promise((resolveObservation, rejectObservation) => {
      const pending: Pending = {
        id,
        input,
        resolve: resolveObservation,
        reject: rejectObservation,
        cancelled: false,
        started: false,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        pending.abort = () => {
          pending.cancelled = true;
          pending.reject(failure("cancelled"));
          if (this.#active === pending) this.#send({ type: "cancel", requestId: id });
          else {
            this.#queue = this.#queue.filter((p) => p !== pending);
            this.#detach(pending);
          }
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.#queue.push(pending);
      this.#pump();
    });
  }
  #pump(): void {
    if (this.#active || this.#closed || this.#state !== "ready") return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#active = next;
    next.timer = setTimeout(() => this.#invalidate("inference_timeout"), INFERENCE_MS);
    this.#send({ type: "observe", requestId: next.id, input: next.input });
  }
  #envelope(value: Record<string, unknown>): Record<string, unknown> {
    return { version: 1, generation: this.#generation, ...value };
  }
  #send(value: Record<string, unknown>): void {
    const child = this.#child;
    if (!child) {
      this.#invalidate("communication");
      return;
    }
    try {
      const data = JSON.stringify(this.#envelope(value));
      if (Buffer.byteLength(data) > REQUEST_BYTES) {
        this.#invalidate("frame");
        return;
      }
      child.stdin.write(`${data}\n`, (error) => {
        if (error && this.#child === child) this.#invalidate("communication");
      });
    } catch {
      this.#invalidate("communication");
    }
  }
  #consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (this.#buffer.length + end - offset > RESPONSE_BYTES) {
        this.#invalidate("protocol_frame");
        return;
      }
      this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(offset, end)]);
      offset = end + 1;
      if (newline < 0) return;
      const line = this.#buffer;
      this.#buffer = Buffer.alloc(0);
      try {
        this.#response(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
      } catch {
        this.#invalidate("protocol");
        return;
      }
      if (this.#state === "failed") return;
    }
  }
  #response(raw: unknown): void {
    const response = responseSchema.parse(raw);
    if (response.generation !== this.#generation) throw failure("protocol_generation");
    if (this.#closed) return;
    if (response.type === "ready") {
      if (!this.#startup || response.manifestSha256 !== this.#config.manifestSha256)
        throw failure("protocol_ready");
      const start = this.#startup;
      this.#startup = undefined;
      clearTimeout(start.timer);
      this.#state = "ready";
      this.#diagnostic("ready");
      start.resolve();
      return;
    }
    if (response.type === "stopped") throw failure("protocol_stopped");
    const pending = this.#active;
    if (!pending || pending.id !== response.requestId) throw failure("protocol_request");
    if (response.type === "started") {
      if (pending.started) throw failure("protocol_started");
      pending.started = true;
      return;
    }
    if (response.type === "result") {
      const d = response.decision;
      if (
        d.choices.some((k, i) => k !== pending.input.options[i]?.key) ||
        new Set(d.choices).size !== 3
      )
        throw failure("protocol_choices");
      const max = Math.max(...d.logits);
      const exp = d.logits.map((v) => Math.exp((v - max) / d.temperature));
      const sum = exp.reduce((a, b) => a + b, 0);
      const probabilities = exp.map((v) => v / sum);
      const confidence = Math.max(
        0,
        Math.min(
          1,
          1 + probabilities.reduce((a, p) => a + p * Math.log(Math.max(p, 1e-12)), 0) / Math.log(3),
        ),
      );
      const best = d.probabilities.indexOf(Math.max(...d.probabilities));
      if (
        Math.abs(d.probabilities.reduce((a, b) => a + b, 0) - 1) > 1e-4 ||
        d.choice !== d.choices[best] ||
        probabilities.some((p, i) => Math.abs(p - (d.probabilities[i] ?? NaN)) > 1e-4) ||
        Math.abs(confidence - d.confidence) > 1e-4
      )
        throw failure("protocol_probabilities");
      this.#diagnostic(
        pending.cancelled ? "cancelled" : "completed",
        response.durationMs,
        response.rssKiB,
      );
      if (!pending.cancelled) pending.resolve(response);
    } else {
      const code = response.type === "error" ? response.code : "cancelled";
      if (!pending.cancelled) pending.reject(failure(code));
      this.#diagnostic(code);
    }
    this.#detach(pending);
    this.#active = undefined;
    this.#pump();
  }
  #detach(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
  }
  #rejectAll(code: string): void {
    for (const pending of [...(this.#active ? [this.#active] : []), ...this.#queue]) {
      this.#detach(pending);
      pending.reject(failure(code));
    }
    this.#active = undefined;
    this.#queue = [];
  }
  #invalidate(code: string): void {
    if (this.#closed || this.#state === "failed") return;
    this.#state = "failed";
    if (this.#startup) {
      clearTimeout(this.#startup.timer);
      this.#startup.reject(failure(code));
      this.#startup = undefined;
    }
    this.#rejectAll(code);
    this.#diagnostic(code);
    try {
      this.#child?.kill("SIGKILL");
    } catch {
      /* close() must still confirm exit */
    }
  }
  #diagnostic(category: string, durationMs?: number, rssKiB?: number | null): void {
    try {
      this.#config.diagnostic?.({
        category,
        ...(this.#child?.pid === undefined ? {} : { processId: this.#child.pid }),
        processState: this.#state,
        manifestSha256: this.#config.manifestSha256,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(rssKiB === undefined ? {} : { rssKiB }),
      });
    } catch {
      /* Diagnostic consumers cannot change lifecycle. */
    }
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closed = true;
    this.#state = "closed";
    if (this.#startup) {
      clearTimeout(this.#startup.timer);
      this.#startup.reject(failure("shutdown"));
      this.#startup = undefined;
    }
    this.#rejectAll("shutdown");
    this.#close = (async () => {
      await this.#start?.catch(() => undefined);
      const child = this.#child;
      const exit = this.#exit;
      if (!child || !exit) return;
      this.#send({ type: "shutdown", requestId: randomUUID() });
      child.stdin.end();
      if (await within(exit, 1000)) return;
      try {
        child.kill("SIGTERM");
      } catch {
        /* confirm close below */
      }
      if (await within(exit, 250)) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* report unconfirmed shutdown below */
      }
      if (!(await within(exit, 1000))) throw failure("shutdown_unconfirmed");
    })();
    return this.#close;
  }
}
async function within(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    exit.then(() => true),
    new Promise<false>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), milliseconds);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}
// Inert owner for future authorized host initialization; no artifact discovery or auto-load.
let owned: DecisionRuntime | undefined;
export function configureDecisionRuntime(config: DecisionRuntimeConfig): DecisionRuntime {
  if (owned) throw failure("already_configured");
  owned = new DecisionRuntime(config);
  return owned;
}
export async function shutdownDecisionRuntime(): Promise<void> {
  await owned?.close();
}
