import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(desktopDir, "../..");
const binary =
  process.platform === "win32"
    ? "modus-rea-process-supervisor.exe"
    : "modus-rea-process-supervisor";
const expected = resolve(repoRoot, "target", "release", binary);
const result = spawnSync("cargo", ["build", "--release", "-p", "modus-rea-process-supervisor"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(expected)) {
  throw new Error(`REA supervisor build succeeded but expected binary is missing: ${expected}`);
}
