/**
 * Case-insensitive path collisions (C7). Git (and Linux CI) happily stores
 * `Foo.tsx` next to `foo.tsx`, or `Foo/a.ts` next to `foo/b.ts`; on the
 * default macOS (APFS) and Windows (NTFS) file systems those are the SAME
 * entry, so a checkout silently loses or merges files. `findCaseCollisions`
 * takes the repo paths (as printed by `git ls-files`) and reports every group
 * of distinct spellings that fold to the same key: full file paths AND every
 * directory prefix (a `Foo/` vs `foo/` split is reported as a directory
 * collision even when the files inside have different names).
 *
 * Folding: Unicode NFC, then `toLowerCase()`. NFC catches the macOS
 * normalization-insensitivity (`é` precomposed vs `e` + combining accent);
 * lower-casing catches ASCII and the common Unicode letters (`Ä` / `ä`).
 * Full case folding (`ß` vs `ss`) is not applied: neither APFS nor NTFS
 * treats those as equal.
 *
 * Pure: no file system or git access here; the real-repo check lives in the
 * test (`case-collisions.test.ts`), which runs in the CI `npm run test` job.
 */

export type CaseCollisionKind = "file" | "directory" | "file-directory";

export type CaseCollision = {
  /** "file": only file paths; "directory": only directory prefixes; else both. */
  kind: CaseCollisionKind;
  /** Folded key the spellings share. */
  key: string;
  /** The distinct spellings, sorted (directories without a trailing slash). */
  paths: string[];
};

/** Fold a path for case- and normalization-insensitive comparison. */
export function foldPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function splitPath(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
}

/**
 * Every group of distinct paths / directory prefixes that collide
 * case-insensitively, sorted by key. An empty list means the tree is safe on
 * case-insensitive file systems.
 */
export function findCaseCollisions(paths: Iterable<string>): CaseCollision[] {
  /** folded key → spelling → kinds seen for it */
  const byKey = new Map<string, Map<string, Set<"file" | "directory">>>();
  const add = (spelling: string, kind: "file" | "directory") => {
    const key = foldPath(spelling);
    let spellings = byKey.get(key);
    if (!spellings) {
      spellings = new Map();
      byKey.set(key, spellings);
    }
    let kinds = spellings.get(spelling);
    if (!kinds) {
      kinds = new Set();
      spellings.set(spelling, kinds);
    }
    kinds.add(kind);
  };

  for (const raw of paths) {
    const parts = splitPath(raw);
    if (parts.length === 0) continue;
    for (let index = 1; index < parts.length; index += 1) {
      add(parts.slice(0, index).join("/"), "directory");
    }
    add(parts.join("/"), "file");
  }

  const collisions: CaseCollision[] = [];
  for (const [key, spellings] of byKey) {
    if (spellings.size < 2) continue;
    const kinds = new Set<string>();
    for (const set of spellings.values()) for (const kind of set) kinds.add(kind);
    const kind: CaseCollisionKind =
      kinds.size > 1 ? "file-directory" : kinds.has("file") ? "file" : "directory";
    collisions.push({ kind, key, paths: [...spellings.keys()].sort() });
  }
  return collisions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** One line per collision, e.g. `directory: Foo <-> foo`. */
export function formatCaseCollisions(collisions: readonly CaseCollision[]): string {
  return collisions.map((c) => `${c.kind}: ${c.paths.join(" <-> ")}`).join("\n");
}

/** Paths from `git ls-files -z` output (NUL-separated, no quoting). */
export function parseGitLsFilesZ(output: string): string[] {
  return output.split("\0").filter(Boolean);
}
