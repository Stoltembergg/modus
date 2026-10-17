import { fileURLToPath } from "node:url";
import { runToolFilterBench } from "./tool-filter-bench";
import { createToolFilterController, type ToolFilterController } from "./tool-filter-controller";
import { spawnUtilityModelProcess } from "./tool-filter-host";
import { setTurnToolFilter } from "./turn-tool-filter";

/**
 * App startup for local-models/. Creating the controller only reads a small
 * JSON preference and checks the platform: no onnxruntime-node, no tokenizer,
 * no model process in main, ever. With tool_filter.enabled off (the default)
 * nothing else happens. With it on, the model process (Electron utilityProcess)
 * probes onnxruntime, then the weights are verified/downloaded and loaded there.
 */
let controller: ToolFilterController | null = null;

export function workerModulePath(): string {
  return fileURLToPath(new URL("./tool-filter-worker.js", import.meta.url));
}

export function getToolFilterController(userDataDir: string): ToolFilterController {
  if (!controller) {
    controller = createToolFilterController({
      userDataDir,
      spawn: () => spawnUtilityModelProcess(workerModulePath()),
    });
    setTurnToolFilter(controller.turnFilter);
  }
  return controller;
}

export function startLocalModels(userDataDir: string): void {
  const tool = getToolFilterController(userDataDir);
  tool.start();
  const bench = Number(process.env.MODUS_TOOL_FILTER_BENCH ?? 0);
  if (bench > 0) void runToolFilterBench(tool, bench);
}

export function stopLocalModels(): void {
  controller?.dispose();
}
