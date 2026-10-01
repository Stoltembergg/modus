export type WindowChromeMode = "macos" | "windows-overlay" | "system";
export type WindowGlassMode = "native" | "solid";

export type WindowAppearance = {
  chrome: WindowChromeMode;
  glass: WindowGlassMode;
};

const WINDOWS_MICA_MINIMUM_BUILD = 22_621;

function windowsBuild(systemVersion: string): number | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(systemVersion.trim());
  if (!match) return undefined;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const build = Number(match[3]);
  if (![major, minor, build].every(Number.isSafeInteger)) return undefined;
  if (major > 10) return Number.MAX_SAFE_INTEGER;
  if (major !== 10 || minor !== 0) return undefined;
  return build;
}

/** Resolve only native effects supported by this Electron build and host OS. */
export function resolveWindowAppearance(platform: string, systemVersion: string): WindowAppearance {
  if (platform === "darwin") return { chrome: "macos", glass: "native" };

  if (platform === "win32" && (windowsBuild(systemVersion) ?? 0) >= WINDOWS_MICA_MINIMUM_BUILD) {
    return { chrome: "windows-overlay", glass: "native" };
  }

  return { chrome: "system", glass: "solid" };
}
