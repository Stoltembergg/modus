import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { app } from "electron";
import type { AgentSessionInfo } from "../../shared/contracts";
import { listOtherAgentSessionPiSessionFiles } from "./agent-store";

// A corrupt/unbounded first record must not load an entire conversation into memory.
const MAX_HEADER_BYTES = 64 * 1024;
type CleanupResult = "deleted" | "preserved" | "failed";

function sameIdentity(a: Stats, b: Stats): boolean {
  // No usable filesystem identity means ownership cannot be established safely.
  return a.ino !== 0 && b.ino !== 0 && a.dev === b.dev && a.ino === b.ino;
}

function sameFile(a: Stats, b: Stats): boolean {
  return sameIdentity(a, b) && b.isFile() && !b.isSymbolicLink() && b.nlink === 1 &&
    a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function hasOwnedHeader(fd: number, piSessionId: string): boolean {
  const buffer = Buffer.alloc(MAX_HEADER_BYTES);
  let length = 0;
  while (length < buffer.length) {
    const bytes = readSync(fd, buffer, length, Math.min(4096, buffer.length - length), length);
    if (bytes === 0) break;
    const newline = buffer.indexOf(10, length);
    length += bytes;
    if (newline >= 0 && newline < length) {
      length = newline;
      break;
    }
  }
  if (length === 0 || length >= MAX_HEADER_BYTES) return false;
  try {
    const header: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    return typeof header === "object" && header !== null &&
      "type" in header && header.type === "session" &&
      "id" in header && header.id === piSessionId;
  } catch {
    return false;
  }
}

/**
 * Best-effort, fail-closed cleanup. Keep this synchronous: no app operation may
 * interleave the reference/identity checks, unlink, and caller's record deletion.
 * Never return/log paths, contents, or underlying errors.
 */
export function deleteOwnedPiSessionFile(
  session: Pick<AgentSessionInfo, "id" | "piSessionId" | "piSessionFile">,
): CleanupResult {
  const candidate = session.piSessionFile;
  if (!candidate || !session.piSessionId || !isAbsolute(candidate) ||
    candidate.split(/[\\/]/).includes("..")) return "preserved";

  let fd: number | undefined;
  try {
    const store = join(app.getPath("userData"), "pi-sessions");
    const storeStat = lstatSync(store);
    if (!storeStat.isDirectory() || storeStat.isSymbolicLink()) return "preserved";
    const canonicalStore = realpathSync(store);
    const parent = dirname(resolve(candidate));
    if (parent !== resolve(store) && parent !== canonicalStore) return "preserved";
    const canonicalCandidate = realpathSync(candidate);
    if (canonicalCandidate !== join(canonicalStore, basename(candidate))) return "preserved";

    const inspected = lstatSync(candidate);
    if (!inspected.isFile() || inspected.isSymbolicLink() || inspected.nlink !== 1) return "preserved";
    fd = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!sameFile(inspected, fstatSync(fd)) || !hasOwnedHeader(fd, session.piSessionId)) return "preserved";

    for (const reference of listOtherAgentSessionPiSessionFiles(session.id)) {
      // Legacy relative references have no reliable base: preserve rather than guess.
      if (!isAbsolute(reference)) return "preserved";
      if (resolve(reference) === resolve(candidate)) return "preserved";
      try {
        if (realpathSync(reference) === canonicalCandidate) return "preserved";
      } catch (error) {
        // A nonexistent path cannot currently alias this existing regular file.
        if (!isMissingPath(error)) throw error;
      }
    }

    // Check both the held descriptor and the pathname, plus the store itself.
    // This also rejects a new hard link, in-place modification or swapped directory.
    const finalStore = lstatSync(store);
    if (!finalStore.isDirectory() || finalStore.isSymbolicLink() ||
      !sameIdentity(storeStat, finalStore) || realpathSync(store) !== canonicalStore ||
      realpathSync(candidate) !== canonicalCandidate ||
      !sameFile(inspected, fstatSync(fd)) || !sameFile(inspected, lstatSync(candidate))) return "preserved";

    unlinkSync(candidate);
    return "deleted";
  } catch (error) {
    if (isMissingPath(error) || (error as NodeJS.ErrnoException).code === "ELOOP") return "preserved";
    return "failed";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Descriptor cleanup must never block session deletion. */ }
    }
  }
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
