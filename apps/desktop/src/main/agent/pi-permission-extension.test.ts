import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
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
