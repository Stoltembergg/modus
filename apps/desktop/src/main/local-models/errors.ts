/** Every way the local model path can fail. Each one falls back to exposing all tools. */
export type LocalModelFailure =
  | "disabled"
  | "unsupported-platform"
  | "missing"
  | "hash-mismatch"
  | "download-failed"
  | "load-failed"
  | "not-ready"
  | "timeout"
  | "inference-failed";

export class LocalModelError extends Error {
  readonly code: LocalModelFailure;
  readonly file: string | undefined;

  constructor(code: LocalModelFailure, message: string, options?: { file?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LocalModelError";
    this.code = code;
    this.file = options?.file;
  }
}

export function localModelFailureOf(error: unknown): LocalModelFailure {
  return error instanceof LocalModelError ? error.code : "load-failed";
}
