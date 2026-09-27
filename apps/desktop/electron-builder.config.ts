import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Configuration } from "electron-builder";
import { RELEASE_REPO } from "./src/shared/release-repo";

const fastCodebaseResource = join("resources", "bin", "codegraph");

/** Sidecar name matches `terminal-service` resolution (`.exe` only on Windows). */
const ptyHostBinary = process.platform === "win32" ? "modus-pty-host.exe" : "modus-pty-host";

/**
 * Update channel for this build: "-beta.N" versions => beta (beta*.yml), everything
 * else => latest (latest*.yml). electron-builder 26 does not derive this from the
 * version for the GitHub provider (a beta build would otherwise write latest*.yml and
 * be offered to stable users). Kept in sync with scripts/release/release-channel.mjs.
 * electron-builder runs with apps/desktop as cwd, like the relative paths below.
 */
const appVersion: string = JSON.parse(readFileSync("package.json", "utf8")).version;
const updateChannel = /-beta\.(0|[1-9]\d*)$/.test(appVersion) ? "beta" : "latest";

const config: Configuration = {
  appId: "dev.modus.desktop",
  productName: "Modus",
  electronVersion: "42.3.0",
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "package.json"],
  extraResources: [
    {
      from: "resources/icon.png",
      to: "icon.png",
    },
    {
      from: "resources/skills",
      to: "skills",
    },
    {
      from: "resources/licenses",
      to: "licenses",
    },
    {
      from: `../../target/release/${ptyHostBinary}`,
      to: `bin/${ptyHostBinary}`,
    },
    ...(existsSync(fastCodebaseResource)
      ? [
          {
            from: fastCodebaseResource,
            to: "bin/codegraph",
          },
        ]
      : []),
  ],
  asar: true,
  icon: "resources/icon.png",
  /**
   * Release metadata target. Configuring a provider is what makes electron-builder
   * write the update metadata files (latest*.yml / beta*.yml) and embed
   * app-update.yml in the app. Builds always run with `--publish never`; the release
   * workflow uploads the files itself into a draft it created beforehand.
   *
   * electron-builder is pinned to 26.8.1 (apps/desktop/package.json). Stay below v28:
   * from v28 the NSIS updater fails closed on unsigned builds, and the Windows build
   * is not Authenticode-signed yet. See docs/releasing.md.
   *
   * electron-updater (runtime dependency) is pinned to 6.8.3: the release published
   * together with electron-builder 26.8.x, sharing builder-util-runtime 9.5.1. Upgrade
   * the two in step. 6.8.3's NsisUpdater.verifySignature skips verification when
   * app-update.yml has no publisherName, which is the case for unsigned builds.
   */
  publish: {
    provider: "github",
    // Shared with the in-app updater's URL allowlist (src/main/updater/update-policy.ts).
    owner: RELEASE_REPO.owner,
    repo: RELEASE_REPO.repo,
    releaseType: "draft",
    channel: updateChannel,
  },
  mac: {
    category: "public.app-category.developer-tools",
    icon: "resources/icon.icns",
    target: ["dmg", "zip"],
    // Ad-hoc signature ("-") for both arches. There is no Developer ID certificate yet.
    // Without an identity electron-builder 26 only falls back to ad-hoc on arm64 and
    // leaves x64 unsigned; the release workflow's `codesign --verify --deep --strict`
    // needs a valid (ad-hoc) signature on x64 too. Replace with the Developer ID name
    // once there is one (CSC_NAME does not override an explicit identity).
    identity: "-",
    // Arch in every name so the arm64 and x64 jobs never upload colliding assets.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder artifact macros
    artifactName: "${productName}-${version}-mac-${arch}.${ext}",
  },
  win: {
    icon: "resources/icon.ico",
    target: ["nsis"],
    signAndEditExecutable: false,
  },
  nsis: {
    // No spaces: GitHub rewrites spaces in asset names, which would break latest.yml.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder artifact macros
    artifactName: "${productName}-${version}-win-${arch}-setup.${ext}",
  },
  linux: {
    category: "Development",
    icon: "resources/icon.png",
    target: ["AppImage", "deb"],
    // Required by the deb target (fpm). No contact email is published for the project.
    maintainer: "Modus contributors",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder artifact macros
    artifactName: "${productName}-${version}-linux-${arch}.${ext}",
  },
};

export default config;
