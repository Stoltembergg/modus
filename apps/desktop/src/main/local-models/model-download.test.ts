import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalModelError } from "./errors";
import type { LocalModelManifest } from "./manifest";
import { ensureModelFiles, sha256File, verifyModelFiles } from "./model-download";

type RecordedRequest = {
  url: string;
  range: string | null;
};

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex").toLowerCase();
}

describe("model-download", () => {
  let tempDir: string;

  const file1Name = "model.bin";
  const file1Content = "fake-model-weights-binary-data-0123456789";
  const file1Sha = sha256Hex(file1Content);

  const file2Name = "tokenizer.json";
  const file2Content = JSON.stringify({ version: "1.0", vocab: { hello: 1, world: 2 } });
  const file2Sha = sha256Hex(file2Content);

  const baseUrl = "https://models.example.com/v1/";

  const fakeManifest: LocalModelManifest = {
    id: "test-model-v1",
    files: [
      { name: file1Name, sha256: file1Sha, role: "model" },
      { name: file2Name, sha256: file2Sha, role: "tokenizer" },
    ],
  };

  const defaultFiles = new Map<string, string>([
    [`${baseUrl}${file1Name}`, file1Content],
    [`${baseUrl}${file2Name}`, file2Content],
  ]);

  const noopSleep = async (_ms: number): Promise<void> => {};

  function createFakeFetch(
    files: Map<string, string>,
    requests: RecordedRequest[],
    options?: {
      ignoreRange?: boolean;
    },
  ): typeof fetch {
    return async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const range = init?.headers ? new Headers(init.headers).get("range") : null;
      requests.push({ url, range });

      const content = files.get(url);
      if (content === undefined) {
        return new Response("Not Found", { status: 404, statusText: "Not Found" });
      }

      if (range && !options?.ignoreRange) {
        const match = range.match(/bytes=(\d+)-/);
        if (match) {
          const start = Number.parseInt(match[1] ?? "0", 10);
          if (start >= content.length) {
            return new Response("", {
              status: 416,
              statusText: "Range Not Satisfiable",
              headers: {
                "Content-Range": `bytes */${content.length}`,
              },
            });
          }
          const slice = content.slice(start);
          return new Response(slice, {
            status: 206,
            statusText: "Partial Content",
            headers: {
              "Content-Range": `bytes ${start}-${content.length - 1}/${content.length}`,
              "Content-Length": String(slice.length),
            },
          });
        }
      }

      return new Response(content, {
        status: 200,
        statusText: "OK",
        headers: {
          "Content-Length": String(content.length),
        },
      });
    };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "model-download-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("a. downloads every file to its final name, no .partial left, URL = baseUrl + name", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = createFakeFetch(defaultFiles, requests);

    await ensureModelFiles({
      manifest: fakeManifest,
      dir: tempDir,
      baseUrl,
      fetchImpl,
      sleep: noopSleep,
    });

    expect(existsSync(join(tempDir, file1Name))).toBe(true);
    expect(existsSync(join(tempDir, file2Name))).toBe(true);
    expect(readFileSync(join(tempDir, file1Name), "utf8")).toBe(file1Content);
    expect(readFileSync(join(tempDir, file2Name), "utf8")).toBe(file2Content);

    const dirFiles = readdirSync(tempDir);
    const partialFiles = dirFiles.filter((f) => f.endsWith(".partial"));
    expect(partialFiles).toHaveLength(0);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(`${baseUrl}${file1Name}`);
    expect(requests[0]?.range).toBeNull();
    expect(requests[1]?.url).toBe(`${baseUrl}${file2Name}`);
    expect(requests[1]?.range).toBeNull();
  });

  it("b. second call with valid files does no fetch at all", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = createFakeFetch(defaultFiles, requests);

    await ensureModelFiles({
      manifest: fakeManifest,
      dir: tempDir,
      baseUrl,
      fetchImpl,
      sleep: noopSleep,
    });
    expect(requests).toHaveLength(2);

    requests.length = 0;

    await ensureModelFiles({
      manifest: fakeManifest,
      dir: tempDir,
      baseUrl,
      fetchImpl,
      sleep: noopSleep,
    });

    expect(requests).toHaveLength(0);
  });

  it("c. existing final file with wrong content is deleted and re-downloaded", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = createFakeFetch(defaultFiles, requests);

    writeFileSync(join(tempDir, file1Name), "corrupted existing weights file");
    writeFileSync(join(tempDir, file2Name), file2Content);

    await ensureModelFiles({
      manifest: fakeManifest,
      dir: tempDir,
      baseUrl,
      fetchImpl,
      sleep: noopSleep,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${baseUrl}${file1Name}`);
    expect(readFileSync(join(tempDir, file1Name), "utf8")).toBe(file1Content);
    expect(await sha256File(join(tempDir, file1Name))).toBe(file1Sha);
  });

  it("d. resume: pre-create a .partial with the first half of the content; assert the request had Range header and server answered 206", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = createFakeFetch(defaultFiles, requests);

    const half = Math.floor(file1Content.length / 2);
    const partialContent = file1Content.slice(0, half);
    writeFileSync(join(tempDir, `${file1Name}.partial`), partialContent);
    writeFileSync(join(tempDir, file2Name), file2Content);

    await ensureModelFiles({
      manifest: fakeManifest,
      dir: tempDir,
      baseUrl,
      fetchImpl,
      sleep: noopSleep,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${baseUrl}${file1Name}`);
    expect(requests[0]?.range).toBe(`bytes=${half}-`);

    expect(existsSync(join(tempDir, `${file1Name}.partial`))).toBe(false);
    expect(readFileSync(join(tempDir, file1Name), "utf8")).toBe(file1Content);
    expect(await sha256File(join(tempDir, file1Name))).toBe(file1Sha);
  });

  it("e. server ignores Range (200 full body) while a stale partial exists -> file still correct", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = createFakeFetch(defaultFiles, requests, { ignoreRange: true });

    writeFileSync(join(tempDir, `${file1Name}.partial`), "stale obsolete partial content");
    writeFileSync(join(tempDir, file2Name), file2Content);

    await ensureModelFiles({
      manifest: fakeManifest,
      dir: tempDir,
      baseUrl,
      fetchImpl,
      sleep: noopSleep,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.range).toBe("bytes=30-");
    expect(existsSync(join(tempDir, `${file1Name}.partial`))).toBe(false);
    expect(readFileSync(join(tempDir, file1Name), "utf8")).toBe(file1Content);
    expect(await sha256File(join(tempDir, file1Name))).toBe(file1Sha);
  });

  it("f. hash mismatch on a fresh download rejects with hash-mismatch, cleans up, and makes only 1 request", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const range = init?.headers ? new Headers(init.headers).get("range") : null;
      requests.push({ url, range });
      return new Response("unexpected bytes from server that do not match pinned hash", {
        status: 200,
        headers: { "Content-Length": "56" },
      });
    };

    const singleFileManifest: LocalModelManifest = {
      id: "single-test",
      files: [{ name: file1Name, sha256: file1Sha, role: "model" }],
    };

    let caughtError: unknown = null;
    try {
      await ensureModelFiles({
        manifest: singleFileManifest,
        dir: tempDir,
        baseUrl,
        fetchImpl,
        sleep: noopSleep,
      });
    } catch (err: unknown) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(LocalModelError);
    const modelErr = caughtError as LocalModelError;
    expect(modelErr.code).toBe("hash-mismatch");
    expect(modelErr.file).toBe(file1Name);
    expect(existsSync(join(tempDir, file1Name))).toBe(false);
    expect(existsSync(join(tempDir, `${file1Name}.partial`))).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("g. a run of failures: first two attempts return 500 / throw a TypeError, third succeeds -> resolves; with retries=2 rejects with download-failed", async () => {
    let callCount = 0;
    const failingFetch: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Internal Server Error", {
          status: 500,
          statusText: "Internal Server Error",
        });
      }
      if (callCount === 2) {
        throw new TypeError("network offline");
      }
      return new Response(file1Content, {
        status: 200,
        headers: { "Content-Length": String(file1Content.length) },
      });
    };

    const singleFileManifest: LocalModelManifest = {
      id: "single-test",
      files: [{ name: file1Name, sha256: file1Sha, role: "model" }],
    };

    // Case 1: with default retries (3), succeeds on 3rd attempt
    await ensureModelFiles({
      manifest: singleFileManifest,
      dir: tempDir,
      baseUrl,
      fetchImpl: failingFetch,
      sleep: noopSleep,
    });
    expect(callCount).toBe(3);
    expect(readFileSync(join(tempDir, file1Name), "utf8")).toBe(file1Content);

    // Reset for Case 2
    rmSync(join(tempDir, file1Name), { force: true });
    callCount = 0;

    // Case 2: with retries = 2, rejects with download-failed
    let caughtError: unknown = null;
    try {
      await ensureModelFiles({
        manifest: singleFileManifest,
        dir: tempDir,
        baseUrl,
        fetchImpl: failingFetch,
        retries: 2,
        sleep: noopSleep,
      });
    } catch (err: unknown) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(LocalModelError);
    const modelErr = caughtError as LocalModelError;
    expect(modelErr.code).toBe("download-failed");
    expect(modelErr.file).toBe(file1Name);
    expect(callCount).toBe(2);
  });

  it("h. a body that errors mid-stream keeps the .partial, and the retry resumes with a Range header", async () => {
    const requests: RecordedRequest[] = [];
    const chunk1 = new TextEncoder().encode(file1Content.slice(0, 15));
    let attemptCount = 0;

    const midStreamFetch: typeof fetch = async (input, init) => {
      attemptCount++;
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const range = init?.headers ? new Headers(init.headers).get("range") : null;
      requests.push({ url, range });

      if (attemptCount === 1) {
        let pulledCount = 0;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            pulledCount++;
            if (pulledCount === 1) {
              controller.enqueue(chunk1);
            } else {
              await new Promise((r) => setTimeout(r, 20));
              controller.error(new Error("socket connection reset mid-stream"));
            }
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Length": String(file1Content.length) },
        });
      }

      // Attempt 2: resume with Range
      const match = range?.match(/bytes=(\d+)-/);
      const start = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
      const rest = file1Content.slice(start);
      return new Response(rest, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${file1Content.length - 1}/${file1Content.length}`,
          "Content-Length": String(rest.length),
        },
      });
    };

    const singleFileManifest: LocalModelManifest = {
      id: "single-test",
      files: [{ name: file1Name, sha256: file1Sha, role: "model" }],
    };

    await ensureModelFiles({
      manifest: singleFileManifest,
      dir: tempDir,
      baseUrl,
      fetchImpl: midStreamFetch,
      sleep: noopSleep,
    });

    expect(attemptCount).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.range).toBeNull();
    expect(requests[1]?.range).toBe("bytes=15-");
    expect(existsSync(join(tempDir, `${file1Name}.partial`))).toBe(false);
    expect(readFileSync(join(tempDir, file1Name), "utf8")).toBe(file1Content);
    expect(await sha256File(join(tempDir, file1Name))).toBe(file1Sha);
  });

  it("i. verifyModelFiles: missing file -> code 'missing'; wrong hash -> code 'hash-mismatch' and the bad file is deleted; all good -> resolves", async () => {
    // 1. Missing file
    let missingError: unknown = null;
    try {
      await verifyModelFiles(fakeManifest, tempDir);
    } catch (err: unknown) {
      missingError = err;
    }
    expect(missingError).toBeInstanceOf(LocalModelError);
    expect((missingError as LocalModelError).code).toBe("missing");
    expect((missingError as LocalModelError).file).toBe(file1Name);

    // 2. Wrong hash
    writeFileSync(join(tempDir, file1Name), file1Content);
    writeFileSync(join(tempDir, file2Name), "corrupted file contents");

    let mismatchError: unknown = null;
    try {
      await verifyModelFiles(fakeManifest, tempDir);
    } catch (err: unknown) {
      mismatchError = err;
    }
    expect(mismatchError).toBeInstanceOf(LocalModelError);
    expect((mismatchError as LocalModelError).code).toBe("hash-mismatch");
    expect((mismatchError as LocalModelError).file).toBe(file2Name);
    // Bad file must be deleted
    expect(existsSync(join(tempDir, file2Name))).toBe(false);
    // Good file must still exist
    expect(existsSync(join(tempDir, file1Name))).toBe(true);

    // 3. All good
    writeFileSync(join(tempDir, file2Name), file2Content);
    await expect(verifyModelFiles(fakeManifest, tempDir)).resolves.toBeUndefined();
  });

  it("resumed download with corrupt partial deletes partial and retries once from scratch", async () => {
    const requests: RecordedRequest[] = [];
    // Stale partial with corrupt bytes
    writeFileSync(join(tempDir, `${file1Name}.partial`), "bad-prefix-data-");

    const fetchImpl = createFakeFetch(defaultFiles, requests);

    const singleFileManifest: LocalModelManifest = {
      id: "single-test",
      files: [{ name: file1Name, sha256: file1Sha, role: "model" }],
    };

    await ensureModelFiles({
      manifest: singleFileManifest,
      dir: tempDir,
      baseUrl,
      fetchImpl,
      sleep: noopSleep,
    });

    // Request 1 attempted resume with Range, resulting file failed hash check.
    // Request 2 was from scratch and succeeded.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.range).toBe("bytes=16-");
    expect(requests[1]?.range).toBeNull();
    expect(readFileSync(join(tempDir, file1Name), "utf8")).toBe(file1Content);
    expect(await sha256File(join(tempDir, file1Name))).toBe(file1Sha);
  });

  it("honours signal by throwing download-failed without retrying", async () => {
    const controller = new AbortController();
    controller.abort();

    const singleFileManifest: LocalModelManifest = {
      id: "single-test",
      files: [{ name: file1Name, sha256: file1Sha, role: "model" }],
    };

    let caughtError: unknown = null;
    try {
      await ensureModelFiles({
        manifest: singleFileManifest,
        dir: tempDir,
        baseUrl,
        signal: controller.signal,
        sleep: noopSleep,
      });
    } catch (err: unknown) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(LocalModelError);
    expect((caughtError as LocalModelError).code).toBe("download-failed");
  });

  it("calls onProgress callback with receivedBytes and totalBytes", async () => {
    const progressEvents: { file: string; receivedBytes: number; totalBytes: number | undefined }[] =
      [];
    const requests: RecordedRequest[] = [];
    const fetchImpl = createFakeFetch(defaultFiles, requests);

    const singleFileManifest: LocalModelManifest = {
      id: "single-test",
      files: [{ name: file1Name, sha256: file1Sha, role: "model" }],
    };

    await ensureModelFiles({
      manifest: singleFileManifest,
      dir: tempDir,
      baseUrl,
      fetchImpl,
      sleep: noopSleep,
      onProgress: (ev) => {
        progressEvents.push(ev);
      },
    });

    expect(progressEvents.length).toBeGreaterThan(0);
    const lastEvent = progressEvents[progressEvents.length - 1];
    expect(lastEvent?.file).toBe(file1Name);
    expect(lastEvent?.receivedBytes).toBe(file1Content.length);
    expect(lastEvent?.totalBytes).toBe(file1Content.length);
  });
});
