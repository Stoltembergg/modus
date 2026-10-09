import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { resolveGitBinary } from "../git/git-runner";

const MAX_SOURCE_FILES = 10_000;
const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 20 * 1024 * 1024;

function runGit(cwd: string, args: string[]): Buffer {
  return execFileSync(resolveGitBinary(), ["-c", "diff.autoRefreshIndex=false", ...args], {
    cwd,
    encoding: "buffer",
    env: {
      ...process.env,
      GIT_EDITOR: "true",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: 5_000,
    windowsHide: true,
  });
}

function pathList(bytes: Buffer): string[] | undefined {
  const paths = bytes
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (paths.some((path) => path.includes("\uFFFD"))) return undefined;
  return paths;
}

function isContainedPath(root: string, target: string): boolean {
  const prefix = `${root}${sep}`;
  return process.platform === "win32"
    ? target.toLowerCase().startsWith(prefix.toLowerCase())
    : target.startsWith(prefix);
}

/**
 * Content fingerprint of the session's current changed source relative to its
 * run-start checkpoint. Returns undefined when Git or bounded safe reads fail.
 */
export function getWorkspaceSourceRevision(cwd: string, baseCommit: string): string | undefined {
  try {
    const topLevel = runGit(cwd, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
    if (!topLevel) return undefined;
    const root = realpathSync(topLevel);
    const realCwd = realpathSync(cwd);
    if (!isContainedPath(root, realCwd) && root !== realCwd) return undefined;

    const resolvedBase = runGit(root, ["rev-parse", "--verify", `${baseCommit}^{commit}`])
      .toString("utf8")
      .trim();
    if (!/^[a-f0-9]{40,64}$/i.test(resolvedBase)) return undefined;

    const tracked = pathList(
      runGit(root, ["diff", "--name-only", "--no-renames", "-z", resolvedBase, "--"]),
    );
    const untracked = pathList(
      runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    );
    if (!tracked || !untracked) return undefined;
    const paths = [...new Set([...tracked, ...untracked])].sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    if (paths.length > MAX_SOURCE_FILES) return undefined;

    const hash = createRevisionHash();
    hash.update("modus-workspace-source-v1\0").update(root).update("\0").update(resolvedBase);
    let totalBytes = 0;
    for (const path of paths) {
      if (
        !path ||
        path.includes("\uFFFD") ||
        path.includes("\0") ||
        isAbsolute(path) ||
        path.split(/[\\/]/).includes("..")
      ) {
        return undefined;
      }
      const absolutePath = resolve(root, path);
      if (!isContainedPath(root, absolutePath)) return undefined;
      hash.update("\0path\0").update(path).update("\0");

      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          hash.update("deleted\0");
          continue;
        }
        return undefined;
      }
      if (!stat.isFile() || stat.size > MAX_SOURCE_FILE_BYTES) return undefined;
      const realPath = realpathSync(absolutePath);
      const pathMatches =
        process.platform === "win32"
          ? realPath.toLowerCase() === absolutePath.toLowerCase()
          : realPath === absolutePath;
      if (!pathMatches) return undefined;

      const content = readFileSync(absolutePath);
      if (
        content.length > MAX_SOURCE_FILE_BYTES ||
        totalBytes + content.length > MAX_SOURCE_TOTAL_BYTES
      ) {
        return undefined;
      }
      totalBytes += content.length;
      hash.update(String(stat.mode & 0o111)).update("\0");
      hash.update(String(content.length)).update("\0").update(content);
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function createRevisionHash() {
  return createHash("sha256");
}
