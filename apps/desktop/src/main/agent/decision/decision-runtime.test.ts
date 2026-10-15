import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { DecisionRuntime, type DecisionRuntimeConfig } from "./decision-runtime";

const input = {
  question: "Synthetic context?",
  state: "synthetic",
  options: [
    { key: "context_sufficient", description: "Enough" },
    { key: "retrieve_local_context", description: "Read local" },
    { key: "insufficient_information", description: "Unknown" },
  ],
};
type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  commands: Record<string, unknown>[];
};
let child: FakeChild;
let generation: string;
let config: DecisionRuntimeConfig;
let directory: string;
let runtime: DecisionRuntime;
let ready = true;
let killed = true;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function emit(value: Record<string, unknown>) {
  child.stdout.write(`${JSON.stringify({ version: 1, generation, ...value })}\n`);
}
function result(id: unknown, extra: Record<string, unknown> = {}) {
  emit({
    type: "result",
    requestId: id,
    tokens: 80,
    durationMs: 1,
    rssKiB: 100,
    decision: {
      choices: input.options.map((o) => o.key),
      logits: [1, 1, 1],
      probabilities: [1 / 3, 1 / 3, 1 / 3],
      confidence: 0,
      choice: "context_sufficient",
      temperature: 2.55,
    },
    ...extra,
  });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "thx-supervisor-"));
  config = {
    executablePath: join(directory, "runtime"),
    executableSha256: hash("binary"),
    manifestPath: join(directory, "manifest.json"),
    manifestSha256: hash("manifest"),
  };
  await writeFile(config.executablePath, "binary");
  await writeFile(config.manifestPath, "manifest");
  ready = true;
  killed = true;
  spawnMock.mockImplementation((_path: string, args: string[]) => {
    generation = args[args.indexOf("--generation") + 1] ?? "";
    child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.commands = [];
    child.stdin.on("data", (chunk: Buffer) => {
      const command = JSON.parse(chunk.toString()) as Record<string, unknown>;
      child.commands.push(command);
      if (command.type === "shutdown")
        queueMicrotask(() => {
          emit({ type: "stopped" });
          child.emit("close", 0, null);
        });
    });
    child.kill = vi.fn(() => {
      if (killed) queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    });
    queueMicrotask(() => {
      if (ready)
        emit({
          type: "ready",
          manifestSha256: config.manifestSha256,
          device: "cpu",
          intraOpThreads: 2,
          interOpThreads: 1,
        });
    });
    return child;
  });
  runtime = new DecisionRuntime(config);
});
afterEach(async () => {
  killed = true;
  await runtime.close().catch(() => undefined);
  vi.useRealTimers();
  spawnMock.mockReset();
  await rm(directory, { recursive: true, force: true });
});
it("does not start implicitly and concurrent explicit initialization is single-flight", async () => {
  await expect(runtime.observe(input)).rejects.toThrow("not_ready");
  expect(spawnMock).not.toHaveBeenCalled();
  await Promise.all([runtime.initialize(), runtime.initialize(), runtime.initialize()]);
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const p = runtime.observe(input);
  result(child.commands[0]?.requestId);
  await expect(p).resolves.toMatchObject({ tokens: 80 });
});
it("rejects a changed host-pinned executable before spawning", async () => {
  await writeFile(config.executablePath, "changed");
  await expect(runtime.initialize()).rejects.toThrow("artifact");
  expect(spawnMock).not.toHaveBeenCalled();
});
it("allows one active and four queued and advances only after completion", async () => {
  await runtime.initialize();
  const jobs = Array.from({ length: 5 }, () => runtime.observe(input));
  await expect(runtime.observe(input)).rejects.toThrow("queue_full");
  expect(child.commands).toHaveLength(1);
  for (let i = 0; i < 5; i++) {
    result(child.commands[i]?.requestId);
    await jobs[i];
  }
  expect(child.commands).toHaveLength(5);
});
it("rejects oversized requests before writing IPC", async () => {
  await runtime.initialize();
  await expect(runtime.observe({ ...input, state: "é".repeat(40000) })).rejects.toThrow("frame");
  expect(child.commands).toHaveLength(0);
});
it("cancels queued work without sending it and active work without reusing its slot early", async () => {
  await runtime.initialize();
  const a = new AbortController();
  const b = new AbortController();
  const first = runtime.observe(input, a.signal);
  const firstRejected = expect(first).rejects.toThrow("cancelled");
  const second = runtime.observe(input, b.signal);
  const secondRejected = expect(second).rejects.toThrow("cancelled");
  b.abort();
  a.abort();
  await Promise.all([firstRejected, secondRejected]);
  expect(child.commands.map((c) => c.type)).toEqual(["observe", "cancel"]);
  result(child.commands[0]?.requestId); // late completion cannot resolve a cancelled observation
  const third = runtime.observe(input);
  result(child.commands[2]?.requestId);
  await third;
});
it("times out inference at five seconds, kills the generation and never restarts automatically", async () => {
  await runtime.initialize();
  vi.useFakeTimers();
  const p = runtime.observe(input);
  const rejected = expect(p).rejects.toThrow("timeout");
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(child.kill).toHaveBeenCalled();
  await expect(runtime.observe(input)).rejects.toThrow("not_ready");
  expect(spawnMock).toHaveBeenCalledTimes(1);
});
it("rejects startup failures and startup timeout", async () => {
  ready = false;
  vi.useFakeTimers();
  const start = runtime.initialize();
  const rejected = expect(start).rejects.toThrow("startup_timeout");
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(60000);
  await rejected;
});
it("invalidates all pending work on crash", async () => {
  await runtime.initialize();
  const p = runtime.observe(input);
  const q = runtime.observe(input);
  const rejected = Promise.all([
    expect(p).rejects.toThrow("crash"),
    expect(q).rejects.toThrow("crash"),
  ]);
  child.emit("close", 1, null);
  await rejected;
});
it.each([
  "unknown",
  "duplicate",
  "generation",
  "nonfinite",
  "oversize",
  "malformed",
])("rejects %s responses without logging context", async (kind) => {
  await runtime.initialize();
  if (kind === "duplicate") {
    const first = runtime.observe(input);
    result(child.commands[0]?.requestId);
    await first;
  }
  const p = runtime.observe(input);
  const rejected = expect(p).rejects.toThrow("protocol");
  if (kind === "unknown" || kind === "duplicate")
    result(kind === "unknown" ? "missing" : child.commands[0]?.requestId);
  if (kind === "generation")
    emit({
      type: "error",
      requestId: child.commands[0]?.requestId,
      generation: "obsolete",
      code: "cancelled",
    });
  if (kind === "nonfinite") result(child.commands[0]?.requestId, { durationMs: null });
  if (kind === "oversize") child.stdout.write("x".repeat(16385));
  if (kind === "malformed") child.stdout.write("not-json\n");
  await rejected;
});
it("shutdown is idempotent, waits for exit and rejects pending observations", async () => {
  await runtime.initialize();
  const p = runtime.observe(input);
  const rejected = expect(p).rejects.toThrow("shutdown");
  await Promise.all([runtime.close(), runtime.close()]);
  await rejected;
  expect(child.commands.filter((c) => c.type === "shutdown")).toHaveLength(1);
  await expect(runtime.initialize()).rejects.toThrow("closed");
});
it("requires a new explicit initialization and ignores callbacks from an older child", async () => {
  await runtime.initialize();
  const old = child;
  const oldGeneration = generation;
  old.emit("close", 1, null);
  await runtime.initialize();
  expect(spawnMock).toHaveBeenCalledTimes(2);
  const p = runtime.observe(input);
  old.stdout.write(
    `${JSON.stringify({ version: 1, generation: oldGeneration, type: "stopped" })}\n`,
  );
  result(child.commands[0]?.requestId);
  await p;
});
it("rejects altered calibration probabilities rather than accepting plausible metadata", async () => {
  await runtime.initialize();
  const p = runtime.observe(input);
  const rejected = expect(p).rejects.toThrow("protocol");
  result(child.commands[0]?.requestId, {
    decision: {
      choices: input.options.map((o) => o.key),
      choice: "context_sufficient",
      logits: [1, 1, 1],
      probabilities: [0.9, 0.05, 0.05],
      confidence: 0.6,
      temperature: 2.55,
    },
  });
  await rejected;
});
it("reports shutdown failure if exit cannot be confirmed", async () => {
  await runtime.initialize();
  killed = false;
  child.stdin.removeAllListeners("data");
  vi.useFakeTimers();
  const closing = runtime.close();
  const rejected = expect(closing).rejects.toThrow("shutdown_unconfirmed");
  await vi.advanceTimersByTimeAsync(2250);
  await rejected;
  child.emit("close", null, "SIGKILL");
});
it("does not accept a self-reported different manifest identity", async () => {
  ready = false;
  const init = runtime.initialize();
  const rejected = expect(init).rejects.toThrow("protocol");
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
  emit({
    type: "ready",
    manifestSha256: "0".repeat(64),
    device: "cpu",
    intraOpThreads: 2,
    interOpThreads: 1,
  });
  await rejected;
});
it("handles asynchronous spawn errors without exposing their messages", async () => {
  ready = false;
  const init = runtime.initialize();
  const rejected = expect(init).rejects.toThrow("decision_runtime:spawn");
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
  child.emit("error", new Error("sensitive local path"));
  await rejected;
});
it("shutdown during verification prevents a late spawn", async () => {
  const start = runtime.initialize();
  const rejected = expect(start).rejects.toThrow("closed");
  await runtime.close();
  await rejected;
  expect(spawnMock).not.toHaveBeenCalled();
});
it("shutdown during the ready handshake settles startup and waits for exit", async () => {
  ready = false;
  const start = runtime.initialize();
  const rejected = expect(start).rejects.toThrow("shutdown");
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
  await runtime.close();
  await rejected;
  expect(child.commands.filter((c) => c.type === "shutdown")).toHaveLength(1);
});
