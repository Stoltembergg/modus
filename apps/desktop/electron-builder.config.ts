import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Configuration } from "electron-builder";

const fastCodebaseResource = join("resources", "bin", "codegraph");

/** Sidecar name matches `terminal-service` resolution (`.exe` only on Windows). */
const ptyHostBinary = process.platform === "win32" ? "modus-pty-host.exe" : "modus-pty-host";

const config: Configuration = {
  appId: "dev.modus.desktop",
  productName: "Modus",
  electronVersion: "42.3.0",
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  compression: "store",
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
  mac: {
    category: "public.app-category.developer-tools",
    icon: "resources/icon.icns",
    target: ["dmg", "zip"],
  },
  win: {
    icon: "resources/icon.ico",
    target: ["nsis"],
    signAndEditExecutable: false,
  },
  linux: {
    category: "Development",
    icon: "resources/icon.png",
    target: ["AppImage", "deb"],
  },
};

export default config;
