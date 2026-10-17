import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RERANK03_MODEL } from "./manifest";

/**
 * On-disk cache of tool-doc embeddings for the local tool filter. Read and
 * written by the model process only (it computes the vectors). Each entry is
 * keyed by the cache identity (pinned model + tokenizer sha256s + docMaxLength)
 * + the sha256 of the exact text embedded (the tool's doc_short), so a new
 * model/tokenizer invalidates everything and a changed description only its
 * own entry. The file is replaced atomically (tmp + rename); a file
 * that does not parse, is truncated, or has the wrong dimension is discarded
 * and recomputed, never used.
 */
export const EMBED_CACHE_FILE = "embeddings.json";
/** Bumped for format changes (2: combined model + tokenizer + docMaxLength identity). */
export const EMBED_CACHE_VERSION = 2;
/** Hard cap; entries least recently seen in a catalog go first. ~1.5 KB each at 384 dims. */
export const EMBED_CACHE_MAX_ENTRIES = 2_000;

export type CacheIdentityInput = {
  /** Pinned files whose bytes shape the vectors: the model and every tokenizer file. */
  files: ReadonlyArray<{ name: string; sha256: string; role: string }>;
  docMaxLength: number;
};

/**
 * One combined identity for the vectors: sha256 over the pinned sha256 of
 * model.onnx and of every tokenizer file in the manifest (today tokenizer.json,
 * tokenizer_config.json, special_tokens_map.json), plus docMaxLength. Any of
 * them changing invalidates every entry. Used in the file header and as the
 * key prefix.
 */
export function cacheIdentity({ files, docMaxLength }: CacheIdentityInput): string {
  const pinned = files
    .filter((file) => file.role === "model" || file.role === "tokenizer")
    .map((file) => `${file.name}=${file.sha256}`)
    .sort();
  if (!pinned.some((line) => line.startsWith("model.onnx="))) {
    throw new Error("RERANK-03 manifest has no model.onnx");
  }
  return createHash("sha256")
    .update(JSON.stringify({ files: pinned, docMaxLength }), "utf8")
    .digest("hex");
}

export function rerank03CacheIdentity(): string {
  return cacheIdentity({ files: RERANK03_MODEL.files, docMaxLength: RERANK03_MODEL.docMaxLength });
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function embedCacheKey(identity: string, text: string): string {
  return `${identity}:${sha256(text)}`;
}

type Entry = { vector: Float32Array; seenAt: number };

type CacheFile = {
  version: number;
  identity: string;
  dim: number;
  entries: Array<{ key: string; seenAt: number; vector: string }>;
};

export type EmbedCacheLoad = {
  entries: number;
  /** Why the whole file was thrown away, if it was. */
  discarded?: "missing" | "corrupt" | "version" | "identity" | "dimension";
  /** Entries dropped one by one (wrong length, non-finite values, foreign identity). */
  droppedEntries: number;
};

export class EmbedCache {
  private readonly entries = new Map<string, Entry>();
  private dirty = false;

  constructor(
    private readonly dir: string,
    private readonly identity: string,
    private readonly dim: number,
    private readonly maxEntries = EMBED_CACHE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  private filePath(): string {
    return join(this.dir, EMBED_CACHE_FILE);
  }

  load(): EmbedCacheLoad {
    this.entries.clear();
    let raw: string;
    try {
      raw = readFileSync(this.filePath(), "utf8");
    } catch {
      return { entries: 0, discarded: "missing", droppedEntries: 0 };
    }
    const discard = (reason: NonNullable<EmbedCacheLoad["discarded"]>): EmbedCacheLoad => {
      rmSync(this.filePath(), { force: true });
      this.dirty = true;
      return { entries: 0, discarded: reason, droppedEntries: 0 };
    };
    let parsed: CacheFile;
    try {
      parsed = JSON.parse(raw) as CacheFile;
    } catch {
      return discard("corrupt");
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      return discard("corrupt");
    }
    if (parsed.version !== EMBED_CACHE_VERSION) return discard("version");
    if (parsed.identity !== this.identity) return discard("identity");
    if (parsed.dim !== this.dim) return discard("dimension");
    let dropped = 0;
    for (const entry of parsed.entries) {
      const vector = decode(entry?.vector, this.dim);
      if (
        !vector ||
        typeof entry.key !== "string" ||
        !entry.key.startsWith(`${this.identity}:`) ||
        typeof entry.seenAt !== "number"
      ) {
        dropped++;
        continue;
      }
      this.entries.set(entry.key, { vector, seenAt: entry.seenAt });
    }
    if (dropped > 0) this.dirty = true;
    return { entries: this.entries.size, droppedEntries: dropped };
  }

  get(text: string): Float32Array | undefined {
    const entry = this.entries.get(embedCacheKey(this.identity, text));
    if (!entry) return undefined;
    const seenAt = this.now();
    // Recency only needs to be coarse: rewrite the file for it at most hourly.
    if (seenAt - entry.seenAt > 3_600_000) this.dirty = true;
    entry.seenAt = seenAt;
    return entry.vector;
  }

  set(text: string, vector: Float32Array): void {
    if (vector.length !== this.dim) return;
    this.entries.set(embedCacheKey(this.identity, text), {
      vector: Float32Array.from(vector),
      seenAt: this.now(),
    });
    this.dirty = true;
  }

  /** Write if anything changed: prune to the cap, tmp file + rename. Never throws. */
  flush(): boolean {
    if (!this.dirty) return false;
    if (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries].sort((a, b) => a[1].seenAt - b[1].seenAt);
      for (const [key] of oldest.slice(0, this.entries.size - this.maxEntries)) {
        this.entries.delete(key);
      }
    }
    const body: CacheFile = {
      version: EMBED_CACHE_VERSION,
      identity: this.identity,
      dim: this.dim,
      entries: [...this.entries].map(([key, { vector, seenAt }]) => ({
        key,
        seenAt,
        vector: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64"),
      })),
    };
    const tmp = `${this.filePath()}.${process.pid}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(body), "utf8");
      renameSync(tmp, this.filePath());
      this.dirty = false;
      return true;
    } catch {
      rmSync(tmp, { force: true });
      return false;
    }
  }
}

function decode(value: unknown, dim: number): Float32Array | null {
  if (typeof value !== "string") return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== dim * 4) return null;
  const vector = new Float32Array(dim);
  new Uint8Array(vector.buffer).set(bytes);
  for (const x of vector) if (!Number.isFinite(x)) return null;
  return vector;
}

/** `<userData>/local-models/tool-embed-cache/` */
export function embedCacheDir(userDataDir: string): string {
  return join(userDataDir, "local-models", "tool-embed-cache");
}
