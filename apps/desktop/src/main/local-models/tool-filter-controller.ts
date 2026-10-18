import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_TOOL_FILTER_STATE,
  type ToolFilterAvailability,
  type ToolFilterDownload,
  type ToolFilterModel,
  type ToolFilterState,
} from "../../shared/tool-filter";
import { embedCacheDir } from "./embed-cache";
import { manifestBytes, RERANK03_MODEL } from "./manifest";
import { onnxRuntimeSupported } from "./onnx-runtime";
import { type HostExitReason, type ModelProcess, ToolFilterHost } from "./tool-filter-host";
import {
  createLocalToolRanker,
  type EnsureFiles,
  type LocalToolRanker,
  localModelDir,
  localToolFilterForced,
  type RankableTool,
  type ToolRankerStatus,
  type ToolSelection,
} from "./tool-ranker";

/**
 * tool_filter.enabled and everything the Settings row shows: the persisted
 * preference (ON by default), availability on this machine, download
 * progress, and the model process state. Owns the ranker and its model host.
 */
export const TOOL_FILTER_FILE_NAME = "tool-filter.json";

/** DLLs onnxruntime.dll imports from the Visual C++ 2015-2022 runtime (dumpbin of ORT 1.30). */
export const VC_RUNTIME_DLLS = [
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_atomic_wait.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
] as const;

/**
 * `read()` is the effective preference. The filter is ON unless the user turned
 * it off: only a file with `userSet: true` and `enabled: false` reads as off.
 * A missing or unreadable file, and a legacy file without `userSet` (written
 * before the default flipped, when a failed load probe could also store
 * `false`), read as the default, ON. `write()` is only called from an explicit
 * user action (switch, cancel download) and always stores `userSet: true`.
 */
export type ToolFilterStore = { read(): boolean; write(enabled: boolean): void };

export function createToolFilterStore(userDataDir: string): ToolFilterStore {
  const filePath = join(userDataDir, TOOL_FILTER_FILE_NAME);
  return {
    read() {
      try {
        const value = JSON.parse(readFileSync(filePath, "utf8")) as {
          enabled?: unknown;
          userSet?: unknown;
        };
        if (value?.userSet !== true) return true;
        return value.enabled !== false;
      } catch {
        return true;
      }
    },
    write(enabled) {
      const tmp = `${filePath}.tmp`;
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify({ enabled, userSet: true })}\n`, "utf8");
        renameSync(tmp, filePath);
      } catch (error) {
        console.warn("[modus] Unable to persist the tool filter preference.", error);
      }
    },
  };
}

/** Cheap checks done before anything is spawned (the probe in the model process comes after). */
export function staticToolFilterAvailability({
  platform = process.platform,
  arch = process.arch,
  systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
  fileExists = existsSync,
}: {
  platform?: NodeJS.Platform;
  arch?: string;
  systemRoot?: string;
  fileExists?: (path: string) => boolean;
} = {}): ToolFilterAvailability {
  if (platform === "darwin" && arch === "x64") return { available: false, reason: "intel-mac" };
  if (!onnxRuntimeSupported(platform, arch)) {
    return { available: false, reason: "unsupported-platform" };
  }
  if (platform === "win32") {
    const missing = VC_RUNTIME_DLLS.filter((dll) => !fileExists(`${systemRoot}\\System32\\${dll}`));
    if (missing.length > 0) {
      return { available: false, reason: "vc-runtime-missing", detail: missing.join(", ") };
    }
  }
  return { available: true };
}

function downloadOf(status: ToolRankerStatus): ToolFilterDownload {
  switch (status.state) {
    case "idle":
      return { phase: "idle" };
    case "verifying":
      return { phase: "verifying", totalBytes: status.totalBytes };
    case "downloading":
      return {
        phase: "downloading",
        receivedBytes: status.receivedBytes,
        totalBytes: status.totalBytes,
      };
    case "failed":
      // A failure that retries on its own (offline, low disk space, server error)
      // stays silent: requests keep carrying all tools and the retry runs later.
      if (status.retryAt !== undefined) {
        return status.failure === "download-failed" || status.failure === "missing"
          ? { phase: "idle" }
          : { phase: "ready" };
      }
      return status.failure === "download-failed" ||
        status.failure === "hash-mismatch" ||
        status.failure === "missing"
        ? {
            phase: "failed",
            error: status.failure === "hash-mismatch" ? "hash-mismatch" : "download-failed",
            message: status.message,
          }
        : { phase: "ready" };
    default:
      return { phase: "ready" };
  }
}

function modelOf(status: ToolRankerStatus): ToolFilterModel {
  switch (status.state) {
    case "loading":
      return "starting";
    case "ready":
      return "ready";
    case "failed":
      if (status.retryAt !== undefined) return "stopped";
      return downloadOf(status).phase === "failed" ? "stopped" : "failed";
    default:
      return "stopped";
  }
}

/** Bytes already on disk (final files + `.partial`s): the download resumes from here. */
function bytesOnDisk(dir: string): number {
  let total = 0;
  for (const file of RERANK03_MODEL.files) {
    for (const name of [file.name, `${file.name}.partial`]) {
      try {
        total += statSync(join(dir, name)).size;
      } catch {
        // absent
      }
    }
  }
  return total;
}

export type TurnToolFilter = {
  /** The filter applies to this turn (on, available). Off = today's behaviour exactly. */
  enabled(): boolean;
  select(input: {
    query: string;
    tools: readonly RankableTool[];
    k: number;
    core?: readonly string[];
  }): Promise<ToolSelection>;
  warm(tools: readonly RankableTool[]): void;
};

export type ToolFilterController = {
  getState(): ToolFilterState;
  enable(): Promise<ToolFilterState>;
  disable(): Promise<ToolFilterState>;
  cancelDownload(): Promise<ToolFilterState>;
  subscribe(listener: (state: ToolFilterState) => void): () => void;
  /** App start: if the preference (or the dev flag) is on, probe + prepare in the background. */
  start(): void;
  turnFilter: TurnToolFilter;
  /** For measurements and tests. */
  host: ToolFilterHost;
  ranker: LocalToolRanker;
  dispose(): void;
};

export type ToolFilterControllerDeps = {
  userDataDir: string;
  spawn: () => ModelProcess;
  store?: ToolFilterStore;
  availability?: () => ToolFilterAvailability;
  platform?: NodeJS.Platform;
  forced?: () => boolean;
  ensureFiles?: EnsureFiles;
  idleMs?: number;
  hangMs?: number;
  deadlineMs?: number;
  retryDelaysMs?: readonly number[];
  log?: (message: string) => void;
};

export function createToolFilterController(deps: ToolFilterControllerDeps): ToolFilterController {
  const store = deps.store ?? createToolFilterStore(deps.userDataDir);
  const forced = deps.forced ?? localToolFilterForced;
  const platform = deps.platform ?? process.platform;
  const dir = localModelDir(deps.userDataDir);
  const listeners = new Set<(state: ToolFilterState) => void>();
  let enabled = store.read();
  let availability = (deps.availability ?? staticToolFilterAvailability)();
  let probed = false;

  const isOn = () => (enabled || forced()) && availability.available;

  // The ranker learns about exits from the host; the host is created first.
  let rankerRef: LocalToolRanker | null = null;
  const host = new ToolFilterHost({
    spawn: deps.spawn,
    ...(deps.idleMs === undefined ? {} : { idleMs: deps.idleMs }),
    ...(deps.hangMs === undefined ? {} : { hangMs: deps.hangMs }),
    onExit: (reason: HostExitReason, code) => {
      if (reason !== "released") {
        (deps.log ?? console.info)(`[local-models] model process exit: ${reason} (code ${code})`);
      }
      rankerRef?.onBackendExit(reason);
      emit();
    },
  });
  const ranker = createLocalToolRanker({
    isEnabled: isOn,
    dir,
    cacheDir: embedCacheDir(deps.userDataDir),
    backend: host,
    ...(deps.ensureFiles ? { ensureFiles: deps.ensureFiles } : {}),
    ...(deps.deadlineMs === undefined ? {} : { deadlineMs: deps.deadlineMs }),
    ...(deps.retryDelaysMs ? { retryDelaysMs: deps.retryDelaysMs } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    onChange: () => emit(),
  });
  rankerRef = ranker;

  function getState(): ToolFilterState {
    const status = ranker.status();
    return {
      ...DEFAULT_TOOL_FILTER_STATE,
      // Unavailable machines show the switch off: the filter is silently inactive there.
      enabled: (enabled || forced()) && availability.available,
      availability,
      download: downloadOf(status),
      model: modelOf(status),
      downloadBytes: manifestBytes(),
      partialBytes: Math.min(bytesOnDisk(dir), manifestBytes()),
    };
  }

  function emit(): void {
    const state = getState();
    for (const listener of listeners) listener(state);
  }

  /** The real load probe, once per app run: onnxruntime-node in the model process. */
  async function probe(): Promise<boolean> {
    if (probed) return true;
    try {
      await host.probe();
      probed = true;
      return true;
    } catch (error) {
      host.release();
      availability = {
        available: false,
        reason: platform === "win32" ? "vc-runtime-missing" : "runtime-load-failed",
        detail: error instanceof Error ? error.message : String(error),
      };
      (deps.log ?? console.warn)(
        `[local-models] onnxruntime probe failed: ${availability.detail ?? ""}`,
      );
      return false;
    }
  }

  async function turnOn(): Promise<void> {
    if (!(await probe())) {
      emit();
      return;
    }
    void ranker.prepare();
    emit();
  }

  return {
    host,
    ranker,
    getState,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async enable() {
      if (!availability.available) return getState();
      enabled = true;
      store.write(true);
      ranker.reset();
      emit();
      await turnOn();
      // A failed load probe is not a user choice: nothing is persisted, so the
      // next launch checks again (e.g. after the VC++ runtime is installed).
      if (!availability.available) enabled = false;
      return getState();
    },
    async disable() {
      enabled = false;
      store.write(false);
      ranker.release();
      emit();
      return getState();
    },
    async cancelDownload() {
      enabled = false;
      store.write(false);
      ranker.release();
      emit();
      return getState();
    },
    start() {
      if (isOn()) void turnOn();
    },
    turnFilter: {
      enabled: isOn,
      select: (input) => ranker.select(input),
      warm: (tools) => ranker.warm(tools),
    },
    dispose() {
      listeners.clear();
      ranker.release();
    },
  };
}
