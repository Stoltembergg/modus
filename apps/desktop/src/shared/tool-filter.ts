/**
 * Local tool filter (RERANK-03) state shared by main, preload and the Settings
 * UI. `enabled` is tool_filter.enabled, a persisted preference that is OFF by
 * default. While the filter is off, unavailable, downloading, or not ready, every
 * request carries all tools (today's behaviour).
 */
export type ToolFilterUnavailableReason =
  /** Intel Mac: onnxruntime-node has no darwin-x64 binary. */
  | "intel-mac"
  /** Windows without the Visual C++ 2015-2022 runtime (missing DLLs or a failed load probe). */
  | "vc-runtime-missing"
  /** The real load probe in the model process failed for another reason. */
  | "runtime-load-failed"
  /** Any other platform without an onnxruntime-node binary. */
  | "unsupported-platform";

export type ToolFilterAvailability =
  | { available: true }
  | { available: false; reason: ToolFilterUnavailableReason; detail?: string };

export type ToolFilterDownload =
  | { phase: "idle" }
  | { phase: "downloading"; receivedBytes: number; totalBytes: number }
  | { phase: "verifying"; totalBytes: number }
  | { phase: "ready" }
  | { phase: "failed"; error: "download-failed" | "hash-mismatch"; message: string };

/** Model process (Electron utilityProcess) state, for the status line. */
export type ToolFilterModel = "stopped" | "starting" | "ready" | "failed";

export type ToolFilterState = {
  enabled: boolean;
  availability: ToolFilterAvailability;
  download: ToolFilterDownload;
  model: ToolFilterModel;
  /** Total download size in bytes (shown in the confirmation prompt). */
  downloadBytes: number;
  /** Bytes already on disk from an earlier, cancelled download (it resumes from here). */
  partialBytes: number;
};

export const DEFAULT_TOOL_FILTER_STATE: ToolFilterState = {
  enabled: false,
  availability: { available: true },
  download: { phase: "idle" },
  model: "stopped",
  downloadBytes: 0,
  partialBytes: 0,
};

/** Preload bridge (`window.modus.toolFilter`). */
export type ToolFilterApi = {
  get(): Promise<ToolFilterState>;
  /** Turn the filter on (after the user confirmed the download) and start/resume the download. */
  enable(): Promise<ToolFilterState>;
  /** Turn the filter off. Stops the model process; downloaded files are kept. */
  disable(): Promise<ToolFilterState>;
  /** Cancel a running download: the partial file is kept and the filter turns off. */
  cancelDownload(): Promise<ToolFilterState>;
  onChange(handler: (state: ToolFilterState) => void): () => void;
};
