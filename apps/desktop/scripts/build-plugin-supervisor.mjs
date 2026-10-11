import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  console.log("Skipping the Linux-only plugin supervisor on this platform.");
  process.exit(0);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const result = spawnSync(
  "cargo",
  ["build", "--locked", "--release", "-p", "modus-plugin-execution-supervisor"],
  { cwd: repositoryRoot, shell: false, stdio: "inherit" },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
