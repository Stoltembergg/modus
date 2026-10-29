import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Configuration } from "electron-builder";
import { RELEASE_REPO } from "./src/shared/release-repo";

const fastCodebaseResource = join("resources", "bin", "codegraph");

/** Sidecar name matches `terminal-service` resolution (`.exe` only on Windows). */
const ptyHostBinary = process.platform === "win32" ? "modus-pty-host.exe" : "modus-pty-host";
const reaSupervisorBinary =
  process.platform === "win32"
    ? "modus-rea-process-supervisor.exe"
    : "modus-rea-process-supervisor";

/**
 * Update channel for this build: "-beta.N" versions => beta (beta*.yml), everything
 * else => latest (latest*.yml). electron-builder 26 does not derive this from the
 * version for the GitHub provider (a beta build would otherwise write latest*.yml and
 * be offered to stable users). Kept in sync with scripts/release/release-channel.mjs.
 * electron-builder runs with apps/desktop as cwd, like the relative paths below.
 */
const appVersion: string = JSON.parse(readFileSync("package.json", "utf8")).version;
const updateChannel = /-beta\.(0|[1-9]\d*)$/.test(appVersion) ? "beta" : "latest";

/**
 * onnxruntime-node (local-models/, RERANK-03) ships every platform's binary in one
 * npm tarball (~290 MB). Each installer keeps only its own platform/arch. Packaging
 * always runs on the target OS (macOS x64 is cross-packaged on arm64, hence the
 * `${arch}` macro). Also dropped:
 * - darwin: libonnxruntime.1.30.0.dylib, a byte-identical copy of libonnxruntime.1.dylib
 *   (npm does not keep the symlink; the binding links @rpath/libonnxruntime.1.dylib).
 * - win32: DirectML.dll / dxcompiler.dll / dxil.dll, only used by the DirectML/WebGPU
 *   execution providers (delay-loaded); Modus runs the models on CPU.
 * 1.30 has no darwin x64 binary: Intel Macs ship none and fall back (all tools).
 * scripts/verify-packaged-onnxruntime.cjs checks the result in the Package workflows.
 */
const ORT_BIN = "**/node_modules/onnxruntime-node/bin/napi-v6";
// biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder file-pattern macro
const ARCH_MACRO = "${arch}";
const ORT_PLATFORMS = ["darwin", "linux", "win32"] as const;
const onnxRuntimeFiles = [
  ...ORT_PLATFORMS.filter((platform) => platform !== process.platform).map(
    (platform) => `!${ORT_BIN}/${platform}/**`,
  ),
  // `${arch}` is expanded by electron-builder, not by JS.
  `!${ORT_BIN}/${process.platform}/!(${ARCH_MACRO})/**`,
  `!${ORT_BIN}/darwin/*/libonnxruntime.*.*.*.dylib`,
  `!${ORT_BIN}/win32/*/{DirectML,dxcompiler,dxil}.dll`,
];

/**
 * After each pack: scripts/verify-packaged-onnxruntime.cjs checks that only this
 * target's onnxruntime-node binary is unpacked and, when the host can run the packed
 * Electron (same arch), that it loads and runs a graph under ELECTRON_RUN_AS_NODE
 * with no rebuild (N-API). Cross-arch packs (macOS x64 on an arm64 runner) run the
 * file checks only, under the build's Node. A failure fails the package build.
 */
const LINUX_EXECUTABLE = "modus";
const ELECTRON_ARCH = ["ia32", "x64", "armv7l", "arm64", "universal"] as const;
const afterPack: NonNullable<Configuration["afterPack"]> = async (context) => {
  const platform = context.electronPlatformName;
  const arch = ELECTRON_ARCH[context.arch] ?? String(context.arch);
  const product = context.packager.appInfo.productFilename;
  const resources =
    platform === "darwin"
      ? join(context.appOutDir, `${product}.app`, "Contents", "Resources")
      : join(context.appOutDir, "resources");
  const executable =
    platform === "darwin"
      ? join(context.appOutDir, `${product}.app`, "Contents", "MacOS", product)
      : platform === "win32"
        ? join(context.appOutDir, `${product}.exe`)
        : join(context.appOutDir, LINUX_EXECUTABLE);
  const script = join("scripts", "verify-packaged-onnxruntime.cjs");
  const sidecarsScript = join("scripts", "verify-packaged-sidecars.cjs");
  const sameHost = platform === process.platform && arch === process.arch;
  execFileSync(process.execPath, [sidecarsScript, resources, platform, arch], {
    stdio: "inherit",
  });
  execFileSync(sameHost ? executable : process.execPath, [script, resources, platform, arch], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
};

/** Logs exact installer sizes (bytes) so installer growth can be compared per OS. */
const afterAllArtifactBuild: NonNullable<Configuration["afterAllArtifactBuild"]> = async (
  result,
) => {
  for (const file of result.artifactPaths) {
    if (/\.(dmg|zip|exe|AppImage|deb)$/.test(file)) {
      console.log(`installer-size ${basename(file)} ${statSync(file).size}`);
    }
  }
  return [];
};

const config: Configuration = {
  appId: "dev.modus.desktop",
  productName: "Modus",
  // modus://auth/callback and modus://billing/return (main/deep-link). Info.plist on macOS,
  // MimeType x-scheme-handler on Linux; Windows registers at runtime (setAsDefaultProtocolClient).
  protocols: [{ name: "Modus", schemes: ["modus"] }],
  electronVersion: "44.5.1",
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "package.json", ...onnxRuntimeFiles],
  // Native addon + its shared library must be real files on disk (dlopen cannot read asar).
  asarUnpack: ["**/node_modules/onnxruntime-node/**"],
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
    // Repo-root LICENSE and third-party notices (Agent Elements) ship in every
    // package: Contents/Resources on macOS, resources\ on Windows, resources/ on Linux.
    {
      from: "../../LICENSE",
      to: "LICENSE",
    },
    {
      from: "../../THIRD_PARTY_NOTICES.md",
      to: "THIRD_PARTY_NOTICES.md",
    },
    {
      from: `../../target/release/${ptyHostBinary}`,
      to: `bin/${ptyHostBinary}`,
    },
    {
      from: `../../target/release/${reaSupervisorBinary}`,
      to: `bin/${reaSupervisorBinary}`,
    },
    ...(process.platform === "linux"
      ? [
          {
            from: "../../target/release/modus-plugin-execution-supervisor",
            to: "bin/modus-plugin-execution-supervisor",
          },
          {
            from: "../../target/release/modus-plugin-worker",
            to: "bin/modus-plugin-worker",
          },
        ]
      : []),
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
  afterPack,
  afterAllArtifactBuild,
  icon: "resources/icon.png",
  /**
   * Release metadata target. Configuring a provider is what makes electron-builder
   * write the update metadata files (latest*.yml / beta*.yml) and embed
   * app-update.yml in the app. Builds always run with `--publish never`; the release
   * workflow uploads the files itself into a draft it created beforehand.
   *
   * electron-builder is pinned to 26.15.3 (apps/desktop/package.json). Stay below v28:
   * from v28 the NSIS updater fails closed on unsigned builds, and the Windows build
   * is not Authenticode-signed yet. See docs/releasing.md.
   *
   * electron-updater (runtime dependency) is pinned to 6.8.9. Keep it aligned with the
   * electron-builder 26.15.x line; both depend on builder-util-runtime. 6.8.9's
   * NsisUpdater.verifySignature skips verification when
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
    // The scoped npm package name produces an invalid Linux executable name by default.
    executableName: LINUX_EXECUTABLE,
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
