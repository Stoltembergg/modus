import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * `<userData>/logs/local-models.log`: a copy of the tool filter's log lines
 * (`[local-models] tool filter: ...`), so the filter can be measured in real use
 * without launching Modus from a terminal. stdout keeps getting every line as before.
 *
 * - Only lines that start with `[local-models] tool filter: ` are written. Other
 *   `[local-models]` lines (model process exit, onnxruntime probe, ranker
 *   unavailable) carry free-form error text that can include paths, so they stay
 *   on stdout only. Every other log (`[modus] ...`) is untouched.
 * - Each line is prefixed with an ISO 8601 UTC timestamp.
 * - Rotation: before an append would push the file past ~1 MB it is renamed to
 *   `local-models.log.1` (replacing the previous one), so at most two files exist.
 * - Writes never throw and never block a turn: lines are queued and appended
 *   asynchronously in order; any fs error drops that batch silently. The queue is
 *   capped, so a stuck disk cannot grow memory.
 */
export const LOCAL_MODELS_LOG_FILE_NAME = "local-models.log";
export const LOCAL_MODELS_LOG_MAX_BYTES = 1024 * 1024;
export const LOCAL_MODELS_LOG_MAX_PENDING = 512;
const FILE_LINE_PREFIX = "[local-models] tool filter: ";

export type LocalModelsLogFs = {
  appendFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
};

export type LocalModelsLogFile = {
  /** Queue one line (ignored unless it is a tool filter line). Never throws. */
  write(line: string): void;
  /** Resolves once every queued line has been appended or dropped. Never rejects. */
  flush(): Promise<void>;
  readonly path: string;
};

const nodeFs: LocalModelsLogFs = { appendFile, mkdir, rename, stat };

export function createLocalModelsLogFile(
  directory: string,
  options: { fs?: LocalModelsLogFs; maxBytes?: number; now?: () => Date } = {},
): LocalModelsLogFile {
  const fs = options.fs ?? nodeFs;
  const maxBytes = options.maxBytes ?? LOCAL_MODELS_LOG_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  const path = join(directory, LOCAL_MODELS_LOG_FILE_NAME);
  const rotated = `${path}.1`;
  const pending: string[] = [];
  /** Bytes in the current file; null = unknown (first write, or after an error). */
  let size: number | null = null;
  let draining: Promise<void> | null = null;

  async function appendBatch(text: string): Promise<void> {
    const bytes = Buffer.byteLength(text, "utf8");
    try {
      if (size === null) {
        await fs.mkdir(directory, { recursive: true });
        size = await fs.stat(path).then(
          (info) => info.size,
          () => 0,
        );
      }
      if (size > 0 && size + bytes > maxBytes) {
        await fs.rename(path, rotated);
        size = 0;
      }
      await fs.appendFile(path, text, "utf8");
      size += bytes;
    } catch {
      // Diagnostics only: drop the batch and re-read the size next time.
      size = null;
    }
  }

  async function drain(): Promise<void> {
    while (pending.length > 0) {
      await appendBatch(pending.splice(0).join(""));
    }
  }

  function kick(): void {
    if (draining || pending.length === 0) return;
    draining = drain()
      .catch(() => {})
      .finally(() => {
        draining = null;
        kick();
      });
  }

  return {
    path,
    write(line) {
      try {
        if (!line.startsWith(FILE_LINE_PREFIX)) return;
        if (pending.length >= LOCAL_MODELS_LOG_MAX_PENDING) return;
        pending.push(`${now().toISOString()} ${line.replace(/[\r\n]+/g, " ")}\n`);
        kick();
      } catch {
        // never let logging break a turn
      }
    },
    async flush() {
      while (draining) await draining;
    },
  };
}

let installed: LocalModelsLogFile | null = null;

/** Main process startup: `<userData>/logs`. Nothing is created until the first line. */
export function installLocalModelsLogFile(directory: string | null): LocalModelsLogFile | null {
  installed = directory ? createLocalModelsLogFile(directory) : null;
  return installed;
}

/** Test hook: install a prepared writer (or none). */
export function setLocalModelsLogFile(file: LocalModelsLogFile | null): void {
  installed = file;
}

/** One `[local-models]` line: stdout as before, plus the log file when installed. */
export function emitLocalModelsLine(line: string): void {
  console.info(line);
  installed?.write(line);
}
