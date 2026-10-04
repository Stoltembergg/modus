import { resolve } from "node:path";
import { shellCommandArgs } from "./terminal-output";

export type ControlledNpmCheck = {
  script: "test" | "typecheck" | "lint" | "build";
  workspace?: "@modus/desktop";
};

/** Shared grammar for the terminal execution boundary and package QA recognition. */
export function parseControlledNpmCheck(command: string): ControlledNpmCheck | undefined {
  if (/[$`*?[\]{}()~'";&|<>\n\r]/.test(command)) return undefined;
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "npm") return undefined;
  let cursor = 1;
  let workspace: string | undefined;
  const option = tokens[cursor];
  if (option === "--workspace" || option === "-w") {
    workspace = tokens[cursor + 1];
    cursor += 2;
  } else if (option?.startsWith("--workspace=") || option?.startsWith("-w=")) {
    workspace = option.slice(option.indexOf("=") + 1);
    cursor += 1;
  }
  if (cursor > 1 && workspace !== "@modus/desktop") return undefined;
  if (tokens[cursor] === "run") cursor += 1;
  const script = tokens[cursor];
  if (
    tokens.length !== cursor + 1 ||
    (script !== "test" && script !== "typecheck" && script !== "lint" && script !== "build")
  ) {
    return undefined;
  }
  return { script, ...(workspace ? { workspace: "@modus/desktop" as const } : {}) };
}

/** Windows package QA is closed until its absolute script shell policy is verified. */
export function controlledNpmScriptShell(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return platform === "win32" ? undefined : "/bin/sh";
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * CLI has precedence over project/user/global npmrc and inherited npm_config_*.
 * Empty workspace env values are ignored by npm, so they cannot clear selection.
 * Root checks reject hidden workspace selection with --workspaces=false; explicit
 * CLI workspace selection replaces lower-priority arrays and excludes the root.
 */
export function controlledAgentCommand(
  command: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const invocation = parseControlledNpmCheck(command);
  const scriptShell = controlledNpmScriptShell(platform);
  if (!invocation || !scriptShell) return command;
  const options = [
    `--prefix=${quotePosix(resolve(cwd))}`,
    "--global=false",
    `--script-shell=${quotePosix(scriptShell)}`,
    ...(invocation.workspace
      ? [
          "--workspaces=true",
          "--include-workspace-root=false",
          `--workspace=${invocation.workspace}`,
        ]
      : ["--workspaces=false"]),
  ];
  return `npm ${options.join(" ")} run ${invocation.script}`;
}

export function agentCommandExecution(
  command: string,
  cwd: string,
  defaultShell: string,
): { shell: string; args: string[] } {
  const executionCommand = controlledAgentCommand(command, cwd);
  // The controlled boundary uses POSIX quoting and bypasses login profiles.
  return executionCommand !== command
    ? { shell: "/bin/sh", args: ["-c", executionCommand] }
    : { shell: defaultShell, args: shellCommandArgs(defaultShell, command, { utf8: true }) };
}
