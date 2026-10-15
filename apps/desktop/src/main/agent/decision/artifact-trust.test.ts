import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openRootVerifiedFile, openTrustedExecutable } from "./artifact-trust";

it("rejects a writable same-UID tree even when its bytes have a valid digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thx-anchor-"));
  try {
    const path = join(dir, "worker");
    await writeFile(path, "approved");
    await expect(
      openRootVerifiedFile(path, createHash("sha256").update("approved").digest("hex")),
    ).rejects.toThrow("artifact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("rejects a mutable AppImage/development bootstrap rather than trusting its accompanying manifest", async () => {
  await expect(
    openTrustedExecutable({
      executablePath: "/tmp/Modus.AppImage/usr/bin/runtime",
      executableSha256: "0".repeat(64),
    }),
  ).rejects.toThrow("artifact");
});
it("rejects unexpected symlinks and traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thx-anchor-alias-"));
  try {
    const path = join(dir, "link");
    await symlink("/usr/bin/true", path);
    await expect(openRootVerifiedFile(path, "0".repeat(64))).rejects.toThrow("artifact");
    await expect(openRootVerifiedFile("/usr/bin/../bin/true", "0".repeat(64))).rejects.toThrow(
      "artifact",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("executes the inherited verified descriptor of a root-controlled harmless OS fixture", async () => {
  const path = "/usr/bin/true";
  const sha = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  const fd = await openRootVerifiedFile(path, sha);
  try {
    const child = spawn("/proc/self/fd/3", [], {
      shell: false,
      stdio: ["ignore", "ignore", "ignore", fd.fd],
      env: { LANG: "C.UTF-8" },
    });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    expect(result).toBe(0);
  } finally {
    await fd.close();
  }
});
