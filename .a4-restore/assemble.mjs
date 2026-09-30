#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const restore = join(root, ".a4-restore");
const manifest = JSON.parse(readFileSync(join(restore, "manifest.json"), "utf8"));

function run(cmd, args) {
  console.log("+", cmd, args.join(" "));
  execFileSync(cmd, args, { stdio: "inherit", cwd: root });
}

for (const [path, patchRel] of Object.entries(manifest.patches)) {
  console.log("apply patch for", path);
  run("git", ["apply", "--whitespace=nowarn", join(root, patchRel)]);
}

for (const [path, parts] of Object.entries(manifest.new_b64)) {
  const b64 = parts.map((p) => readFileSync(join(root, p), "utf8")).join("");
  const buf = Buffer.from(b64, "base64");
  const out = join(root, path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  console.log("write", path, buf.length);
}

if (manifest.expected) {
  for (const [path, size] of Object.entries(manifest.expected)) {
    const actual = readFileSync(join(root, path)).length;
    if (actual !== size) {
      throw new Error(`${path}: expected ${size} bytes, got ${actual}`);
    }
    console.log("ok", path, actual);
  }
}

rmSync(restore, { recursive: true, force: true });
const wf = join(root, ".github/workflows/a4-assemble.yml");
if (existsSync(wf)) rmSync(wf);

run("git", ["config", "user.name", "Gabriel Stoltemberg"]);
run("git", [
  "config",
  "user.email",
  "312632452+Stoltembergg@users.noreply.github.com",
]);
run("git", ["add", "-A"]);
run("git", [
  "commit",
  "-m",
  "feat(agents): create-group modal with templates, copy and custom agents (A4)\n\nAssembled from .a4-restore patches/chunks. New group modal: required folder,\nTemplates (multi-select, Customize, suggestedLead), Copy from another group,\nNew agent with Generate roles; ONE group:create with members[]; inline A2 errors.",
]);
console.log(
  "assembled commit",
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
);
console.log(
  "assembled tree",
  execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
);
