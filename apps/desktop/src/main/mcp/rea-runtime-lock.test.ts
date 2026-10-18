import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REA_SUPPORTED_NODE_RANGE } from "./rea-prerequisites";

/**
 * The REA worker is installed by modus-rea-process-supervisor with `npm ci --ignore-scripts`
 * from this manifest + lockfile (compiled into the supervisor). These checks keep the tree
 * fully pinned and make any new install script a deliberate, reviewed change.
 */
const runtimeDirectory = new URL(
  "../../../../../crates/modus-rea-process-supervisor/rea-runtime/",
  import.meta.url,
);
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, runtimeDirectory)), "utf8");
const supervisorSource = readFileSync(
  fileURLToPath(new URL("../src/lib.rs", runtimeDirectory)),
  "utf8",
);

type LockEntry = {
  version?: string;
  resolved?: string;
  integrity?: string;
  hasInstallScript?: boolean;
  link?: boolean;
  engines?: { node?: string };
};
const manifest = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
const lock = JSON.parse(read("package-lock.json")) as {
  lockfileVersion: number;
  packages: Record<string, LockEntry & { dependencies?: Record<string, string> }>;
};
const REA_AGENTS_INTEGRITY =
  "sha512-C6BG7LyrAdR74mSjertM6PrxJkcNZ2bfQNOJornPo9erDEp2tyPRVYPnV5Yodr+1RqewCQla68WulXlVnveD+A==";

describe("locked REA runtime", () => {
  it("pins exactly rea-agents@6.5.0 in the manifest and the lockfile root", () => {
    expect(manifest.dependencies).toEqual({ "rea-agents": "6.5.0" });
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""]?.dependencies).toEqual({ "rea-agents": "6.5.0" });
  });

  it("locks rea-agents to the registry tarball integrity", () => {
    const entry = lock.packages["node_modules/rea-agents"];
    expect(entry?.version).toBe("6.5.0");
    expect(entry?.resolved).toBe("https://registry.npmjs.org/rea-agents/-/rea-agents-6.5.0.tgz");
    expect(entry?.integrity).toBe(REA_AGENTS_INTEGRITY);
    expect(supervisorSource).toContain(`"${REA_AGENTS_INTEGRITY}"`);
    expect(entry?.engines?.node).toBe(REA_SUPPORTED_NODE_RANGE);
  });

  it("pins every transitive package to a registry tarball with a sha512 integrity", () => {
    const entries = Object.entries(lock.packages).filter(([path]) => path !== "");
    expect(entries.length).toBeGreaterThan(100);
    for (const [path, entry] of entries) {
      expect(entry.link, path).toBeUndefined();
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, path).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    }
  });

  it("knows every package that declares an install script (none of them run)", () => {
    const withScripts = Object.entries(lock.packages)
      .filter(([, entry]) => entry.hasInstallScript)
      .map(([path]) => path);
    // frida's install script downloads an unverified prebuilt binary (or builds from source);
    // it stays off. See rea-runtime/README.md before adding anything here.
    expect(withScripts).toEqual(["node_modules/frida"]);
  });

  it("installs with npm ci and install scripts disabled, never npx", () => {
    expect(supervisorSource).toMatch(
      /pub const NPM_CI_ARGS: \[&str; \d+\] = \[\s*"ci",\s*"--ignore-scripts",/,
    );
    expect(supervisorSource).not.toMatch(/"-y"\s*,\s*"rea-agents/);
  });

  it("the supervisor's npm ci refuses a tarball whose sha512 differs from the lockfile, and runs no install script", () => {
    const args = [
      ...(
        /pub const NPM_CI_ARGS: \[&str; \d+\] = \[([^\]]*)\]/.exec(supervisorSource)?.[1] ?? ""
      ).matchAll(/"([^"]+)"/g),
    ].map((match) => match[1] as string);
    expect(args.slice(0, 2)).toEqual(["ci", "--ignore-scripts"]);

    const root = mkdtempSync(join(tmpdir(), "modus-rea-integrity-"));
    const npm = (cwd: string, npmArgs: string[]) =>
      spawnSync("npm", [...npmArgs, "--offline", `--cache=${join(root, "cache")}`], {
        cwd,
        encoding: "utf8",
        shell: process.platform === "win32",
        timeout: 60_000,
      });
    try {
      const pkg = join(root, "pkg");
      mkdirSync(pkg);
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "tiny",
          version: "1.0.0",
          scripts: { install: "node -e \"require('fs').writeFileSync('../../SCRIPT_RAN','')\"" },
        }),
      );
      writeFileSync(join(pkg, "index.js"), "module.exports = 1;\n");
      expect(npm(pkg, ["pack", `--pack-destination=${root}`]).status).toBe(0);
      const tarball = readFileSync(join(root, "tiny-1.0.0.tgz"));
      const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

      const install = (name: string, lockIntegrity: string) => {
        const dir = join(root, name);
        mkdirSync(dir);
        const dependencies = { tiny: "file:../tiny-1.0.0.tgz" };
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name, version: "1.0.0", dependencies }),
        );
        writeFileSync(
          join(dir, "package-lock.json"),
          JSON.stringify({
            name,
            version: "1.0.0",
            lockfileVersion: 3,
            requires: true,
            packages: {
              "": { name, version: "1.0.0", dependencies },
              "node_modules/tiny": {
                version: "1.0.0",
                resolved: "file:../tiny-1.0.0.tgz",
                integrity: lockIntegrity,
                hasInstallScript: true,
              },
            },
          }),
        );
        return { dir, result: npm(dir, args) };
      };

      // Control: the matching hash installs, and the install script still does not run.
      const ok = install("matching", integrity);
      expect(ok.result.status, ok.result.stderr).toBe(0);
      expect(existsSync(join(ok.dir, "node_modules", "tiny", "index.js"))).toBe(true);

      // One flipped character in the sha512: the install fails and nothing lands.
      const flipped = `sha512-${integrity[7] === "A" ? "B" : "A"}${integrity.slice(8)}`;
      const bad = install("tampered", flipped);
      expect(bad.result.status).not.toBe(0);
      expect(`${bad.result.stdout}${bad.result.stderr}`).toMatch(/EINTEGRITY/);
      expect(existsSync(join(bad.dir, "node_modules", "tiny", "index.js"))).toBe(false);

      expect(existsSync(join(ok.dir, "SCRIPT_RAN"))).toBe(false);
      expect(existsSync(join(bad.dir, "SCRIPT_RAN"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
