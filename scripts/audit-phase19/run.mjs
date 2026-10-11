// Audit only. Builds current production modules; hostile probes run in disposable children.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const approvedTemp = path.join(os.homedir(), "AppData/Local/Temp/opencode");
const dir = fs.mkdtempSync(path.join(approvedTemp, "modus-phase19-audit-"));
const bundle = path.join(dir, "probe.mjs");
await build({
  entryPoints: [path.join(root, "scripts/audit-phase19/probes.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  plugins: [
    {
      name: "no-desktop-side-effects",
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "audit" }));
        b.onLoad({ filter: /.*/, namespace: "audit" }, () => ({
          contents:
            'export const app = {getPath(){throw new Error("Audit: no real userData")}}; export const safeStorage = {};',
          loader: "js",
        }));
      },
    },
  ],
});

const modes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "privileges",
      "js-loop",
      "js-exit",
      "async-timeout",
      "wasm-loop",
      "wasm-start-loop",
      "wasm-host-loop",
      "wasm-zero-fuel-loop",
      "wasm-memory",
      "wasm-controls",
      "wasi-permissions",
      "brokers",
      "registry",
      "lifecycle-restart",
      "lifecycle-partial",
      "lifecycle-race",
      "safe-mode",
      "dependencies",
      "mailbox",
      "spill",
      "model",
      "audit-log",
      "benchmark",
      "upgrade-crash",
      "rollback-crash",
    ];
const results = [];
async function child(mode, phase = "") {
  const started = performance.now();
  return await new Promise((resolve) => {
    const p = spawn(process.execPath, [bundle, mode, dir, phase], {
      cwd: dir,
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        AUDIT_SYNTHETIC_SECRET: "NOT-A-REAL-SECRET",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "",
      stderr = "",
      killed = false;
    p.stdout.on("data", (b) => {
      stdout += b;
    });
    p.stderr.on("data", (b) => {
      stderr += b;
    });
    const timer = setTimeout(
      () => {
        killed = true;
        p.kill();
      },
      mode === "benchmark" ? 15000 : 2500,
    );
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        mode,
        phase,
        code,
        signal,
        externallyKilled: killed,
        durationMs: performance.now() - started,
        stdout,
        stderr,
      });
    });
  });
}
for (const mode of modes) {
  if (mode.endsWith("-crash")) {
    results.push(await child(mode, "crash"));
    results.push(await child(mode, "restart"));
  } else results.push(await child(mode));
}
const resultFile = path.join(dir, "results.json");
fs.writeFileSync(
  resultFile,
  JSON.stringify({ root, dir, node: process.version, results }, null, 2),
);
console.log(JSON.stringify({ resultFile, results }, null, 2));
