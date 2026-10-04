import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  macMetadataFileName,
  mergeFiles,
  mergeMacUpdateInfo,
  parseArgs,
  validateUpdateInfo,
} from "./merge-mac-update-yml.mjs";

// Shaped like what electron-builder 26 writes for a single-arch mac build.
function archYml(version: string, arch: "arm64" | "x64", releaseDate: string) {
  const zip = `Modus-${version}-mac-${arch}.zip`;
  const zipSha = `${arch}-zip-sha512==`;
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${zip}`,
    `    sha512: ${zipSha}`,
    `    size: ${arch === "arm64" ? 101 : 202}`,
    `  - url: Modus-${version}-mac-${arch}.dmg`,
    `    sha512: ${arch}-dmg-sha512==`,
    `    size: ${arch === "arm64" ? 303 : 404}`,
    `path: ${zip}`,
    `sha512: ${zipSha}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
}

const load = (text: string, label = "fixture") => validateUpdateInfo(loadYaml(text), label);

describe("mergeMacUpdateInfo", () => {
  it("keeps both arches with their sha512/size and points legacy fields at x64", () => {
    const merged = mergeMacUpdateInfo([
      load(archYml("1.0.0", "arm64", "2026-09-27T10:00:00.000Z")),
      load(archYml("1.0.0", "x64", "2026-09-27T10:05:00.000Z")),
    ]);
    expect(merged).toEqual({
      version: "1.0.0",
      files: [
        { url: "Modus-1.0.0-mac-x64.zip", sha512: "x64-zip-sha512==", size: 202 },
        { url: "Modus-1.0.0-mac-arm64.zip", sha512: "arm64-zip-sha512==", size: 101 },
        { url: "Modus-1.0.0-mac-x64.dmg", sha512: "x64-dmg-sha512==", size: 404 },
        { url: "Modus-1.0.0-mac-arm64.dmg", sha512: "arm64-dmg-sha512==", size: 303 },
      ],
      path: "Modus-1.0.0-mac-x64.zip",
      sha512: "x64-zip-sha512==",
      releaseDate: "2026-09-27T10:05:00.000Z",
    });
  });

  it("does not depend on input order", () => {
    const a = load(archYml("1.0.0", "arm64", "2026-09-27T10:00:00.000Z"));
    const b = load(archYml("1.0.0", "x64", "2026-09-27T09:00:00.000Z"));
    expect(mergeMacUpdateInfo([b, a])).toEqual(mergeMacUpdateInfo([a, b]));
    expect(mergeMacUpdateInfo([b, a]).releaseDate).toBe("2026-09-27T10:00:00.000Z");
  });

  it("refuses to merge different versions", () => {
    expect(() =>
      mergeMacUpdateInfo([
        load(archYml("1.0.0", "arm64", "2026-09-27T10:00:00.000Z")),
        load(archYml("1.0.1", "x64", "2026-09-27T10:00:00.000Z")),
      ]),
    ).toThrow(/different versions: 1\.0\.0, 1\.0\.1/);
  });

  it("refuses conflicting entries for the same url", () => {
    const arm = load(archYml("1.0.0", "arm64", "2026-09-27T10:00:00.000Z"));
    const other = load(archYml("1.0.0", "arm64", "2026-09-27T10:00:00.000Z"));
    other.files[0] = { ...other.files[0], sha512: "different==" };
    expect(() => mergeMacUpdateInfo([arm, other])).toThrow(
      /Conflicting entries for Modus-1\.0\.0-mac-arm64\.zip/,
    );
  });

  it("requires one arm64 and one x64 zip", () => {
    const arm = load(archYml("1.0.0", "arm64", "2026-09-27T10:00:00.000Z"));
    expect(() => mergeMacUpdateInfo([arm, arm])).toThrow(/arm64 zip and an x64 zip/);
    expect(() => mergeMacUpdateInfo([arm])).toThrow(/arm64 and the x64/);
  });
});

describe("validateUpdateInfo", () => {
  it("rejects files without sha512 or size", () => {
    expect(() => load("version: 1.0.0\nfiles:\n  - url: a.zip\n    size: 1\n", "a.yml")).toThrow(
      /a\.yml: files\[0\] \(a\.zip\) is missing "sha512"/,
    );
    expect(() => load("version: 1.0.0\nfiles:\n  - url: a.zip\n    sha512: x\n", "a.yml")).toThrow(
      /"size"/,
    );
    expect(() => load("files: []\n", "a.yml")).toThrow(/missing "version"/);
    expect(() => load("version: 1.0.0\n", "a.yml")).toThrow(/missing "files"/);
  });

  it("normalizes an unquoted releaseDate that YAML parsed as a Date", () => {
    const info = load(
      "version: 1.0.0\nfiles:\n  - {url: a.zip, sha512: x, size: 1}\nreleaseDate: 2026-09-27T10:00:00.000Z\n",
    );
    expect(info.releaseDate).toBe("2026-09-27T10:00:00.000Z");
  });
});

describe("macMetadataFileName", () => {
  it("uses latest-mac.yml for stable and beta-mac.yml for beta versions", () => {
    expect(macMetadataFileName("1.2.3")).toBe("latest-mac.yml");
    expect(macMetadataFileName("1.2.3-beta.4")).toBe("beta-mac.yml");
    expect(() => macMetadataFileName("1.2.3-rc.1")).toThrow(/not X\.Y\.Z/);
  });
});

describe("mergeFiles (CLI path)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "merge-mac-yml-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeArch(version: string, arch: "arm64" | "x64", name: string) {
    mkdirSync(join(dir, arch), { recursive: true });
    const file = join(dir, arch, name);
    writeFileSync(file, archYml(version, arch, "2026-09-27T10:00:00.000Z"));
    return file;
  }

  it.each([
    ["1.0.0", "latest-mac.yml"],
    ["1.1.0-beta.3", "beta-mac.yml"],
  ])("writes %s metadata as %s with both arches", (version, name) => {
    const out = join(dir, name);
    mergeFiles({
      out,
      inputs: [writeArch(version, "arm64", name), writeArch(version, "x64", name)],
    });
    const written = loadYaml(readFileSync(out, "utf8")) as {
      version: string;
      files: { url: string }[];
    };
    expect(written.version).toBe(version);
    expect(written.files.map((f) => f.url)).toEqual([
      `Modus-${version}-mac-x64.zip`,
      `Modus-${version}-mac-arm64.zip`,
      `Modus-${version}-mac-x64.dmg`,
      `Modus-${version}-mac-arm64.dmg`,
    ]);
  });

  it("rejects an output name that does not match the version's channel", () => {
    const inputs = [
      writeArch("1.1.0-beta.3", "arm64", "beta-mac.yml"),
      writeArch("1.1.0-beta.3", "x64", "beta-mac.yml"),
    ];
    expect(() => mergeFiles({ out: join(dir, "latest-mac.yml"), inputs })).toThrow(
      /must be published as beta-mac\.yml, not latest-mac\.yml/,
    );
  });

  it("rejects inputs named for another channel", () => {
    const inputs = [
      writeArch("1.0.0", "arm64", "beta-mac.yml"),
      writeArch("1.0.0", "x64", "beta-mac.yml"),
    ];
    expect(() => mergeFiles({ out: join(dir, "latest-mac.yml"), inputs })).toThrow(
      /should be named latest-mac\.yml/,
    );
  });
});

describe("parseArgs", () => {
  it("parses --out and inputs", () => {
    expect(parseArgs(["--out", "o/latest-mac.yml", "a.yml", "b.yml"])).toEqual({
      out: "o/latest-mac.yml",
      inputs: ["a.yml", "b.yml"],
    });
    expect(() => parseArgs(["a.yml", "b.yml"])).toThrow(/usage/);
  });
});
