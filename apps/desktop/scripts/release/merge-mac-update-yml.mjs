// Merge the per-arch macOS update metadata produced by the arm64 and x64 build jobs
// into the single <channel>-mac.yml that electron-updater reads.
//
// Each mac job runs electron-builder for one arch, so each writes its own
// latest-mac.yml / beta-mac.yml listing only that arch's files. Uploading both to the
// same release would let the last one win. electron-updater's MacUpdater picks the
// file whose URL contains "arm64" on Apple Silicon and a non-arm64 file otherwise, so
// the merged `files` list must contain both arches.
//
// CLI: node merge-mac-update-yml.mjs --out <dir>/latest-mac.yml <arm64.yml> <x64.yml>
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { dump, load } from "js-yaml";
import { channelForVersion, updateChannelFor } from "./release-channel.mjs";

/**
 * @typedef {{ url: string, sha512: string, size: number, [key: string]: unknown }} UpdateFile
 * @typedef {{ version: string, files: UpdateFile[], path?: string, sha512?: string,
 *   releaseDate?: string, [key: string]: unknown }} UpdateInfo
 */

const isArm64Url = (url) => url.includes("arm64");

/**
 * @param {unknown} value
 * @param {string} label used in error messages (usually the source file name)
 * @returns {UpdateInfo}
 */
export function validateUpdateInfo(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected a YAML mapping.`);
  }
  const info = /** @type {Record<string, unknown>} */ (value);
  if (typeof info.version !== "string" || info.version.length === 0) {
    throw new Error(`${label}: missing "version".`);
  }
  if (!Array.isArray(info.files) || info.files.length === 0) {
    throw new Error(`${label}: missing "files".`);
  }
  info.files.forEach((file, index) => {
    const where = `${label}: files[${index}]`;
    if (file == null || typeof file !== "object") throw new Error(`${where} is not a mapping.`);
    if (typeof file.url !== "string" || file.url.length === 0) {
      throw new Error(`${where} is missing "url".`);
    }
    if (typeof file.sha512 !== "string" || file.sha512.length === 0) {
      throw new Error(`${where} (${file.url}) is missing "sha512".`);
    }
    if (!Number.isInteger(file.size) || file.size <= 0) {
      throw new Error(`${where} (${file.url}) is missing a positive integer "size".`);
    }
  });
  if (info.releaseDate instanceof Date) info.releaseDate = info.releaseDate.toISOString();
  return /** @type {UpdateInfo} */ (info);
}

/**
 * Expected merged file name for a version: latest-mac.yml or beta-mac.yml.
 * @param {string} version
 */
export function macMetadataFileName(version) {
  const channel = channelForVersion(version);
  if (channel == null) {
    throw new Error(`Version "${version}" is not X.Y.Z or X.Y.Z-beta.N.`);
  }
  return `${updateChannelFor(channel)}-mac.yml`;
}

/**
 * @param {UpdateInfo[]} inputs per-arch update infos (arm64 and x64, any order)
 * @returns {UpdateInfo}
 */
export function mergeMacUpdateInfo(inputs) {
  if (inputs.length < 2) throw new Error("Need the arm64 and the x64 metadata to merge.");
  const versions = new Set(inputs.map((info) => info.version));
  if (versions.size !== 1) {
    throw new Error(`Refusing to merge different versions: ${[...versions].join(", ")}.`);
  }
  const [version] = versions;

  /** @type {Map<string, UpdateFile>} */
  const byUrl = new Map();
  for (const info of inputs) {
    for (const file of info.files) {
      const existing = byUrl.get(file.url);
      if (existing == null) {
        byUrl.set(file.url, { ...file });
      } else if (existing.sha512 !== file.sha512 || existing.size !== file.size) {
        throw new Error(`Conflicting entries for ${file.url} (different sha512/size).`);
      }
    }
  }
  const files = [...byUrl.values()];

  const zips = files.filter((file) => file.url.endsWith(".zip"));
  const arm64Zip = zips.find((file) => isArm64Url(file.url));
  const x64Zip = zips.find((file) => !isArm64Url(file.url));
  if (arm64Zip == null || x64Zip == null) {
    throw new Error(
      `Merged metadata must contain an arm64 zip and an x64 zip; got: ${zips.map((f) => f.url).join(", ") || "none"}.`,
    );
  }

  // Zips first (the updater downloads the zip), x64 before arm64 so tools that only
  // look at files[0] get the build that runs everywhere (x64 runs under Rosetta).
  const rank = (file) => (file.url.endsWith(".zip") ? 0 : 1) * 2 + (isArm64Url(file.url) ? 1 : 0);
  files.sort((a, b) => rank(a) - rank(b));

  const releaseDates = inputs
    .map((info) => info.releaseDate)
    .filter((date) => typeof date === "string" && !Number.isNaN(Date.parse(date)));
  const releaseDate = releaseDates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];

  /** @type {UpdateInfo} */
  const merged = {
    version,
    files,
    // Legacy single-file fields (electron-updater < 2.15). Point at x64: it works on
    // both Intel and, through Rosetta, Apple Silicon.
    path: x64Zip.url,
    sha512: x64Zip.sha512,
  };
  if (releaseDate != null) merged.releaseDate = releaseDate;
  return merged;
}

/** Same YAML style electron-builder uses for its own metadata. */
export function serializeUpdateInfo(info) {
  return dump(info, { lineWidth: 8000, noRefs: true });
}

/**
 * @param {string[]} argv
 * @returns {{ out: string, inputs: string[] }}
 */
export function parseArgs(argv) {
  const inputs = [];
  let out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      out = argv[++i];
    } else {
      inputs.push(argv[i]);
    }
  }
  if (!out || inputs.length < 2) {
    throw new Error(
      "usage: merge-mac-update-yml.mjs --out <latest-mac.yml|beta-mac.yml> <a.yml> <b.yml>",
    );
  }
  return { out, inputs };
}

/**
 * Read, validate, merge and write. Returns the merged info.
 * @param {{ out: string, inputs: string[] }} options
 */
export function mergeFiles({ out, inputs }) {
  const infos = inputs.map((file) => validateUpdateInfo(load(readFileSync(file, "utf8")), file));
  const merged = mergeMacUpdateInfo(infos);
  const expectedName = macMetadataFileName(merged.version);
  if (basename(out) !== expectedName) {
    throw new Error(
      `Version ${merged.version} must be published as ${expectedName}, not ${basename(out)}.`,
    );
  }
  for (const file of inputs) {
    if (basename(file) !== expectedName) {
      throw new Error(
        `Input ${file} should be named ${expectedName} for version ${merged.version}.`,
      );
    }
  }
  writeFileSync(out, serializeUpdateInfo(merged));
  return merged;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const merged = mergeFiles(parseArgs(process.argv.slice(2)));
    console.log(`Merged ${merged.files.length} files for ${merged.version}:`);
    for (const file of merged.files) console.log(`  ${file.url} (${file.size} bytes)`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
