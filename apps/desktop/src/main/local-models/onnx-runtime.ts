import { cpus } from "node:os";
import { LocalModelError } from "./errors";

/**
 * The single onnxruntime-node instance of the app. Imported lazily (dynamic
 * import) the first time a local model is actually loaded, so a session that
 * never turns a local model on never maps the native library. The RERANK-03
 * tool ranker uses it now; the future decision model reuses the same instance.
 */
export type OnnxRuntime = typeof import("onnxruntime-node");
export type OnnxSession = import("onnxruntime-node").InferenceSession;

/**
 * onnxruntime-node 1.30 ships CPU binaries for darwin arm64, win32 x64/arm64
 * and linux x64/arm64. Intel Macs have none (dropped upstream after 1.23), so
 * the local models are unavailable there and the app keeps today's behaviour.
 */
export function onnxRuntimeSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  if (platform === "darwin") return arch === "arm64";
  if (platform === "win32" || platform === "linux") return arch === "x64" || arch === "arm64";
  return false;
}

let runtime: Promise<OnnxRuntime> | null = null;

export function loadOnnxRuntime(
  importRuntime: () => Promise<OnnxRuntime> = () => import("onnxruntime-node"),
): Promise<OnnxRuntime> {
  if (!onnxRuntimeSupported()) {
    return Promise.reject(
      new LocalModelError(
        "unsupported-platform",
        `onnxruntime-node has no binary for ${process.platform}-${process.arch}`,
      ),
    );
  }
  runtime ??= importRuntime().then(
    (module) => ((module as { default?: OnnxRuntime }).default ?? module) as OnnxRuntime,
    (error: unknown) => {
      runtime = null;
      throw new LocalModelError("load-failed", "onnxruntime-node failed to load", { cause: error });
    },
  );
  return runtime;
}

/** Whether the native runtime has been imported in this process (tests: nothing loads with the flag off). */
export function onnxRuntimeLoaded(): boolean {
  return runtime !== null;
}

/** Test hook. */
export function resetOnnxRuntimeForTests(): void {
  runtime = null;
}

/** CPU threads for one session: at most 4, and leave a core to the UI on small machines. */
export function defaultIntraOpThreads(cpuCount: number = cpus().length): number {
  return Math.max(1, Math.min(4, cpuCount - 1));
}

export async function createOnnxSession(
  ort: OnnxRuntime,
  modelPath: string,
  intraOpNumThreads: number = defaultIntraOpThreads(),
): Promise<OnnxSession> {
  try {
    return await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      intraOpNumThreads,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    });
  } catch (error) {
    throw new LocalModelError("load-failed", `Unable to load ${modelPath}`, { cause: error });
  }
}
