import { describe, expect, it, vi } from "vitest";
import {
  type HostPluginExecutionTarget,
  PluginExecutionDispatcher,
} from "./plugin-execution-dispatcher";

const target: HostPluginExecutionTarget = Object.freeze({
  pluginId: "fixture/plugin",
  pluginVersion: "1.0.0",
  artifactSha256: "a".repeat(64),
  artifactOrigin: "fixture-host-catalog",
  trustLevel: "verified",
  generation: 1,
  capabilities: Object.freeze(["plugin.transform"]),
  hostGrantedCapabilities: Object.freeze(["memory.read"]),
});

const context = Object.freeze({
  sessionId: "fixture-session",
  workspaceId: "fixture-workspace",
  runId: "fixture-run",
});

describe("PluginExecutionDispatcher", () => {
  it("requires broker authorization before the supervisor receives an invocation", async () => {
    const authorize = vi.fn(async () => false);
    const execute = vi.fn(async () => ({ result: "must not run" }));
    const dispatcher = new PluginExecutionDispatcher({ authorize, execute });

    await expect(
      dispatcher.dispatch({
        target,
        context,
        capability: "plugin.transform",
        payload: { text: "synthetic" },
      }),
    ).rejects.toThrow("Plugin execution was denied by the host permission broker");

    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes host-owned provenance through the broker to the supervisor and returns its result", async () => {
    const authorize = vi.fn(async () => true);
    const execute = vi.fn(async () => ({ result: { text: "synthetic result" } }));
    const dispatcher = new PluginExecutionDispatcher({ authorize, execute });

    await expect(
      dispatcher.dispatch({
        target,
        context,
        capability: "plugin.transform",
        payload: { text: "synthetic" },
      }),
    ).resolves.toEqual({ text: "synthetic result" });

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "fixture/plugin",
        artifactSha256: "a".repeat(64),
        sessionId: "fixture-session",
        workspaceId: "fixture-workspace",
        runId: "fixture-run",
        capability: "plugin.transform",
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "fixture/plugin",
        artifactSha256: "a".repeat(64),
        hostGrantedCapabilities: ["memory.read"],
        payload: { text: "synthetic" },
      }),
      undefined,
    );
  });

  it("rejects capabilities absent from the host-owned plugin descriptor before asking for approval", async () => {
    const authorize = vi.fn(async () => true);
    const execute = vi.fn(async () => ({ result: "must not run" }));
    const dispatcher = new PluginExecutionDispatcher({ authorize, execute });

    await expect(
      dispatcher.dispatch({
        target,
        context,
        capability: "plugin.unlisted",
        payload: {},
      }),
    ).rejects.toThrow("Plugin capability is not present in the host catalog");

    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
