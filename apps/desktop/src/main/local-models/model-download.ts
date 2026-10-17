/**
 * Local model weight downloader and integrity verifier.
 *
 * - On-demand download: Model weights and tokenizers are not bundled in installers.
 *   They are fetched on demand from a release or mirror into the local models directory.
 * - Temp .partial + atomic rename: Files are streamed directly to temporary `<file>.partial`
 *   files and atomically renamed to their final names only after verification completes,
 *   preventing partial or corrupt files from ever being used by the runtime.
 * - Resume via HTTP Range: Interrupted transfers inspect the existing `.partial` file
 *   size S and request `Range: bytes=S-` to resume via HTTP 206 Partial Content.
 * - Retries: Failed attempts (non-2xx responses, network errors, stream interruptions,
 *   or HTTP 416 range errors) retry with exponential backoff up to the retry limit.
 * - Pinned hashes: Every downloaded file is verified against its pinned SHA-256 hash
 *   from the manifest before promotion. If a fresh download fails the hash check,
 *   it fails immediately without retry to avoid looping on altered upstream files.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LocalModelError } from "./errors";
import type { LocalModelManifest } from "./manifest";

/**
 * Computes the SHA-256 digest of a file using streaming I/O.
 * Returns the lowercase hexadecimal representation.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  await pipeline(stream, hash);
  return hash.digest("hex").toLowerCase();
}

/**
 * Verifies that all files declared in the manifest exist in dir and match
 * their pinned SHA-256 hashes.
 *
 * Throws LocalModelError("missing", ...) if any file does not exist.
 * Throws LocalModelError("hash-mismatch", ...) if any file's hash does not match,
 * after forcibly removing the invalid file.
 */
export async function verifyModelFiles(manifest: LocalModelManifest, dir: string): Promise<void> {
  for (const file of manifest.files) {
    const filePath = join(dir, file.name);

    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) {
        throw new LocalModelError("missing", `Model file ${file.name} is missing in ${dir}`, {
          file: file.name,
        });
      }
    } catch (err: unknown) {
      if (err instanceof LocalModelError) {
        throw err;
      }
      const errorOptions: { file?: string; cause?: unknown } = { file: file.name };
      if (err !== undefined) {
        errorOptions.cause = err;
      }
      throw new LocalModelError(
        "missing",
        `Model file ${file.name} is missing in ${dir}`,
        errorOptions,
      );
    }

    const actualSha = await sha256File(filePath);
    if (actualSha !== file.sha256.toLowerCase()) {
      await rm(filePath, { force: true });
      throw new LocalModelError(
        "hash-mismatch",
        `Hash mismatch for model file ${file.name} in ${dir}: expected ${file.sha256}, got ${actualSha}`,
        { file: file.name },
      );
    }
  }
}

export type EnsureModelFilesOptions = {
  manifest: LocalModelManifest;
  dir: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  retryDelayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (event: {
    file: string;
    receivedBytes: number;
    totalBytes: number | undefined;
  }) => void;
};

/**
 * Ensures all files in the model manifest are present and verified in dir.
 * Downloads missing or corrupted files into <name>.partial with support for
 * resuming interrupted downloads via HTTP Range headers, and atomically
 * renames each completed file to its final destination upon verification.
 */
export async function ensureModelFiles(options: EnsureModelFilesOptions): Promise<void> {
  const {
    manifest,
    dir,
    baseUrl,
    fetchImpl = globalThis.fetch,
    retries = 3,
    retryDelayMs = (attempt: number) => 500 * 2 ** (attempt - 1),
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    signal,
    onProgress,
  } = options;

  if (signal?.aborted) {
    const abortOptions: { cause?: unknown } = {};
    if (signal.reason !== undefined) {
      abortOptions.cause = signal.reason;
    }
    throw new LocalModelError("download-failed", "Download aborted", abortOptions);
  }

  await mkdir(dir, { recursive: true });

  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  for (const file of manifest.files) {
    if (signal?.aborted) {
      const abortOptions: { file?: string; cause?: unknown } = { file: file.name };
      if (signal.reason !== undefined) {
        abortOptions.cause = signal.reason;
      }
      throw new LocalModelError(
        "download-failed",
        `Download aborted for ${file.name}`,
        abortOptions,
      );
    }

    const finalPath = join(dir, file.name);
    const partialPath = join(dir, `${file.name}.partial`);

    let finalExists = false;
    try {
      const stats = await stat(finalPath);
      finalExists = stats.isFile();
    } catch {
      finalExists = false;
    }

    if (finalExists) {
      const actualSha = await sha256File(finalPath);
      if (actualSha === file.sha256.toLowerCase()) {
        continue;
      }
      await rm(finalPath, { force: true });
    }

    const fileUrl = new URL(file.name, normalizedBaseUrl).toString();

    let attempt = 0;
    let lastError: unknown;
    let downloaded = false;

    while (attempt < retries) {
      attempt++;

      if (signal?.aborted) {
        const abortOptions: { file?: string; cause?: unknown } = { file: file.name };
        if (signal.reason !== undefined) {
          abortOptions.cause = signal.reason;
        }
        throw new LocalModelError(
          "download-failed",
          `Download aborted for ${file.name}`,
          abortOptions,
        );
      }

      let partialSize = 0;
      try {
        const pStat = await stat(partialPath);
        if (pStat.isFile()) {
          partialSize = pStat.size;
        }
      } catch {
        partialSize = 0;
      }

      const headers: Record<string, string> = {};
      const hasRange = partialSize > 0;
      if (hasRange) {
        headers.Range = `bytes=${partialSize}-`;
      }

      let response: Response;
      try {
        response = await fetchImpl(fileUrl, { headers, signal: signal ?? null });
      } catch (err: unknown) {
        if (signal?.aborted || (err as { name?: string })?.name === "AbortError") {
          const abortOptions: { file?: string; cause?: unknown } = { file: file.name };
          const cause = signal?.reason ?? err;
          if (cause !== undefined) {
            abortOptions.cause = cause;
          }
          throw new LocalModelError(
            "download-failed",
            `Download aborted for ${file.name}`,
            abortOptions,
          );
        }
        lastError = err;
        if (attempt < retries) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        const causeMsg = err instanceof Error ? err.message : String(err);
        const errOptions: { file?: string; cause?: unknown } = { file: file.name };
        if (err !== undefined) {
          errOptions.cause = err;
        }
        throw new LocalModelError(
          "download-failed",
          `Failed to download ${file.name}: ${causeMsg}`,
          errOptions,
        );
      }

      if (response.status === 416) {
        await rm(partialPath, { force: true });
        lastError = new Error("HTTP 416 Range Not Satisfiable");
        if (attempt < retries) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw new LocalModelError(
          "download-failed",
          `Failed to download ${file.name}: HTTP 416 Range Not Satisfiable`,
          { file: file.name, cause: lastError },
        );
      }

      if (response.status !== 200 && response.status !== 206) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        if (attempt < retries) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw new LocalModelError(
          "download-failed",
          `Failed to download ${file.name}: HTTP ${response.status}`,
          { file: file.name, cause: lastError },
        );
      }

      if (!response.body) {
        lastError = new Error("Response body is null");
        if (attempt < retries) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw new LocalModelError(
          "download-failed",
          `Failed to download ${file.name}: Response body is null`,
          { file: file.name, cause: lastError },
        );
      }

      const append = response.status === 206 && hasRange;
      const resumed = append;
      const resumeOffset = append ? partialSize : 0;
      let receivedBytes = resumeOffset;

      const contentLengthHeader = response.headers.get("content-length");
      const parsedCl = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined;
      const totalBytes =
        parsedCl !== undefined && !Number.isNaN(parsedCl) ? resumeOffset + parsedCl : undefined;

      const progressTransform = new Transform({
        transform(chunk: Buffer | Uint8Array, _encoding, callback) {
          receivedBytes += chunk.length;
          if (onProgress) {
            onProgress({
              file: file.name,
              receivedBytes,
              totalBytes,
            });
          }
          callback(null, chunk);
        },
      });

      const nodeReadable = Readable.fromWeb(
        response.body as Parameters<typeof Readable.fromWeb>[0],
      );
      const writeStream = createWriteStream(partialPath, {
        flags: append ? "a" : "w",
      });

      try {
        await pipeline(nodeReadable, progressTransform, writeStream);
      } catch (err: unknown) {
        if (signal?.aborted || (err as { name?: string })?.name === "AbortError") {
          const abortOptions: { file?: string; cause?: unknown } = { file: file.name };
          const cause = signal?.reason ?? err;
          if (cause !== undefined) {
            abortOptions.cause = cause;
          }
          throw new LocalModelError(
            "download-failed",
            `Download aborted for ${file.name}`,
            abortOptions,
          );
        }
        lastError = err;
        if (attempt < retries) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        const causeMsg = err instanceof Error ? err.message : String(err);
        const errOptions: { file?: string; cause?: unknown } = { file: file.name };
        if (err !== undefined) {
          errOptions.cause = err;
        }
        throw new LocalModelError(
          "download-failed",
          `Failed to download ${file.name}: ${causeMsg}`,
          errOptions,
        );
      }

      const actualSha = await sha256File(partialPath);
      if (actualSha === file.sha256.toLowerCase()) {
        await rename(partialPath, finalPath);
        downloaded = true;
        break;
      }

      await rm(partialPath, { force: true });

      if (resumed && attempt < retries) {
        await sleep(retryDelayMs(attempt));
        continue;
      }

      throw new LocalModelError(
        "hash-mismatch",
        `Hash mismatch for ${file.name}: expected ${file.sha256}, got ${actualSha}`,
        { file: file.name },
      );
    }

    if (!downloaded) {
      const causeMsg = lastError instanceof Error ? lastError.message : String(lastError);
      const errOptions: { file?: string; cause?: unknown } = { file: file.name };
      if (lastError !== undefined) {
        errOptions.cause = lastError;
      }
      throw new LocalModelError(
        "download-failed",
        `Failed to download ${file.name}: ${causeMsg}`,
        errOptions,
      );
    }
  }
}
