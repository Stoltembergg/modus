import { createHash } from "node:crypto";

/** Inputs that detect when branch, HEAD, deps, or structure changed. */
export type ProjectFingerprintInput = {
  branch?: string;
  head?: string;
  /** Relative path → content digest (SHA-256 hex). Sorted by path when hashed. */
  manifests: ReadonlyArray<{ path: string; digest: string }>;
};

/** Canonical SHA-256 hex of branch + HEAD + sorted manifest digests. */
export function computeProjectFingerprint(input: ProjectFingerprintInput): string {
  const manifests = [...input.manifests]
    .map((row) => ({ path: row.path.replace(/\\/g, "/"), digest: row.digest }))
    .filter((row) => row.path.length > 0 && row.digest.length > 0)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const payload = {
    branch: input.branch ?? "",
    head: input.head ?? "",
    manifests,
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

/** Digest file bytes (or UTF-8 text) for fingerprint manifest rows. */
export function digestBytes(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compatibility between a stored fingerprint and the live project.
 * - `match`: reuse Ready (no Setup work)
 * - `partial`: same branch family — incremental update / selective invalidate
 * - `mismatch`: branch or structure drift — full Setup / Needs refresh
 */
export type FingerprintCompatibility = "match" | "partial" | "mismatch";

export function compareProjectFingerprints(input: {
  stored: string;
  live: string;
  storedBranch?: string;
  liveBranch?: string;
  storedHead?: string;
  liveHead?: string;
}): FingerprintCompatibility {
  if (input.stored && input.live && input.stored === input.live) return "match";
  const storedBranch = (input.storedBranch ?? "").trim();
  const liveBranch = (input.liveBranch ?? "").trim();
  if (storedBranch && liveBranch && storedBranch !== liveBranch) return "mismatch";
  // Same (or unknown) branch with different HEAD/manifests → incremental.
  if (input.stored && input.live) return "partial";
  return "mismatch";
}

/** Manifest paths Setup watches for fingerprint + structural seeding. */
export const PROJECT_SETUP_MANIFEST_PATHS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "requirements.txt",
  "AGENTS.md",
  "CLAUDE.md",
  ".cursor/rules",
] as const;

export function isProjectSetupManifestPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return PROJECT_SETUP_MANIFEST_PATHS.some(
    (manifest) => normalized === manifest || normalized.startsWith(`${manifest}/`),
  );
}
