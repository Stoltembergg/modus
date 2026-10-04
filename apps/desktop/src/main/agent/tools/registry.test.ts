import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PLAN_TOOL_UI, type ToolCatalogEntry } from "../../../shared/tools";
import { recognizeCheckInvocation } from "../harness/qa-evidence";
import { registerBrowserTools } from "./browser-tools";
import { classifyShellCommand, getToolTarget, ToolRegistry, toolRegistry } from "./registry";
import { registerTerminalTools } from "./terminal-tools";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/task4-registry-unused" } }));

function toolEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: "tool_call", toolCallId: "t1", toolName, input } as ToolCallEvent;
}

describe("ToolRegistry profiles", () => {
  it("chat profile activates all seven builtin tools", () => {
    const registry = new ToolRegistry();
    expect(new Set(registry.resolveActiveTools("chat"))).toEqual(
      new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]),
    );
  });

  it("review profile activates only read-only tools", () => {
    const registry = new ToolRegistry();
    expect(new Set(registry.resolveActiveTools("review"))).toEqual(
      new Set(["read", "grep", "find", "ls"]),
    );
  });

  it("plan profile activates the read-only research tools (no edit/write/bash)", () => {
    const registry = new ToolRegistry();
    expect(new Set(registry.resolveActiveTools("plan"))).toEqual(
      new Set(["read", "grep", "find", "ls"]),
    );
  });

  it("flows a plan-profile custom tool (plan_write) into the active set and customTools", () => {
    // Mirrors how plan_write is registered: a custom tool scoped to the plan
    // profile must appear in plan's active names AND its custom definitions, so
    // the session's customTools include it and setActiveToolsByName can enable it.
    const registry = new ToolRegistry();
    const definition = { name: "plan_write" } as never;
    registry.registerTool({
      entry: {
        name: "plan_write",
        profiles: ["plan"],
        permission: { danger: "safe" },
        ui: PLAN_TOOL_UI,
      },
      definition,
    });
    expect(registry.resolveActiveTools("plan")).toContain("plan_write");
    expect(registry.getCustomToolDefinitions("plan")).toContain(definition);
    // And it must NOT leak into chat (so build mode stays full-tools, plan-only stays plan-only).
    expect(registry.resolveActiveTools("chat")).not.toContain("plan_write");
  });

  it("overrides enable and disable adjust the active set", () => {
    const registry = new ToolRegistry();
    expect(registry.resolveActiveTools("review", { disable: ["grep"] })).not.toContain("grep");
    expect(registry.resolveActiveTools("review", { enable: ["bash"] })).toContain("bash");
  });
});

describe("ToolRegistry custom tools", () => {
  it("flows a registered custom tool into activation and customTools", () => {
    const registry = new ToolRegistry();
    const entry: Omit<ToolCatalogEntry, "kind"> = {
      name: "demo",
      profiles: ["chat"],
      permission: { danger: "safe" },
      ui: { verb: "Demo" },
    };
    const definition = { name: "demo" } as never;
    registry.registerTool({ entry, definition });

    expect(registry.resolveActiveTools("chat")).toContain("demo");
    expect(registry.getCustomToolDefinitions("chat")).toContain(definition);
    expect(registry.resolveActiveTools("review")).not.toContain("demo");
    expect(registry.getCustomToolDefinitions("review")).not.toContain(definition);
  });

  it("applies a custom dynamic classifier for a registered tool", () => {
    const registry = new ToolRegistry();
    registry.registerTool({
      entry: {
        name: "deploy",
        profiles: ["chat"],
        permission: { danger: "dynamic" },
        ui: { verb: "Deployed" },
      },
      definition: { name: "deploy" } as never,
      classify: () => ({ action: "external.open", dangerous: true }),
    });
    expect(registry.classify(toolEvent("deploy", {}))).toEqual({
      action: "external.open",
      dangerous: true,
    });
  });
});

describe("ToolRegistry classify", () => {
  it("fails closed for unregistered and stale MCP-prefixed tool names", () => {
    const registry = new ToolRegistry();
    const staleName = "mcp_docs_search_allowlisted";
    registry.registerTool({
      entry: {
        name: staleName,
        profiles: ["chat", "plan"],
        permission: { danger: "safe" },
        capabilities: ["read"],
        ui: { verb: "Search" },
      },
      definition: { name: staleName } as never,
    });
    registry.unregisterTool(staleName);

    expect(registry.classify(toolEvent(staleName, {}))).toEqual({
      action: "mcp.call",
      dangerous: true,
    });
    expect(registry.classify(toolEvent("mcp_unregistered_lookup", {}))).toEqual({
      action: "mcp.call",
      dangerous: true,
    });
  });

  it("fails closed for stale or unregistered MCP tool names", () => {
    const registry = new ToolRegistry();
    const staleName = "mcp_stale_search_allowlisted";
    registry.registerTool({
      entry: {
        name: staleName,
        profiles: ["chat", "plan"],
        permission: { danger: "safe" },
        capabilities: ["read"],
        ui: { verb: "Search" },
      },
      definition: { name: staleName } as never,
    });
    registry.unregisterTool(staleName);

    expect(registry.classify(toolEvent(staleName, {}))).toEqual({
      action: "mcp.call",
      dangerous: true,
    });
    expect(registry.classify(toolEvent("mcp_stale_search_dangerous", {}))).toEqual({
      action: "mcp.call",
      dangerous: true,
    });
  });

  it.each([
    "npm test",
    "npm --workspace @modus/desktop run typecheck",
    "npm test; node scripts/mutate.js",
    "npm --workspace @modus/desktop run typecheck; node scripts/mutate.js",
    "pnpm test",
    "pnpm test; node scripts/mutate.js",
    "yarn test",
    "yarn test; node scripts/mutate.js",
    "pnpm --filter @modus/desktop run typecheck",
    "yarn workspace @modus/desktop run typecheck",
    "npx vitest $(node scripts/mutate.js) run",
    "npx vitest run $(node scripts/mutate.js)",
    "npx vitest run $TEST_ARGS",
    "npx vitest run `node scripts/mutate.js`",
    "npx vitest run; node scripts/mutate.js",
    "npx vitest run && node scripts/mutate.js",
    "npx vitest run",
  ])("requires shell.execute approval for QA command %s through bash and terminal_run", (command) => {
    registerTerminalTools();
    const registry = new ToolRegistry();
    registry.registerTool({
      entry: {
        name: "terminal_run",
        profiles: ["chat"],
        permission: { danger: "dynamic" },
        ui: { verb: "Terminal" },
      },
      definition: { name: "terminal_run" } as never,
      classify: (event) => classifyShellCommand(getToolTarget(event)),
    });

    expect(registry.classify(toolEvent("bash", { command }))).toEqual({
      action: "shell.execute",
      dangerous: true,
    });
    expect(registry.classify(toolEvent("terminal_run", { command }))).toEqual({
      action: "shell.execute",
      dangerous: true,
    });
    expect(toolRegistry.classify(toolEvent("terminal_run", { command }))).toEqual({
      action: "shell.execute",
      dangerous: true,
    });
    if (
      command.includes("$") ||
      command.includes("`") ||
      command.includes(";") ||
      command.includes("&&")
    ) {
      expect(recognizeCheckInvocation("bash", command)).toBeUndefined();
    }
  });

  it.each([
    "echo npm test",
    "printf 'vitest'",
    '"npm test"',
  ])("leaves a harmless mention command safe: %s", (command) => {
    registerTerminalTools();
    expect(classifyShellCommand(command)).toEqual({ action: "shell.execute", dangerous: false });
    expect(new ToolRegistry().classify(toolEvent("bash", { command })).dangerous).toBe(false);
    expect(toolRegistry.classify(toolEvent("terminal_run", { command })).dangerous).toBe(false);
  });

  it("treats bash git-write commands as dangerous git.write", () => {
    const registry = new ToolRegistry();
    expect(registry.classify(toolEvent("bash", { command: "git commit -m wip" }))).toEqual({
      action: "git.write",
      dangerous: true,
    });
  });

  it("treats bash mutating commands as dangerous shell.execute", () => {
    const registry = new ToolRegistry();
    expect(registry.classify(toolEvent("bash", { command: "rm -rf build" }))).toEqual({
      action: "shell.execute",
      dangerous: true,
    });
  });

  it("treats plain bash commands as safe shell.execute", () => {
    const registry = new ToolRegistry();
    expect(registry.classify(toolEvent("bash", { command: "ls -la" }))).toEqual({
      action: "shell.execute",
      dangerous: false,
    });
  });

  it("treats write and edit as dangerous file.write", () => {
    const registry = new ToolRegistry();
    expect(registry.classify(toolEvent("write", { path: "a.txt" }))).toEqual({
      action: "file.write",
      dangerous: true,
    });
    expect(registry.classify(toolEvent("edit", { path: "a.txt" }))).toEqual({
      action: "file.write",
      dangerous: true,
    });
  });

  it("treats read-only builtins as safe", () => {
    const registry = new ToolRegistry();
    for (const name of ["read", "grep", "find", "ls"]) {
      expect(registry.classify(toolEvent(name, { path: "." })).dangerous).toBe(false);
    }
  });

  it("keeps the legacy delete/remove heuristic for unregistered tools", () => {
    const registry = new ToolRegistry();
    expect(registry.classify(toolEvent("delete_file", { path: "a.txt" }))).toEqual({
      action: "file.delete",
      dangerous: true,
    });
    expect(registry.classify(toolEvent("unknown_tool", {})).dangerous).toBe(false);
  });
});

describe("Browser tool permissions", () => {
  it("registers low-level browser primitives with read-only and control gating", () => {
    registerBrowserTools();

    expect(toolRegistry.getEntry("browser_tabs")).toBeDefined();
    expect(toolRegistry.getEntry("browser_cdp")).toBeDefined();
    expect(toolRegistry.getEntry("browser_click")).toBeUndefined();
    expect(toolRegistry.classify(toolEvent("browser_events", {}))).toEqual({
      action: "browser.control",
      dangerous: false,
    });
    expect(toolRegistry.classify(toolEvent("browser_snapshot", {}))).toEqual({
      action: "browser.control",
      dangerous: false,
    });
    expect(toolRegistry.classify(toolEvent("browser_screenshot", {}))).toEqual({
      action: "browser.control",
      dangerous: false,
    });
    expect(toolRegistry.classify(toolEvent("browser_tabs", { action: "list" }))).toEqual({
      action: "browser.control",
      dangerous: false,
    });
    expect(toolRegistry.classify(toolEvent("browser_cdp", { method: "Page.navigate" }))).toEqual({
      action: "browser.control",
      dangerous: true,
    });
    expect(toolRegistry.classify(toolEvent("browser_tabs", { action: "new" }))).toEqual({
      action: "browser.control",
      dangerous: true,
    });
  });
});

it("registers bounded group context as read-only and progress as a write", async () => {
  const { registerGroupTools } = await import("./group-tools");
  registerGroupTools();
  expect(toolRegistry.resolveActiveTools("plan")).toContain("group_get_work_state");
  expect(toolRegistry.resolveActiveTools("plan")).not.toContain("group_report_progress");
  expect(toolRegistry.resolveActiveTools("chat")).toContain("group_report_progress");
  expect(toolRegistry.getEntry("group_get_work_state")).toMatchObject({
    readOnly: true,
    capabilities: ["read"],
  });
  expect(
    getToolTarget(
      toolEvent("group_report_progress", { taskId: "selected-task", expectedVersion: 2 }),
    ),
  ).toBe("selected-task");
});
