import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Node range supported by the pinned `rea-agents@6.5.0` package (its `engines.node`). */
export const REA_SUPPORTED_NODE_RANGE = "^22.19.0 || ^24.11.0 || >=26.0.0";

const PREREQUISITE_TIMEOUT_MS = 10_000;

/** Shown in REA status and returned to the agent when Node.js is present but npm is not. */
export const REA_NPM_NOT_FOUND_NOTE = `REA could not find npm on the PATH Modus uses (Node.js was found). REA installs its pinned package with npm, so install npm (it ships with Node.js ${REA_SUPPORTED_NODE_RANGE}) and restart Modus. On macOS, apps opened from the Dock may not see Homebrew or nvm paths.`;

export type ReaPrerequisiteResult =
  | { ok: true }
  | { ok: false; status: "needs_node"; note: string };

export type ReaCommandRunner = (command: string, args: string[]) => Promise<string>;

/**
 * Accepts only `^22.19.0 || ^24.11.0 || >=26.0.0`: 22.19+, 24.11+, or 26+.
 * Odd majors (23, 25) and older minors are unsupported, matching the pinned package.
 */
export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 22) return minor >= 19;
  if (major === 24) return minor >= 11;
  return major >= 26;
}

/** Keeps only the leading version token so an error string can never leak a path. */
function versionToken(output: string): string {
  const match = /^v?\d+(?:\.\d+){0,2}/.exec(output.trim());
  return match ? match[0] : "unknown";
}

function defaultRunCommand(platform: NodeJS.Platform): ReaCommandRunner {
  return (command, args) => {
    const options = {
      timeout: PREREQUISITE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: process.env,
    };
    // `npm` is a `.cmd` shim on Windows, so on win32 both commands are invoked through
    // `cmd.exe`, matching the supervisor's `npm ci` launch path.
    const invocation =
      platform === "win32"
        ? execFileAsync("cmd", ["/d", "/s", "/c", `${command} ${args.join(" ")}`], options)
        : execFileAsync(command, args, options);
    return invocation.then((result) => result.stdout);
  };
}

/**
 * Checks Node/npm availability and the pinned package's supported Node range before the
 * supervisor is launched, so a missing runtime is reported as `needs_node` without starting
 * any process. Never installs a runtime.
 */
export async function checkReaPrerequisites(
  options: { platform?: NodeJS.Platform; run?: ReaCommandRunner } = {},
): Promise<ReaPrerequisiteResult> {
  const run = options.run ?? defaultRunCommand(options.platform ?? process.platform);

  let nodeOutput: string;
  try {
    nodeOutput = await run("node", ["--version"]);
  } catch {
    return {
      ok: false,
      status: "needs_node",
      note: `REA needs Node.js ${REA_SUPPORTED_NODE_RANGE} and npm on PATH. Install Node.js and retry; Modus does not install a runtime.`,
    };
  }
  if (!isSupportedNodeVersion(nodeOutput)) {
    return {
      ok: false,
      status: "needs_node",
      note: `REA needs Node.js ${REA_SUPPORTED_NODE_RANGE}; found ${versionToken(nodeOutput)}. Install a supported Node.js and retry.`,
    };
  }

  try {
    // The supervisor installs REA with `npm ci` from its lockfile; `npx` is no longer used.
    await run("npm", ["--version"]);
  } catch {
    return { ok: false, status: "needs_node", note: REA_NPM_NOT_FOUND_NOTE };
  }

  return { ok: true };
}
