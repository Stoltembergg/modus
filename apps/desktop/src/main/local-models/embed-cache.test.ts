import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMBED_CACHE_FILE,
  EmbedCache,
  embedCacheDir,
  embedCacheKey,
  rerank03ModelSha,
} from "./embed-cache";
import type { LocalEmbedder } from "./embedder";
import { createWorkerHandler } from "./tool-filter-worker";
import type { MainToWorker, WorkerToMain } from "./worker-protocol";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "modus-embed-cache-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DIM = 4;
const vec = (seed: number) => Float32Array.from([seed, seed + 1, seed + 2, seed + 3]);
const MODEL_A = "a".repeat(64);
const MODEL_B = "b".repeat(64);

describe("EmbedCache", () => {
  it("keys on the model sha and the exact text", () => {
    expect(embedCacheKey(MODEL_A, "read: Read a file.")).toBe(
      embedCacheKey(MODEL_A, "read: Read a file."),
    );
    expect(embedCacheKey(MODEL_A, "read: Read a file.")).not.toBe(
      embedCacheKey(MODEL_B, "read: Read a file."),
    );
    expect(embedCacheKey(MODEL_A, "read: Read a file.")).not.toBe(
      embedCacheKey(MODEL_A, "read: Read files."),
    );
    expect(rerank03ModelSha()).toMatch(/^[0-9a-f]{64}$/);
    expect(embedCacheDir("/u")).toBe(join("/u", "local-models", "tool-embed-cache"));
  });

  it("survives a restart: written atomically, read back bit-exact, no tmp left behind", () => {
    const dir = tempDir();
    const first = new EmbedCache(dir, MODEL_A, DIM);
    expect(first.load()).toMatchObject({ entries: 0, discarded: "missing" });
    first.set("read: Read a file.", vec(1));
    first.set("web_search: Search the web.", vec(5));
    expect(first.flush()).toBe(true);
    expect(readdirSync(dir)).toEqual([EMBED_CACHE_FILE]);
    const second = new EmbedCache(dir, MODEL_A, DIM);
    expect(second.load()).toEqual({ entries: 2, droppedEntries: 0 });
    expect(second.get("web_search: Search the web.")).toEqual(vec(5));
    expect(second.flush()).toBe(false); // nothing changed: no rewrite
  });

  it("a new model sha invalidates the cache (discarded, never used)", () => {
    const dir = tempDir();
    const a = new EmbedCache(dir, MODEL_A, DIM);
    a.load();
    a.set("read: Read a file.", vec(1));
    a.flush();
    const b = new EmbedCache(dir, MODEL_B, DIM);
    expect(b.load()).toMatchObject({ entries: 0, discarded: "model" });
    expect(b.get("read: Read a file.")).toBeUndefined();
    expect(existsSync(join(dir, EMBED_CACHE_FILE))).toBe(false);
  });

  it("a changed doc text misses only that entry", () => {
    const dir = tempDir();
    const a = new EmbedCache(dir, MODEL_A, DIM);
    a.load();
    a.set("read: Read a file.", vec(1));
    a.set("web_search: Search the web.", vec(5));
    a.flush();
    const b = new EmbedCache(dir, MODEL_A, DIM);
    b.load();
    expect(b.get("web_search: Search the web and news.")).toBeUndefined();
    expect(b.get("read: Read a file.")).toEqual(vec(1));
  });

  it.each([
    ["not JSON", "{not json", "corrupt"],
    ["truncated", "TRUNCATE", "corrupt"],
    [
      "wrong shape",
      JSON.stringify({ version: 1, modelSha: MODEL_A, dim: DIM, entries: 3 }),
      "corrupt",
    ],
    ["wrong dimension", "DIM8", "dimension"],
    ["old version", "V0", "version"],
  ])("a %s file is discarded and recomputed, never used", (_label, content, reason) => {
    const dir = tempDir();
    const a = new EmbedCache(dir, MODEL_A, DIM);
    a.load();
    a.set("read: Read a file.", vec(1));
    a.flush();
    const path = join(dir, EMBED_CACHE_FILE);
    const good = readFileSync(path, "utf8");
    const body =
      content === "TRUNCATE"
        ? good.slice(0, Math.floor(good.length / 2))
        : content === "DIM8"
          ? good.replace(`"dim":${DIM}`, '"dim":8')
          : content === "V0"
            ? good.replace('"version":1', '"version":0')
            : content;
    writeFileSync(path, body);
    const b = new EmbedCache(dir, MODEL_A, DIM);
    expect(b.load()).toMatchObject({ entries: 0, discarded: reason });
    expect(b.get("read: Read a file.")).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it("drops single bad entries (wrong length, NaN, foreign key) and keeps the rest", () => {
    const dir = tempDir();
    const a = new EmbedCache(dir, MODEL_A, DIM);
    a.load();
    a.set("good", vec(1));
    a.set("short", vec(2));
    a.set("nan", vec(3));
    a.flush();
    const path = join(dir, EMBED_CACHE_FILE);
    const file = JSON.parse(readFileSync(path, "utf8"));
    for (const entry of file.entries) {
      if (entry.key === embedCacheKey(MODEL_A, "short")) entry.vector = entry.vector.slice(0, 8);
      if (entry.key === embedCacheKey(MODEL_A, "nan")) {
        entry.vector = Buffer.from(Float32Array.from([Number.NaN, 0, 0, 0]).buffer).toString(
          "base64",
        );
      }
    }
    file.entries.push({ ...file.entries[0], key: embedCacheKey(MODEL_B, "good") });
    writeFileSync(path, JSON.stringify(file));
    const b = new EmbedCache(dir, MODEL_A, DIM);
    expect(b.load()).toEqual({ entries: 1, droppedEntries: 3 });
    expect(b.get("good")).toEqual(vec(1));
    expect(b.get("short")).toBeUndefined();
    expect(b.get("nan")).toBeUndefined();
  });

  it("is bounded: over the cap, the least recently seen entries go first", () => {
    const dir = tempDir();
    let clock = 0;
    const cache = new EmbedCache(dir, MODEL_A, DIM, 3, () => clock);
    cache.load();
    for (const name of ["a", "b", "c", "d"]) {
      clock += 10_000_000;
      cache.set(name, vec(1));
    }
    clock += 10_000_000;
    cache.get("a"); // seen in the current catalog again
    cache.flush();
    const reread = new EmbedCache(dir, MODEL_A, DIM, 3);
    expect(reread.load().entries).toBe(3);
    expect(reread.get("b")).toBeUndefined();
    expect(reread.get("a")).toEqual(vec(1));
  });
});

/** The model process with a counting fake embedder: what actually gets recomputed. */
function worker(_cacheDir: string, modelSha = MODEL_A) {
  const embedded: string[] = [];
  const replies: WorkerToMain[] = [];
  const embedder: LocalEmbedder = {
    async embed(text) {
      embedded.push(text);
      let h = 0;
      for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 997;
      return Float32Array.from([h, 1, 2, 3]);
    },
    release: async () => undefined,
  };
  const handle = createWorkerHandler((reply) => replies.push(reply), {
    loadEmbedder: async () => embedder,
    modelSha,
  });
  let id = 0;
  const send = async (message: Record<string, unknown>) => {
    await handle({ ...message, id: ++id } as MainToWorker);
    return replies.at(-1) as WorkerToMain;
  };
  return { send, embedded, docsEmbedded: () => embedded.filter((t) => !t.startsWith("warm-up")) };
}

const CATALOG = [
  { name: "web_search", doc: "web_search: Search the web." },
  { name: "terminal_run", doc: "terminal_run: Run a shell command." },
  { name: "mcp__github__create_issue", doc: "mcp__github__create_issue: Create an issue." },
  { name: "mcp__github__list_prs", doc: "mcp__github__list_prs: List pull requests." },
];

describe("model process with the disk cache", () => {
  it("app reopen / new process: unchanged tools are not recomputed and the first select is ready", async () => {
    const dir = tempDir();
    const first = worker(dir);
    await first.send({ type: "load", dir: "/models", cacheDir: dir });
    await first.send({ type: "warm", docs: CATALOG });
    expect(first.docsEmbedded()).toHaveLength(4);

    const reopened = worker(dir);
    expect(await reopened.send({ type: "load", dir: "/models", cacheDir: dir })).toMatchObject({
      type: "ok",
      cachedDocs: 4,
    });
    // First turn right at session creation, before any warm: served from disk.
    const reply = await reopened.send({
      type: "select",
      query: "search the web",
      docs: CATALOG,
      k: 2,
      budgetMs: 50,
    });
    expect(reply).toMatchObject({ type: "select", status: "ok" });
    // Only the query was embedded; every tool doc came from the disk cache.
    expect(reopened.docsEmbedded()).toEqual(["search the web"]);
  });

  it("an MCP schema change recomputes only the changed tools", async () => {
    const dir = tempDir();
    const first = worker(dir);
    await first.send({ type: "load", dir: "/models", cacheDir: dir });
    await first.send({ type: "warm", docs: CATALOG });
    const changed = CATALOG.map((tool) =>
      tool.name === "mcp__github__create_issue"
        ? { ...tool, doc: "mcp__github__create_issue: Create an issue with labels." }
        : tool,
    );
    changed.push({
      name: "mcp__github__merge_pr",
      doc: "mcp__github__merge_pr: Merge a pull request.",
    });
    const next = worker(dir);
    await next.send({ type: "load", dir: "/models", cacheDir: dir });
    expect(await next.send({ type: "warm", docs: changed })).toMatchObject({
      embeddedDocs: 2,
      cachedDocs: 3,
    });
    expect(next.docsEmbedded()).toEqual([
      "mcp__github__create_issue: Create an issue with labels.",
      "mcp__github__merge_pr: Merge a pull request.",
    ]);
  });

  it("a new model sha recomputes everything", async () => {
    const dir = tempDir();
    const a = worker(dir, MODEL_A);
    await a.send({ type: "load", dir: "/models", cacheDir: dir });
    await a.send({ type: "warm", docs: CATALOG });
    const b = worker(dir, MODEL_B);
    expect(await b.send({ type: "load", dir: "/models", cacheDir: dir })).toMatchObject({
      cachedDocs: 0,
    });
    await b.send({ type: "warm", docs: CATALOG });
    expect(b.docsEmbedded()).toHaveLength(4);
  });

  it("a corrupt cache file is not used: the first select falls back and the docs are recomputed", async () => {
    const dir = tempDir();
    const a = worker(dir);
    await a.send({ type: "load", dir: "/models", cacheDir: dir });
    await a.send({ type: "warm", docs: CATALOG });
    writeFileSync(join(dir, EMBED_CACHE_FILE), "\u0000garbage");
    const b = worker(dir);
    expect(await b.send({ type: "load", dir: "/models", cacheDir: dir })).toMatchObject({
      cachedDocs: 0,
    });
    expect(
      await b.send({ type: "select", query: "q", docs: CATALOG, k: 2, budgetMs: 50 }),
    ).toMatchObject({ status: "not-ready" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(b.docsEmbedded()).toHaveLength(4);
    const c = worker(dir);
    expect(await c.send({ type: "load", dir: "/models", cacheDir: dir })).toMatchObject({
      cachedDocs: 4,
    });
  });

  it("without a cacheDir it stays memory-only (nothing written)", async () => {
    const dir = tempDir();
    const a = worker(dir);
    await a.send({ type: "load", dir: "/models" });
    await a.send({ type: "warm", docs: CATALOG });
    expect(readdirSync(dir)).toEqual([]);
  });
});
