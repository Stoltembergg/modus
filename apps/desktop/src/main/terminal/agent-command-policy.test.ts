import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentCommandExecution,
  controlledAgentCommand,
  controlledNpmScriptShell,
  parseControlledNpmCheck,
} from "./agent-command-policy";

describe("controlled npm grammar", () => {
  it.each([
    "npm test",
    "npm run test",
    "npm run typecheck",
    "npm run lint",
    "npm run build",
  ])("pins the exact root check %s", (command) => {
    expect(parseControlledNpmCheck(command)).toBeDefined();
    expect(controlledAgentCommand(command, "/project", "linux")).toContain("--workspaces=false");
  });
  it.each([
    "--workspace @modus/desktop",
    "-w @modus/desktop",
    "--workspace=@modus/desktop",
    "-w=@modus/desktop",
  ])("pins only the allowlisted workspace %s", (option) => {
    const command = `npm ${option} run typecheck`;
    expect(parseControlledNpmCheck(command)).toEqual({
      script: "typecheck",
      workspace: "@modus/desktop",
    });
    expect(controlledAgentCommand(command, "/project", "linux")).toContain(
      "--workspaces=true --include-workspace-root=false --workspace=@modus/desktop",
    );
  });
  it.each([
    "npm --script-shell=/bin/true test",
    "npm --workspaces test",
    "npm --prefix=/other test",
    "npm --workspace @other/package test",
    "npm --workspace @modus/desktop -w @modus/desktop test",
    "npm test -- --run",
    "npm test && echo yes",
    "NPM TEST",
    "pnpm test",
    "yarn test",
  ])("leaves unsupported input uncertified: %s", (command) => {
    expect(parseControlledNpmCheck(command)).toBeUndefined();
    expect(controlledAgentCommand(command, "/project", "linux")).toBe(command);
  });
  it("closes package QA on Windows and keeps direct commands unchanged", () => {
    expect(controlledNpmScriptShell("win32")).toBeUndefined();
    expect(controlledAgentCommand("npm test", "C:\\project", "win32")).toBe("npm test");
    expect(controlledAgentCommand("vitest run", "/project", "linux")).toBe("vitest run");
  });
  it.skipIf(process.platform === "win32")(
    "pins the outer shell and bypasses login/custom shell profiles",
    () => {
      const command = "npm --workspace @modus/desktop test";
      expect(agentCommandExecution(command, "/project", "custom-shell")).toEqual({
        shell: "/bin/sh",
        args: ["-c", controlledAgentCommand(command, "/project")],
      });
      expect(agentCommandExecution("vitest run", "/project", "/bin/bash")).toEqual({
        shell: "/bin/bash",
        args: ["-lc", "vitest run"],
      });
    },
  );
});

// These fixtures inspect npm configuration and package script fields without
// running any lifecycle. /bin/true is only a configuration input.
describe.skipIf(process.platform === "win32")("safe npm execution policy", () => {
  const withFixture = (run: (cwd: string, env: NodeJS.ProcessEnv, root: string) => void): void => {
    const root = mkdtempSync(join(tmpdir(), "modus-npm-config-"));
    const cwd = join(root, "project with ' quotes");
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
    );
    try {
      mkdirSync(join(cwd, "apps", "desktop"), { recursive: true });
      mkdirSync(join(cwd, "apps", "other"), { recursive: true });
      mkdirSync(join(root, "alternate"));
      const manifest = (name: string, marker: string) =>
        JSON.stringify({ name, scripts: { test: `node -e "console.log('${marker}')"` } });
      writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({
          name: "root",
          workspaces: ["apps/*"],
          scripts: { test: "node -e \"console.log('ROOT_SAFE')\"" },
        }),
      );
      writeFileSync(
        join(cwd, "apps", "desktop", "package.json"),
        manifest("@modus/desktop", "DESKTOP_SAFE"),
      );
      writeFileSync(
        join(cwd, "apps", "other", "package.json"),
        manifest("@other/package", "OTHER_SAFE"),
      );
      writeFileSync(
        join(root, "alternate", "package.json"),
        manifest("alternate", "ALTERNATE_SAFE"),
      );
      env.npm_config_userconfig = join(root, "user.npmrc");
      env.npm_config_globalconfig = join(root, "global.npmrc");
      writeFileSync(env.npm_config_userconfig, "");
      writeFileSync(env.npm_config_globalconfig, "");
      run(cwd, env, root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const inspect = (
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    query = "pkg get scripts.test",
  ) => {
    const normalized = controlledAgentCommand(command, cwd);
    expect(normalized).toContain("--script-shell='/bin/sh'");
    expect(normalized).toContain("--global=false");
    const execution = agentCommandExecution(command, cwd, "unused-custom-shell");
    expect(execution).toEqual({ shell: "/bin/sh", args: ["-c", normalized] });
    // Replace only the lifecycle verb for a read-only probe of the actual flags.
    return spawnSync(execution.shell, ["-c", normalized.replace(/run test$/, query)], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
  };
  it.each([
    "project",
    "user",
    "global",
    "env",
    "combined",
  ])("reports the pinned effective script-shell over %s config without lifecycle execution", (source) => {
    withFixture((cwd, env, root) => {
      const config = "script-shell=/bin/true\n";
      if (source === "project" || source === "combined") writeFileSync(join(cwd, ".npmrc"), config);
      if (source === "user" || source === "combined")
        writeFileSync(join(root, "user.npmrc"), config);
      if (source === "global" || source === "combined")
        writeFileSync(join(root, "global.npmrc"), config);
      if (source === "env" || source === "combined") {
        env.npm_config_script_shell = "/bin/true";
        env.NPM_CONFIG_SCRIPT_SHELL = "/bin/true";
      }
      const result = inspect("npm test", cwd, env, "config get script-shell");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("/bin/sh");
    });
  }, 30_000);
  it("exposes the unsafe configuration through read-only probes before applying policy", () => {
    withFixture((cwd, env) => {
      writeFileSync(join(cwd, ".npmrc"), "script-shell=/bin/true\n");
      const shell = spawnSync("npm", ["config", "get", "script-shell"], {
        cwd,
        env,
        encoding: "utf8",
      });
      expect(shell.status, shell.stderr).toBe(0);
      expect(shell.stdout.trim()).toBe("/bin/true");
      writeFileSync(
        join(cwd, ".npmrc"),
        "workspace[]=@other/package\ninclude-workspace-root=true\n",
      );
      const selection = spawnSync("npm", ["pkg", "get", "scripts.test"], {
        cwd,
        env,
        encoding: "utf8",
      });
      expect(selection.status, selection.stderr).toBe(0);
      expect(selection.stdout).toContain("OTHER_SAFE");
      expect(selection.stdout).toContain("ROOT_SAFE");
      expect(selection.stdout).not.toContain("DESKTOP_SAFE");
      const protectedSelection = inspect("npm --workspace @modus/desktop test", cwd, env);
      expect(protectedSelection.status, protectedSelection.stderr).toBe(0);
      expect(protectedSelection.stdout).toContain("DESKTOP_SAFE");
      expect(protectedSelection.stdout).not.toMatch(/ROOT_SAFE|OTHER_SAFE/);
    });
  });
  it("shows npx is outside the policy while inherited script-shell config remains effective", () => {
    withFixture((cwd, env) => {
      writeFileSync(join(cwd, ".npmrc"), "script-shell=/bin/true\n");
      env.npm_config_script_shell = "/bin/true";
      env.NPM_CONFIG_SCRIPT_SHELL = "/bin/true";
      const result = spawnSync("npm", ["config", "get", "script-shell"], {
        cwd,
        env,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("/bin/true");
      // Do not execute npx: npm exec consumes this same effective config.
      expect(parseControlledNpmCheck("npx vitest run")).toBeUndefined();
      expect(controlledAgentCommand("npx vitest run", cwd)).toBe("npx vitest run");
    });
  });
  it.each([
    "project",
    "user",
    "global",
    "env",
    "combined",
  ])("overrides %s shell, implicit workspace, root inclusion and prefix config for explicit selection", (source) => {
    withFixture((cwd, env, root) => {
      const config = `script-shell=/bin/true\nworkspace[]=@other/package\nworkspaces=true\ninclude-workspace-root=true\nprefix=${join(root, "alternate")}\nglobal=true\n`;
      if (source === "project" || source === "combined") writeFileSync(join(cwd, ".npmrc"), config);
      if (source === "user" || source === "combined")
        writeFileSync(join(root, "user.npmrc"), config);
      if (source === "global" || source === "combined")
        writeFileSync(join(root, "global.npmrc"), config);
      if (source === "env" || source === "combined")
        Object.assign(env, {
          npm_config_script_shell: "/bin/true",
          NPM_CONFIG_SCRIPT_SHELL: "/bin/true",
          npm_config_workspace: "@other/package",
          NPM_CONFIG_WORKSPACE: "@other/package",
          npm_config_workspaces: "true",
          npm_config_include_workspace_root: "true",
          npm_config_prefix: join(root, "alternate"),
          npm_config_global: "true",
        });
      // Workspace-local config also cannot redirect the selected script.
      writeFileSync(join(cwd, "apps", "desktop", ".npmrc"), config);
      const result = inspect("npm --workspace @modus/desktop test", cwd, env);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("DESKTOP_SAFE");
      expect(result.stdout).not.toMatch(/ROOT_SAFE|OTHER_SAFE|ALTERNATE_SAFE/);
    });
  }, 30_000);
  it("selects only the root when shell and workspaces=true config are inherited", () => {
    withFixture((cwd, env) => {
      writeFileSync(
        join(cwd, ".npmrc"),
        "script-shell=/bin/true\nworkspaces=true\ninclude-workspace-root=true\n",
      );
      env.npm_config_script_shell = "/bin/true";
      env.npm_config_workspaces = "true";
      const result = inspect("npm test", cwd, env);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("ROOT_SAFE");
      expect(result.stdout).not.toMatch(/DESKTOP_SAFE|OTHER_SAFE/);
    });
  });
  it.each([
    "project",
    "env",
  ])("fails closed on hidden %s workspace selection for a root check", (source) => {
    withFixture((cwd, env) => {
      if (source === "project") writeFileSync(join(cwd, ".npmrc"), "workspace[]=@other/package\n");
      else env.npm_config_workspace = "@other/package";
      const result = inspect("npm test", cwd, env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/--no-workspaces.*--workspace.*same time/i);
      expect(result.stdout).not.toMatch(/ROOT_SAFE|DESKTOP_SAFE|OTHER_SAFE/);
    });
  });
});
