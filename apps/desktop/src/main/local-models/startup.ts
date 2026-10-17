import { isFeatureFlagEnabled } from "../agent/harness/feature-flags";

/**
 * App startup hook for local-models/. With tool_filter.enabled off (the
 * default) this returns before importing anything: no onnxruntime-node, no
 * tokenizer, no download, no file access. With it on, the RERANK-03 weights
 * are downloaded/verified and loaded in the background; failures only mean
 * the (future) filter falls back to all tools.
 */
export function startLocalModels(
  userDataDir: string,
  enabled: () => boolean = () => isFeatureFlagEnabled("MODUS_LOCAL_TOOL_FILTER"),
  importRanker: () => Promise<typeof import("./tool-ranker")> = () => import("./tool-ranker"),
): Promise<void> | undefined {
  if (!enabled()) return undefined;
  return importRanker()
    .then(({ getLocalToolRanker }) => getLocalToolRanker(userDataDir).prepare())
    .then(() => undefined)
    .catch((error: unknown) => {
      console.warn("[local-models] startup failed; the tool filter stays off", error);
    });
}
