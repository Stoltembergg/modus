import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  console.log("Skipping the Linux-only plugin supervisor on this platform.");
  process.exit(0);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const result = spawnSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "-p",
    "modus-plugin-execution-supervisor",
    "-p",
    "modus-plugin-execution-worker",
  ],
  { cwd: repositoryRoot, shell: false, stdio: "inherit" },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

for (const executable of ["modus-plugin-execution-supervisor", "modus-plugin-worker"]) {
  const binaryPath = resolve(repositoryRoot, "target", "release", executable);
  if (!existsSync(binaryPath)) {
    throw new Error(`Linux plugin execution binary was not produced: ${executable}`);
  }
  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    throw new Error(`Linux plugin execution binary is not executable: ${executable}`);
  }
}
