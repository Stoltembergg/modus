import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = resolve(DESKTOP_DIR, "../..");

export const REA_RUST_TARGETS = Object.freeze({
  "aarch64-apple-darwin": { platform: "darwin", arch: "arm64" },
  "x86_64-apple-darwin": { platform: "darwin", arch: "x64" },
  "aarch64-unknown-linux-gnu": { platform: "linux", arch: "arm64" },
  "x86_64-unknown-linux-gnu": { platform: "linux", arch: "x64" },
  "aarch64-pc-windows-msvc": { platform: "win32", arch: "arm64" },
  "x86_64-pc-windows-msvc": { platform: "win32", arch: "x64" },
});

const HOST_TARGETS = Object.freeze({
  "darwin:arm64": "aarch64-apple-darwin",
  "darwin:x64": "x86_64-apple-darwin",
  "linux:arm64": "aarch64-unknown-linux-gnu",
  "linux:x64": "x86_64-unknown-linux-gnu",
  "win32:arm64": "aarch64-pc-windows-msvc",
  "win32:x64": "x86_64-pc-windows-msvc",
});

export function resolveReaRustTarget({
  target = process.env.MODUS_REA_RUST_TARGET,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const selected = target ?? HOST_TARGETS[`${platform}:${arch}`];
  if (!selected || !Object.hasOwn(REA_RUST_TARGETS, selected)) {
    throw new Error(
      `Unsupported REA supervisor Rust target ${JSON.stringify(selected ?? `${platform}:${arch}`)}. ` +
        `Supported targets: ${Object.keys(REA_RUST_TARGETS).join(", ")}`,
    );
  }
  return selected;
}

/** Builds exactly one Rust target and stages that artifact for electron-builder. */
export function buildReaSupervisor({
  repoRoot = REPO_ROOT,
  target = resolveReaRustTarget(),
  spawn = spawnSync,
  exists = existsSync,
  copy = copyFileSync,
  makeDirectory = mkdirSync,
} = {}) {
  const targetInfo = REA_RUST_TARGETS[target];
  if (!targetInfo)
    throw new Error(`Unsupported REA supervisor Rust target ${JSON.stringify(target)}`);

  const binary = `modus-rea-process-supervisor${targetInfo.platform === "win32" ? ".exe" : ""}`;
  const source = resolve(repoRoot, "target", target, "release", binary);
  const staged = resolve(repoRoot, "target", "release", binary);
  const result = spawn(
    "cargo",
    ["build", "--locked", "--release", "-p", "modus-rea-process-supervisor", "--target", target],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `REA supervisor build for ${target} failed with status ${String(result.status)}`,
    );
  }
  if (!exists(source)) {
    throw new Error(
      `REA supervisor build succeeded but expected target binary is missing: ${source}`,
    );
  }

  makeDirectory(dirname(staged), { recursive: true });
  copy(source, staged);
  return { target, source, staged };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = resolveReaRustTarget();
  const result = buildReaSupervisor({ target });
  console.log(`Staged REA supervisor for ${target}: ${result.staged}`);
}
