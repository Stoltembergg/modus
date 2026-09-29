import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const restore = join(root, ".p0-restore");
const manifest = JSON.parse(readFileSync(join(restore, "manifest.json"), "utf8"));

for (const entry of manifest.files) {
  const parts = [];
  for (const chunkName of entry.chunks) {
    const name = chunkName.split("/")
.pop();
    parts.push(readFileSync(join(restore, "chunks", name), "utf8").trim());
  }
  const raw = Buffer.from(parts.join(""), "base64");
  if (raw.length !== entry.bytes) {
    throw new Error(`${entry.path}: size ${raw.length} != ${entry.bytes}`);
  }
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(`${entry.path}: sha256 mismatch ${digest}`);
  }
  const out = join(root, entry.path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, raw);
  console.log(`restored ${entry.path} (${entry.bytes} bytes)`);
}

rmSync(restore, { recursive: true, force: true });
const wf = join(root, ".github/workflows/p0-assemble.yml");
if (existsSync(wf)) rmSync(wf);
console.log("cleanup done");
