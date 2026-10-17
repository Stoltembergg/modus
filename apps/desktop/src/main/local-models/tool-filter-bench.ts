import { RERANK03_MODEL } from "./manifest";
import type { ToolFilterController } from "./tool-filter-controller";

/**
 * Measurement hook (MODUS_TOOL_FILTER_BENCH=<n>, never set in normal use):
 * once the model is ready, time n main↔utility pings and n selections, and log
 * p50/p95 plus main and utility RSS. Numbers go into the PR, not the product.
 */
const quantile = (sorted: number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

const SAMPLE_DOCS = Array.from({ length: 38 }, (_, index) => ({
  name: `tool_${index}`,
  doc: `tool_${index}: Synthetic tool number ${index} that ${["searches the web", "runs a terminal command", "opens a browser tab", "writes a todo list", "reads group messages", "asks the user a question"][index % 6]}.`,
}));

const QUERIES = [
  "Fix the failing test in src/app.ts",
  "Search the web for the latest Electron release notes",
  "Open the dev server in the browser and take a screenshot",
  "Plan the refactor of the settings panel",
];

export async function runToolFilterBench(tool: ToolFilterController, n: number): Promise<void> {
  const log = (message: string) => console.info(`[local-models] bench ${message}`);
  const deadline = Date.now() + 15 * 60_000;
  while (tool.ranker.status().state !== "ready") {
    if (Date.now() > deadline) return log("model never became ready");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const host = tool.host;
  const mainBefore = process.memoryUsage().rss;
  await host.warm(SAMPLE_DOCS);
  const ping: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await host.ping();
    ping.push(performance.now() - t);
  }
  const rtt: number[] = [];
  const wall: number[] = [];
  const inProcess: number[] = [];
  let fallbacks = 0;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const reply = await host.select({
      query: QUERIES[i % QUERIES.length] ?? "",
      docs: SAMPLE_DOCS,
      k: 8,
      budgetMs: 50,
    });
    const total = performance.now() - t;
    wall.push(total);
    rtt.push(total - reply.inProcessMs);
    inProcess.push(reply.inProcessMs);
    if (reply.status !== "ok") fallbacks++;
  }
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return `p50 ${quantile(sorted, 0.5).toFixed(3)} p95 ${quantile(sorted, 0.95).toFixed(3)} max ${(sorted.at(-1) ?? 0).toFixed(3)} ms`;
  };
  const utilityRss = await host.stats();
  log(`n=${n} model=${RERANK03_MODEL.id}`);
  log(`ping round-trip: ${stats(ping)}`);
  log(`select IPC overhead (main wall - in-process): ${stats(rtt)}`);
  log(`select main wall (IPC included, what the deadline sees): ${stats(wall)}`);
  log(`select in-process: ${stats(inProcess)} (over 50 ms budget: ${fallbacks})`);
  log(
    `rss main ${Math.round(mainBefore / 1e6)} -> ${Math.round(process.memoryUsage().rss / 1e6)} MB, utility ${Math.round(utilityRss / 1e6)} MB (pid ${host.pid()})`,
  );
}
