import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type CodeGraphRunner,
  type FastCodebaseProgress,
  runCodeGraphCli,
} from "./fast-codebase-service";

const INDEX_TIMEOUT_MS = 5 * 60_000;
const QUERY_TIMEOUT_MS = 90_000;

export type CodeGraphIndexState = "created" | "synced" | "ready";

export type EnsureCodeGraphIndexInput = {
  cwd: string;
  onProgress?: ((progress: FastCodebaseProgress) => void) | undefined;
  runner?: CodeGraphRunner | undefined;
  signal?: AbortSignal | undefined;
};

function codeGraphIndexDir(cwd: string): string {
  return join(cwd, ".codegraph");
}

function isCodeGraphInitialized(cwd: string): boolean {
  return existsSync(join(codeGraphIndexDir(cwd), "codegraph.db"));
}

function failureText(result: { exitCode: number; stderr: string; text: string }): string {
  const text = result.text.trim();
  const stderr = result.stderr.trim();
  const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
  return (
    [text, tail ? `stderr:\n${tail}` : ""].filter(Boolean).join("\n\n") ||
    `codegraph exited with code ${result.exitCode} and no output.`
  );
}

function parseStatus(result: { text: string }): { pending: boolean } {
  try {
    const status = JSON.parse(result.text) as {
      pendingChanges?: { added?: number; modified?: number; removed?: number };
      worktreeMismatch?: unknown;
    };
    const pending = status.pendingChanges;
    return {
      pending:
        Boolean(status.worktreeMismatch) ||
        Boolean((pending?.added ?? 0) + (pending?.modified ?? 0) + (pending?.removed ?? 0)),
    };
  } catch {
    return { pending: false };
  }
}

/**
 * Ensure the local CodeGraph binary index exists and is synced for `cwd`.
 * Does not run a query — used by background auto-sync.
 * Keeps Project Model hit persistence unchanged (hits still come from tools).
 */
export async function ensureCodeGraphIndex(
  input: EnsureCodeGraphIndexInput,
): Promise<CodeGraphIndexState> {
  const cwd = resolve(input.cwd);
  const runner = input.runner ?? runCodeGraphCli;

  if (!isCodeGraphInitialized(cwd)) {
    input.onProgress?.({ phase: "indexing", message: "Initializing CodeGraph index..." });
    const created = await runner(["init", cwd, "--verbose"], {
      cwd,
      signal: input.signal,
      timeoutMs: INDEX_TIMEOUT_MS,
      onProgress: (line) => input.onProgress?.({ phase: "indexing", message: line }),
    });
    if (created.isError) {
      throw new Error(`Fast Codebase indexing failed:\n${failureText(created)}`);
    }
    return "created";
  }

  const status = await runner(["status", cwd, "--json"], {
    cwd,
    signal: input.signal,
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  if (status.isError) {
    throw new Error(`Fast Codebase status failed:\n${failureText(status)}`);
  }
  if (!parseStatus(status).pending) {
    return "ready";
  }

  input.onProgress?.({ phase: "indexing", message: "Syncing CodeGraph index..." });
  const synced = await runner(["sync", cwd], {
    cwd,
    signal: input.signal,
    timeoutMs: INDEX_TIMEOUT_MS,
    onProgress: (line) => input.onProgress?.({ phase: "indexing", message: line }),
  });
  if (synced.isError) {
    throw new Error(`Fast Codebase sync failed:\n${failureText(synced)}`);
  }
  return "synced";
}
