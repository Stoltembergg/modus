import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createModusPermissionExtension } from "./pi-permission-extension";

const permissionMocks = vi.hoisted(() => ({
  findWorkspaceAllowDecision: vi.fn(),
  getApprovalMode: vi.fn(() => "request-approval"),
  requestPermission: vi.fn(async () => ({ decision: "allow-once" })),
}));

vi.mock("../permissions/permission-store", () => ({
  findWorkspaceAllowDecision: permissionMocks.findWorkspaceAllowDecision,
  getApprovalMode: permissionMocks.getApprovalMode,
}));
vi.mock("../permissions/permission-broker", () => ({
  requestPermission: permissionMocks.requestPermission,
}));

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/modus-permission-extension-test" } }));

describe("Modus permission extension", () => {
  it("blocks unregistered tool calls before invoking permission prompts", async () => {
    permissionMocks.requestPermission.mockClear();
    let toolCallHandler: ((event: ToolCallEvent) => Promise<unknown>) | undefined;
    const extension = createModusPermissionExtension("permission-test-session", () => {});
    extension({
      on(event: string, handler: unknown) {
        if (event === "tool_call") {
          toolCallHandler = handler as (event: ToolCallEvent) => Promise<unknown>;
        }
      },
    } as never);

    expect(toolCallHandler).toBeDefined();
    const result = await toolCallHandler?.({
      type: "tool_call",
      toolCallId: "unregistered-call",
      toolName: "unregistered_test_tool",
      input: {},
    } as ToolCallEvent);

    expect(result).toMatchObject({ block: true });
    expect(permissionMocks.requestPermission).not.toHaveBeenCalled();
  });

  it("queries remembered approval by host workspace and exact tool identity", async () => {
    permissionMocks.findWorkspaceAllowDecision.mockReset().mockReturnValue({ id: "saved" });
    permissionMocks.requestPermission.mockClear();
    let toolCallHandler: ((event: ToolCallEvent) => Promise<unknown>) | undefined;
    const extension = createModusPermissionExtension(
      "permission-test-session",
      () => {},
      "/worktree/path",
      undefined,
      undefined,
      undefined,
      "workspace-a",
    );
    extension({
      on(event: string, handler: unknown) {
        if (event === "tool_call") {
          toolCallHandler = handler as (event: ToolCallEvent) => Promise<unknown>;
        }
      },
    } as never);

    const command = "rm -rf build-output";
    await toolCallHandler?.({
      type: "tool_call",
      toolCallId: "remembered-call",
      toolName: "bash",
      input: { command },
    } as ToolCallEvent);

    expect(permissionMocks.findWorkspaceAllowDecision).toHaveBeenCalledWith(
      "shell.execute",
      command,
      "workspace-a",
      "bash",
    );
    expect(permissionMocks.requestPermission).not.toHaveBeenCalled();
  });

  it("does not consume a remembered grant without a trusted workspace", async () => {
    permissionMocks.findWorkspaceAllowDecision.mockReset().mockReturnValue({ id: "saved" });
    permissionMocks.requestPermission.mockClear();
    let toolCallHandler: ((event: ToolCallEvent) => Promise<unknown>) | undefined;
    const extension = createModusPermissionExtension("permission-test-session", () => {});
    extension({
      on(event: string, handler: unknown) {
        if (event === "tool_call") {
          toolCallHandler = handler as (event: ToolCallEvent) => Promise<unknown>;
        }
      },
    } as never);

    await toolCallHandler?.({
      type: "tool_call",
      toolCallId: "no-workspace-call",
      toolName: "bash",
      input: { command: "rm -rf build-output" },
    } as ToolCallEvent);

    expect(permissionMocks.findWorkspaceAllowDecision).not.toHaveBeenCalled();
    expect(permissionMocks.requestPermission).toHaveBeenCalledOnce();
  });
});

describe("browser_cdp approval payload", () => {
  beforeAll(async () => {
    const { registerBrowserTools } = await import("./tools/browser-tools");
    registerBrowserTools();
  });
  function handlerFor() {
    let toolCallHandler: ((event: ToolCallEvent) => Promise<unknown>) | undefined;
    createModusPermissionExtension("cdp-session", () => {})({
      on(event: string, handler: unknown) {
        if (event === "tool_call") toolCallHandler = handler as typeof toolCallHandler;
      },
    } as never);
    return toolCallHandler as (event: ToolCallEvent) => Promise<unknown>;
  }
  const expression = "(() => {\n\tconst a = `x\u00e9`;\r\n  return document.title + a; })()";

  it("approves exactly the code that executes, with an app-written summary", async () => {
    permissionMocks.findWorkspaceAllowDecision.mockReset().mockReturnValue(undefined);
    permissionMocks.requestPermission.mockReset().mockResolvedValue({ decision: "allow-once" });
    const input = { method: "Runtime.evaluate", params: { expression }, viewId: "tab-2" };
    const result = await handlerFor()({
      type: "tool_call",
      toolCallId: "cdp-1",
      toolName: "browser_cdp",
      input,
    } as unknown as ToolCallEvent);
    expect(result).toBeUndefined();
    const sent = (permissionMocks.requestPermission.mock.calls[0] as unknown[])[0] as {
      summary: string;
      details: string;
    };
    expect(sent.summary).toBe("Run JavaScript in tab tab-2");
    // Byte-identical: approved details === expression handed to CDP.
    expect(Buffer.from(sent.details).equals(Buffer.from(input.params.expression))).toBe(true);
  });

  it("blocks the call if the code changes while the card is open", async () => {
    permissionMocks.findWorkspaceAllowDecision.mockReset().mockReturnValue(undefined);
    const input = { method: "Runtime.evaluate", params: { expression }, viewId: "tab-2" };
    permissionMocks.requestPermission.mockReset().mockImplementation(async () => {
      input.params.expression = "fetch('https://evil')";
      return { decision: "allow-once" };
    });
    const result = await handlerFor()({
      type: "tool_call",
      toolCallId: "cdp-2",
      toolName: "browser_cdp",
      input,
    } as unknown as ToolCallEvent);
    expect(result).toMatchObject({ block: true });
  });
});

describe("REA on a fresh install", () => {
  beforeAll(async () => {
    const { registerReaTools } = await import("./tools/rea-tools");
    registerReaTools();
  });

  it("is on by default and its calls run with no approval prompt in the default approval mode", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ReaSettingsStore } = await import("../mcp/rea-settings");
    const { DEFAULT_APPROVAL_MODE } = await import("../../shared/approval");
    const home = mkdtempSync(join(tmpdir(), "modus-rea-fresh-"));
    try {
      expect(new ReaSettingsStore(home).get()).toEqual({ enabled: true, settingsError: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }

    permissionMocks.getApprovalMode.mockReturnValue(DEFAULT_APPROVAL_MODE);
    permissionMocks.findWorkspaceAllowDecision.mockReset().mockReturnValue(undefined);
    permissionMocks.requestPermission.mockClear();
    let toolCallHandler: ((event: ToolCallEvent) => Promise<unknown>) | undefined;
    createModusPermissionExtension(
      "rea-fresh-session",
      () => {},
      "/worktree/path",
      undefined,
      undefined,
      undefined,
      "workspace-a",
    )({
      on(event: string, handler: unknown) {
        if (event === "tool_call") toolCallHandler = handler as typeof toolCallHandler;
      },
    } as never);

    for (const [toolName, input] of [
      ["rea_tools", { query: "pe" }],
      ["rea_call", { operation: "inspect_native_load_image", arguments: { path: "a.bin" } }],
    ] as const) {
      const result = await toolCallHandler?.({
        type: "tool_call",
        toolCallId: `${toolName}-1`,
        toolName,
        input,
      } as unknown as ToolCallEvent);
      expect(result).toBeUndefined();
    }
    expect(permissionMocks.requestPermission).not.toHaveBeenCalled();
  });
});
