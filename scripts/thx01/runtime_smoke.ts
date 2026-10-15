/** Development-only actual supervised CPU inference. No Python or reference inference. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, release } from "node:os";
import { performance } from "node:perf_hooks";
import {
  DecisionRuntime,
  type OperationalDiagnostic,
} from "../../apps/desktop/src/main/agent/decision/decision-runtime.ts";

const [executablePath, manifestPath, fixturesPath, referencePath, output] = process.argv.slice(2);
assert(
  executablePath && manifestPath && fixturesPath && referencePath && output,
  "binary manifest fixtures reference output required",
);
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const manifestSha256 = hash(await readFile(manifestPath));
const fixturesBytes = await readFile(fixturesPath);
assert.equal(
  hash(fixturesBytes),
  "88cae7fb314e6367cab697a677680616002788fb4eb462f9ff326ede6e8a9810",
);
const fixtures = JSON.parse(fixturesBytes.toString()).fixtures;
const reference = JSON.parse(await readFile(referencePath, "utf8"));
const diagnostics: OperationalDiagnostic[] = [];
let nativePid: number | undefined;
const configuration = {
  executablePath,
  executableSha256: hash(await readFile(executablePath)),
  manifestPath,
  manifestSha256,
  diagnostic: (event: OperationalDiagnostic) => {
    diagnostics.push(event);
    if (event.processId) nativePid = event.processId;
  },
};
let runtime = new DecisionRuntime(configuration);
const rows: Record<string, unknown>[] = [];
const input = (f: (typeof fixtures)[number]) => ({
  question: f.question,
  options: f.options,
  state: f.state,
});
const evidence: Record<string, unknown> = {
  device: "CPU",
  platform: process.platform,
  arch: process.arch,
  kernel: release(),
  cpu: cpus()[0]?.model,
  cpuCount: cpus().length,
  ortIntraThreads: 2,
  ortInterThreads: 1,
  manifestSha256,
  rows,
  diagnostics,
  explicitHarnessRestartsMs: [],
};
let started = performance.now();
let completed = false;
let sampling = false;
let sampledPeak = 0;
let sampledThreads = 0;
let sampleCount = 0;
async function sampleNative() {
  if (sampling) return;
  sampling = true;
  try {
    if (nativePid === undefined) return;
    try {
      const status = await readFile(`/proc/${nativePid}/status`, "utf8");
      if (Number(/PPid:\s+(\d+)/u.exec(status)?.[1]) !== process.pid) return;
      sampledPeak = Math.max(sampledPeak, Number(/VmHWM:\s+(\d+)/u.exec(status)?.[1] ?? 0));
      sampledThreads = Math.max(sampledThreads, Number(/Threads:\s+(\d+)/u.exec(status)?.[1] ?? 0));
      sampleCount++;
    } catch {
      /* process exited between reads */
    }
  } finally {
    sampling = false;
  }
}
const sampler = setInterval(() => {
  void sampleNative();
}, 50);
try {
  await assert.rejects(runtime.observe(input(fixtures[0])), /not_ready/);
  await Promise.all([runtime.initialize(), runtime.initialize()]);
  evidence.startupMs = performance.now() - started;
  // Real service infer, original PyTorch reference, including both 1024-token cases.
  for (const id of ["equiv-pt-01", "equiv-en-01", "equiv-pt-11", "equiv-en-11"]) {
    const fixture = fixtures.find((f: { id: string }) => f.id === id);
    const ref = reference.rows.find((r: { id: string }) => r.id === id);
    started = performance.now();
    try {
      const result = await runtime.observe(input(fixture));
      assert.equal(result.decision.choice, ref.choice);
      const logitsError = Math.max(
        ...result.decision.logits.map((v: number, i: number) => {
          const error = Math.abs(v - ref.logits[i]);
          assert(error <= 1e-4 + 1e-3 * Math.abs(ref.logits[i]));
          return error;
        }),
      );
      const probabilityError = Math.max(
        ...result.decision.probabilities.map((v: number, i: number) =>
          Math.abs(v - ref.probabilities[i]),
        ),
      );
      assert(probabilityError <= 1e-4);
      assert(Math.abs(result.decision.confidence - ref.confidence) <= 1e-4);
      rows.push({
        id,
        status: "passed",
        choice: result.decision.choice,
        tokens: result.tokens,
        logitsError,
        probabilityError,
        confidenceError: Math.abs(result.decision.confidence - ref.confidence),
        nativeMs: result.durationMs,
        wallMs: performance.now() - started,
        peakNativeRssKiB: result.rssKiB,
      });
    } catch (error) {
      if (error instanceof Error && /inference_timeout/.test(error.message)) {
        rows.push({ id, status: "unavailable_timeout_5s", wallMs: performance.now() - started });
        evidence.longInputUnavailability = true;
        // Explicit harness-only recreation AFTER confirmed shutdown, never production retry.
        await runtime.close();
        runtime = new DecisionRuntime(configuration);
        const restart = performance.now();
        await runtime.initialize();
        (evidence.explicitHarnessRestartsMs as number[]).push(performance.now() - restart);
      } else {
        throw error;
      }
    }
  }
  {
    const jobs = Array.from({ length: 5 }, () => runtime.observe(input(fixtures[0])));
    await assert.rejects(runtime.observe(input(fixtures[0])), /queue_full/);
    await Promise.all(jobs);
    evidence.oneActiveFourQueued = "passed";
    await assert.rejects(
      runtime.observe({ ...input(fixtures[0]), state: " context".repeat(2000) }),
      /observation_unavailable/,
    );
    evidence.tokenOverflowRejected = "passed";
    const a = new AbortController();
    const b = new AbortController();
    const active = runtime.observe(input(fixtures[10]), a.signal);
    const queued = runtime.observe(input(fixtures[0]), b.signal);
    const activeCancelled = assert.rejects(active, /cancelled/);
    const queuedCancelled = assert.rejects(queued, /cancelled/);
    b.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    a.abort();
    await Promise.all([activeCancelled, queuedCancelled]);
    const followup = await runtime.observe(input(fixtures[0]));
    assert.equal(followup.decision.choice, reference.rows[0].choice);
    evidence.nativeCancellationAndReuse = "passed";
  }
  completed = true;
} finally {
  clearInterval(sampler);
  evidence.nativeSampledPeakRssKiB = sampledPeak;
  evidence.nativeSampledMaxThreads = sampledThreads;
  evidence.nativeMemorySampleCount = sampleCount;
  evidence.memorySamplingLimit =
    "50ms sampling of child VmHWM, may miss final peak before forced exit; not OS enforcement";
  started = performance.now();
  await runtime.close();
  evidence.shutdownMs = performance.now() - started;
  evidence.status = !completed
    ? "failed"
    : evidence.longInputUnavailability
      ? "passed_with_5s_unavailability"
      : "passed";
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
}
console.log(
  JSON.stringify({
    status: evidence.status,
    startupMs: evidence.startupMs,
    rows,
    shutdownMs: evidence.shutdownMs,
  }),
);
