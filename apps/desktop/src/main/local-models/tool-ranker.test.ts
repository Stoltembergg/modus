import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalEmbedder } from "./embedder";
import { LocalModelError } from "./errors";
import type { LocalModelManifest } from "./manifest";
import { RERANK03_MODEL } from "./manifest";
import { ensureModelFiles, verifyModelFiles } from "./model-download";
import { onnxRuntimeLoaded, onnxRuntimeSupported } from "./onnx-runtime";
import {
  createLocalToolRanker,
  getLocalToolRanker,
  type LocalToolRankerDeps,
  localToolFilterEnabled,
  TOOL_SELECTION_TIMEOUT_MS,
} from "./tool-ranker";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "modus-local-models-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOOLS = [
  { name: "read_file", doc: "Read a file" },
  { name: "web_search", doc: "Search the web" },
  { name: "terminal_run", doc: "Run a shell command" },
  { name: "browser_open", doc: "Open a web page" },
];
const ALL = TOOLS.map((tool) => tool.name);

/** Deterministic fake embedder: 2-d vectors, "web" texts point one way, others the other. */
function fakeEmbedder(delayMs = 0): LocalEmbedder {
  return {
    async embed(text) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return /web/i.test(text) ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]);
    },
    release: vi.fn(async () => undefined),
  };
}

function ranker(overrides: Partial<LocalToolRankerDeps> = {}) {
  const deps = {
    isEnabled: () => true,
    dir: tempDir(),
    baseUrl: "http://127.0.0.1:9/",
    ensureFiles: vi.fn(async () => undefined),
    verifyFiles: vi.fn(async () => undefined),
    loadRuntime: vi.fn(async () => ({}) as never),
    loadEmbedder: vi.fn(async () => fakeEmbedder()),
    log: () => undefined,
    ...overrides,
  };
  return { deps, ranker: createLocalToolRanker(deps) };
}

async function warm(r: ReturnType<typeof createLocalToolRanker>) {
  await r.prepare();
  // First call embeds the tool docs in the background and falls back.
  await r.select({ query: "warm", tools: TOOLS, k: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("flag off (default): no behaviour change", () => {
  it("tool_filter.enabled (MODUS_LOCAL_TOOL_FILTER) is off unless set", () => {
    vi.stubEnv("MODUS_LOCAL_TOOL_FILTER", "");
    expect(localToolFilterEnabled()).toBe(false);
    vi.stubEnv("MODUS_LOCAL_TOOL_FILTER", "0");
    expect(localToolFilterEnabled()).toBe(false);
    vi.stubEnv("MODUS_LOCAL_TOOL_FILTER", "1");
    expect(localToolFilterEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });

  it("nothing is downloaded or loaded, and every tool is returned", async () => {
    const { deps, ranker: r } = ranker({ isEnabled: () => false });
    expect(await r.prepare()).toEqual({ state: "idle" });
    expect(await r.select({ query: "search the web", tools: TOOLS, k: 1 })).toEqual({
      tools: ALL,
      filtered: false,
      fallback: "disabled",
    });
    expect(deps.ensureFiles).not.toHaveBeenCalled();
    expect(deps.verifyFiles).not.toHaveBeenCalled();
    expect(deps.loadRuntime).not.toHaveBeenCalled();
    expect(deps.loadEmbedder).not.toHaveBeenCalled();
  });

  it("the real app ranker with the flag off: no fetch, no model dir, onnxruntime never imported", async () => {
    vi.stubEnv("MODUS_LOCAL_TOOL_FILTER", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const userData = tempDir();
    const r = getLocalToolRanker(userData);
    await r.prepare();
    const selection = await r.select({ query: "anything", tools: TOOLS, k: 1 });
    expect(selection.tools).toEqual(ALL);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(userData, "models"))).toBe(false);
    expect(onnxRuntimeLoaded()).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("every failure falls back to all tools", () => {
  it("missing model (nothing downloaded, offline): fallback 'missing', runtime never loaded", async () => {
    const dir = tempDir();
    const { deps, ranker: r } = ranker({
      dir,
      verifyFiles: (target) => verifyModelFiles(RERANK03_MODEL, target),
    });
    expect(await r.prepare()).toMatchObject({ state: "failed", failure: "missing" });
    expect(await r.select({ query: "q", tools: TOOLS, k: 1 })).toMatchObject({
      tools: ALL,
      fallback: "missing",
    });
    expect(deps.loadRuntime).not.toHaveBeenCalled();
  });

  it("download failure: fallback 'download-failed'", async () => {
    const { ranker: r } = ranker({
      ensureFiles: async () => {
        throw new LocalModelError("download-failed", "offline");
      },
    });
    await r.prepare();
    expect((await r.select({ query: "q", tools: TOOLS, k: 1 })).fallback).toBe("download-failed");
  });

  describe("hash mismatch, one file at a time", () => {
    const names = RERANK03_MODEL.files.map((file) => file.name);
    it.each(
      names,
    )("%s corrupted: fallback 'hash-mismatch', the bad file is deleted, nothing loads", async (bad) => {
      const dir = tempDir();
      const files = names.map((name) => {
        const content = `content of ${name}`;
        writeFileSync(join(dir, name), name === bad ? "tampered" : content);
        return {
          name,
          sha256: createHash("sha256").update(content).digest("hex"),
          role: "model" as const,
        };
      });
      const manifest: LocalModelManifest = { id: "test", files };
      const { deps, ranker: r } = ranker({
        dir,
        verifyFiles: (target) => verifyModelFiles(manifest, target),
      });
      expect(await r.prepare()).toMatchObject({ state: "failed", failure: "hash-mismatch" });
      expect(await r.select({ query: "q", tools: TOOLS, k: 1 })).toMatchObject({
        tools: ALL,
        filtered: false,
        fallback: "hash-mismatch",
      });
      expect(existsSync(join(dir, bad))).toBe(false);
      expect(deps.loadRuntime).not.toHaveBeenCalled();
    });

    it.each(
      names,
    )("server serves a wrong %s: the download is rejected before anything loads", async (bad) => {
      const dir = tempDir();
      const files = names.map((name) => ({
        name,
        sha256: createHash("sha256").update(`content of ${name}`).digest("hex"),
        role: "model" as const,
      }));
      const manifest: LocalModelManifest = { id: "test", files };
      const fetchImpl = (async (url: string | URL | Request) => {
        const name = String(url).split("/").pop() as string;
        return new Response(name === bad ? "evil" : `content of ${name}`, { status: 200 });
      }) as typeof fetch;
      const { deps, ranker: r } = ranker({
        dir,
        ensureFiles: (target, baseUrl) =>
          ensureModelFiles({
            manifest,
            dir: target,
            baseUrl,
            fetchImpl,
            sleep: async () => undefined,
          }),
        verifyFiles: (target) => verifyModelFiles(manifest, target),
      });
      expect(await r.prepare()).toMatchObject({ state: "failed", failure: "hash-mismatch" });
      expect((await r.select({ query: "q", tools: TOOLS, k: 1 })).tools).toEqual(ALL);
      expect(existsSync(join(dir, bad))).toBe(false);
      expect(existsSync(join(dir, `${bad}.partial`))).toBe(false);
      expect(deps.loadRuntime).not.toHaveBeenCalled();
    });
  });

  it("onnxruntime fails to load: fallback 'load-failed'", async () => {
    const { ranker: r } = ranker({
      loadRuntime: async () => {
        throw new LocalModelError("load-failed", "dlopen failed");
      },
    });
    expect(await r.prepare()).toMatchObject({ state: "failed", failure: "load-failed" });
    expect(await r.select({ query: "q", tools: TOOLS, k: 1 })).toMatchObject({
      tools: ALL,
      fallback: "load-failed",
    });
  });

  it("the model fails to load (bad graph, out of memory…): fallback 'load-failed'", async () => {
    const { ranker: r } = ranker({
      loadEmbedder: async () => {
        throw new Error("Protobuf parsing failed");
      },
    });
    await r.prepare();
    expect((await r.select({ query: "q", tools: TOOLS, k: 1 })).fallback).toBe("load-failed");
  });

  it(`selection over ${TOOL_SELECTION_TIMEOUT_MS} ms: fallback 'timeout'`, async () => {
    let slow = false;
    const model = fakeEmbedder();
    const embed = model.embed;
    model.embed = async (text, max) => {
      if (slow) await new Promise((resolve) => setTimeout(resolve, TOOL_SELECTION_TIMEOUT_MS + 40));
      return embed(text, max);
    };
    const { ranker: r } = ranker({ loadEmbedder: async () => model });
    await warm(r);
    slow = true;
    const selection = await r.select({ query: "search the web", tools: TOOLS, k: 1 });
    expect(selection).toMatchObject({ tools: ALL, filtered: false, fallback: "timeout" });
  });

  it("a selection that returns late by the clock (event loop stall) also counts as a timeout", async () => {
    let clock = 0;
    const { ranker: r } = ranker({ now: () => clock });
    await warm(r);
    clock = 0;
    const pending = r.select({ query: "search the web", tools: TOOLS, k: 1 });
    clock = TOOL_SELECTION_TIMEOUT_MS + 1;
    expect((await pending).fallback).toBe("timeout");
  });

  it("an inference error: fallback, never a throw", async () => {
    const model = fakeEmbedder();
    const { ranker: r } = ranker({ loadEmbedder: async () => model });
    await warm(r);
    model.embed = async () => {
      throw new LocalModelError("inference-failed", "boom");
    };
    expect((await r.select({ query: "q", tools: TOOLS, k: 1 })).fallback).toBe("inference-failed");
  });

  it("not ready yet (first call, model loading): fallback and load in the background", async () => {
    const { deps, ranker: r } = ranker();
    expect((await r.select({ query: "q", tools: TOOLS, k: 1 })).fallback).toBe("not-ready");
    await r.prepare();
    expect(deps.loadEmbedder).toHaveBeenCalledTimes(1);
  });

  it("Intel macs have no onnxruntime binary: unsupported, nothing to load", () => {
    expect(onnxRuntimeSupported("darwin", "x64")).toBe(false);
    expect(onnxRuntimeSupported("darwin", "arm64")).toBe(true);
    expect(onnxRuntimeSupported("win32", "x64")).toBe(true);
    expect(onnxRuntimeSupported("linux", "x64")).toBe(true);
  });
});

describe("ready", () => {
  it("core tools + top-k by cosine, in the input order", async () => {
    const { ranker: r } = ranker();
    await warm(r);
    const selection = await r.select({
      query: "search the web for news",
      tools: TOOLS,
      k: 2,
      core: ["read_file"],
    });
    expect(selection.filtered).toBe(true);
    expect(selection.tools).toEqual(["read_file", "web_search", "browser_open"]);
    expect(r.status()).toMatchObject({ state: "ready" });
  });
});
