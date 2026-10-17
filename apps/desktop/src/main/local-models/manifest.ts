/**
 * RERANK-03 v1 (granite-r3 tool ranker): files and pinned hashes. The weights
 * are never bundled in an installer; they are downloaded on demand from the
 * `model-rerank03-v1` GitHub release (or a configured mirror) into
 * `<userData>/models/rerank03-v1/`, and every file is checked against these
 * sha256 values before it is used.
 */
export type LocalModelFile = {
  name: string;
  sha256: string;
  /** "license" files ship next to the weights (Apache-2.0 + NOTICE); never loaded. */
  role: "model" | "tokenizer" | "license";
};

export type LocalModelManifest = {
  id: string;
  files: readonly LocalModelFile[];
};

export const RERANK03_MODEL = {
  id: "rerank03-v1",
  files: [
    {
      name: "model.onnx",
      sha256: "2847dfad94d1c37c55f9dda6100ef7781699cdb3efa81b695e4362de9a7b53cc",
      role: "model",
    },
    {
      name: "tokenizer.json",
      sha256: "c60019bed2dd23874c14a3cfc88db5c591c66f91f7502f91ab3c9717329917cd",
      role: "tokenizer",
    },
    {
      name: "tokenizer_config.json",
      sha256: "6ed69389e30a8ecabfce2f9ebcdf0c908b34056f24d994340f2f216521c057d5",
      role: "tokenizer",
    },
    {
      name: "special_tokens_map.json",
      sha256: "013787ee251ff611722479197c00853b62113ad303cb0a36524231783c676c69",
      role: "tokenizer",
    },
    {
      name: "LICENSE",
      sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
      role: "license",
    },
    {
      name: "NOTICE",
      sha256: "7d59b92777beb1fdc5d9c60c4d3c380c95d377a7b44b0ce14f4fbf7bda7048d7",
      role: "license",
    },
  ],
  /** Token budgets the model was trained and evaluated with (criterion_r3.json). */
  queryMaxLength: 160,
  docMaxLength: 192,
  dimensions: 384,
} as const satisfies LocalModelManifest & Record<string, unknown>;

export const DEFAULT_LOCAL_MODELS_BASE_URL =
  "https://github.com/Stoltembergg/modus/releases/download/model-rerank03-v1/";

/** Env override for the download base URL (a mirror, or a local server in tests). */
export const LOCAL_MODELS_BASE_URL_ENV = "MODUS_LOCAL_MODELS_BASE_URL";

/**
 * Base URL with a trailing slash. Only https, or plain http on loopback (tests
 * and local mirrors); anything else falls back to the default release URL.
 */
export function resolveLocalModelsBaseUrl(
  configured: string | undefined = process.env[LOCAL_MODELS_BASE_URL_ENV],
): string {
  const raw = configured?.trim();
  if (!raw) return DEFAULT_LOCAL_MODELS_BASE_URL;
  try {
    const url = new URL(raw);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      return DEFAULT_LOCAL_MODELS_BASE_URL;
    }
    if (url.username || url.password || url.search || url.hash) return DEFAULT_LOCAL_MODELS_BASE_URL;
    return url.href.endsWith("/") ? url.href : `${url.href}/`;
  } catch {
    return DEFAULT_LOCAL_MODELS_BASE_URL;
  }
}
