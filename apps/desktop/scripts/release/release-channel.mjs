// Release channel rules shared by the release workflow and its tests.
//
//   vX.Y.Z         -> stable: GitHub release, update metadata "latest*.yml" (auto-updates)
//   vX.Y.Z-beta.N  -> beta:   GitHub pre-release, update metadata "beta*.yml"
//   anything else  -> rejected
//
// CLI (writes key=value lines, suitable for $GITHUB_OUTPUT):
//   node release-channel.mjs tag <tag> <package.json version>
//   node release-channel.mjs version <package.json version>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const NUM = "(?:0|[1-9]\\d*)";
const STABLE_VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const BETA_VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}-beta\\.${NUM}$`);

/**
 * @param {string} version semver without leading "v"
 * @returns {"stable" | "beta" | null}
 */
export function channelForVersion(version) {
  if (STABLE_VERSION.test(version)) return "stable";
  if (BETA_VERSION.test(version)) return "beta";
  return null;
}

/**
 * electron-builder/electron-updater metadata prefix for a channel.
 * @param {"stable" | "beta"} channel
 */
export function updateChannelFor(channel) {
  return channel === "beta" ? "beta" : "latest";
}

/** @param {"stable" | "beta"} channel */
function releaseInfo(version, channel) {
  const updateChannel = updateChannelFor(channel);
  return {
    version,
    channel,
    updateChannel,
    prerelease: channel === "beta",
    metadataFiles: {
      mac: `${updateChannel}-mac.yml`,
      windows: `${updateChannel}.yml`,
      linux: `${updateChannel}-linux.yml`,
    },
  };
}

/**
 * Parse a release tag and check it against the app version that ends up in the
 * update metadata. Throws with a readable message on any mismatch.
 * @param {string} tag e.g. "v1.2.3" or "v1.2.3-beta.4"
 * @param {string} packageVersion "version" from apps/desktop/package.json
 */
export function resolveTagRelease(tag, packageVersion) {
  if (!tag.startsWith("v")) {
    throw new Error(`Release tag "${tag}" must start with "v" (vX.Y.Z or vX.Y.Z-beta.N).`);
  }
  const version = tag.slice(1);
  const channel = channelForVersion(version);
  if (channel == null) {
    throw new Error(
      `Unsupported release tag "${tag}". Use vX.Y.Z (stable) or vX.Y.Z-beta.N (beta).`,
    );
  }
  if (version !== packageVersion) {
    throw new Error(
      `Tag ${tag} does not match apps/desktop/package.json version "${packageVersion}". ` +
        `Set "version": "${version}" (it is written into the update metadata) and tag again.`,
    );
  }
  return releaseInfo(version, channel);
}

/**
 * Channel for a non-tag run (pull request dry run): "-beta.N" means beta, anything
 * else is treated as stable ("latest" metadata).
 * @param {string} packageVersion
 */
export function resolveVersionRelease(packageVersion) {
  return releaseInfo(packageVersion, BETA_VERSION.test(packageVersion) ? "beta" : "stable");
}

/** @param {ReturnType<typeof releaseInfo>} release */
export function toOutputLines(release) {
  return [
    `version=${release.version}`,
    `channel=${release.channel}`,
    `update_channel=${release.updateChannel}`,
    `prerelease=${release.prerelease}`,
    `mac_metadata=${release.metadataFiles.mac}`,
    `windows_metadata=${release.metadataFiles.windows}`,
    `linux_metadata=${release.metadataFiles.linux}`,
  ];
}

function readPackageVersion(arg) {
  if (arg) return arg;
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return pkg.version;
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "tag") {
    const [tag, version] = rest;
    if (!tag) throw new Error("usage: release-channel.mjs tag <tag> [package version]");
    return resolveTagRelease(tag, readPackageVersion(version));
  }
  if (mode === "version") {
    return resolveVersionRelease(readPackageVersion(rest[0]));
  }
  throw new Error("usage: release-channel.mjs <tag|version> ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(toOutputLines(main(process.argv.slice(2))).join("\n"));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
