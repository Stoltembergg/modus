import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

type ResolveOptions = {
  resourcesPath?: string;
  cwd?: string;
  moduleDirectory?: string;
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
};

export function resolveReaSupervisorPath(options: ResolveOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const binaryName =
    platform === "win32" ? "modus-rea-process-supervisor.exe" : "modus-rea-process-supervisor";
  const cwd = options.cwd ?? process.cwd();
  const moduleDirectory = options.moduleDirectory ?? dirname(fileURLToPath(import.meta.url));
  const resourcesPath =
    options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const isPackaged = options.isPackaged ?? app?.isPackaged ?? false;
  const candidates = isPackaged
    ? [resourcesPath ? join(resourcesPath, "bin", binaryName) : undefined].filter(
        (candidate): candidate is string => Boolean(candidate),
      )
    : [
        resourcesPath ? join(resourcesPath, "bin", binaryName) : undefined,
        resolve(cwd, "target", "release", binaryName),
        resolve(cwd, "..", "..", "target", "release", binaryName),
        resolve(moduleDirectory, "../../../../../target/release", binaryName),
      ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Modus REA process supervisor was not found. Build it with cargo build --release -p modus-rea-process-supervisor. Checked: ${candidates.join(", ")}`,
    );
  }
  return found;
}
