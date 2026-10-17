import { readFileSync } from "node:fs";
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
});
