/**
 * Where a grep / find result row opens (C2.1). The PI tools print paths
 * relative to the directory they searched (`args.path`, itself relative to the
 * session cwd or absolute), or an absolute path. This pure helper joins and
 * normalises them and refuses anything that leaves the workspace, so the
 * Search card never asks the Files panel to open a path outside the cwd.
 *
 * Windows workspaces (drive letter, UNC or `\` in the cwd) compare
 * case-insensitively and get `\` separators back; POSIX compares exactly.
 */
export type SearchResultTarget =
  | { kind: "open"; path: string }
  | { kind: "outside"; path: string }
  | { kind: "unavailable" };

const DRIVE = /^[a-zA-Z]:\//;

function toSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || DRIVE.test(path);
}

export function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.includes("\\");
}

/** Root prefix kept verbatim by normalisation: "C:/", "//server/share/" or "/". */
function rootOf(path: string): string {
  if (DRIVE.test(path)) return path.slice(0, 3);
  const unc = /^\/\/[^/]+\/[^/]+\/?/.exec(path);
  if (unc) return unc[0].endsWith("/") ? unc[0] : `${unc[0]}/`;
  return path.startsWith("/") ? "/" : "";
}

/**
 * Resolve `.` / `..` / repeated separators. Returns undefined when `..` climbs
 * above the root (that can never be inside a workspace).
 */
export function normalizeSlashPath(input: string): string | undefined {
  const path = toSlashes(input);
  const root = rootOf(path);
  const parts: string[] = [];
  for (const part of path.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return root + parts.join("/");
}

function joinSlash(base: string, rest: string): string {
  if (!rest) return base;
  return `${base.replace(/\/+$/, "")}/${rest}`;
}

export function resolveSearchResultTarget(input: {
  /** Session cwd (the workspace root). Without it nothing can open. */
  cwd: string | undefined;
  /** The search tool's `path` argument (relative to cwd, or absolute). */
  searchPath?: string | undefined;
  /** The path the tool printed for this result. */
  resultPath: string;
}): SearchResultTarget {
  const { cwd, resultPath } = input;
  if (!cwd?.trim() || !resultPath.trim()) return { kind: "unavailable" };
  const windows = isWindowsPath(cwd);
  const root = normalizeSlashPath(cwd);
  if (root === undefined || !isAbsolutePath(root)) return { kind: "unavailable" };

  const printed = toSlashes(resultPath.trim());
  let full: string;
  if (isAbsolutePath(printed)) {
    // Already absolute: never join it again with the search path.
    full = printed;
  } else {
    const search = toSlashes(input.searchPath?.trim() ?? "");
    const base = isAbsolutePath(search) ? search : joinSlash(root, search);
    full = joinSlash(base, printed);
  }
  const normalized = normalizeSlashPath(full);
  const display = windows ? printed.replace(/\//g, "\\") : printed;
  if (normalized === undefined) return { kind: "outside", path: display };

  const compare = (value: string) => (windows ? value.toLowerCase() : value);
  const rootKey = compare(root.replace(/\/+$/, ""));
  const fullKey = compare(normalized.replace(/\/+$/, ""));
  const inside = fullKey === rootKey || fullKey.startsWith(`${rootKey}/`);
  if (!inside)
    return { kind: "outside", path: windows ? normalized.replace(/\//g, "\\") : normalized };
  return { kind: "open", path: windows ? normalized.replace(/\//g, "\\") : normalized };
}
