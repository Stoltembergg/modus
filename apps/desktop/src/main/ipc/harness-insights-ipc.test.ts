import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { HarnessInsightsQuery, HarnessInsightsResult } from "../../shared/contracts";
import { IPC_CHANNELS } from "./channels";
import { registerHarnessInsightsIpcHandlers } from "./harness-insights-ipc";

type CapturedIpcHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown;

function makeHarness() {
  const handlers = new Map<string, CapturedIpcHandler>();
  const service = {
    getHarnessInsights: vi.fn(
      (_input: HarnessInsightsQuery & { workspaceId: string }) =>
        ({
          workspaceId: "workspace-a",
          period: {
            since: "2026-01-01T00:00:00.000Z",
            until: "2026-01-02T00:00:00.000Z",
          },
          evidenceState: "unknown" as const,
          sampleCount: 0,
          limitations: [],
          insights: [],
        }) satisfies HarnessInsightsResult,
    ),
  };
  const sender = {
    mainFrame: { url: "file:///index.html" },
  } as unknown as IpcMainInvokeEvent["sender"];
  const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent;
  const ipcMain: Pick<IpcMain, "handle"> = {
    handle: (channel, listener) => {
      handlers.set(channel, (invokeEvent, input) => listener(invokeEvent, input));
    },
  };
  registerHarnessInsightsIpcHandlers(
    ipcMain,
    vi.fn(),
    service,
    (workspaceId) => workspaceId === "workspace-a",
    (candidate) => (candidate === sender ? "workspace-a" : undefined),
  );
  const handler = handlers.get(IPC_CHANNELS.harnessInsights);
  if (!handler) throw new Error("Harness Insights IPC handler missing.");
  return { event, handler, service };
}

describe("Harness Insights IPC", () => {
  it("validates selected workspace ownership and forwards only the bounded query", () => {
    const { event, handler, service } = makeHarness();
    const query = {
      since: "2026-01-01T00:00:00.000Z",
      limit: 40,
    };

    expect(handler(event, query)).toMatchObject({
      workspaceId: "workspace-a",
      evidenceState: "unknown",
    });
    expect(service.getHarnessInsights).toHaveBeenCalledWith({
      ...query,
      workspaceId: "workspace-a",
    });
  });

  it.each([
    { workspaceId: "workspace-foreign", since: "2026-01-01T00:00:00.000Z" },
    { workspaceId: "workspace-a", since: "not-a-date" },
    { workspaceId: "workspace-a", since: "2026-01-01T00:00:00.000Z", limit: 100_000 },
    { workspaceId: "workspace-a", cwd: "C:\\private", since: "2026-01-01T00:00:00.000Z" },
  ])("rejects invalid or renderer-directed query input %j", (input) => {
    const { event, handler, service } = makeHarness();

    expect(() => handler(event, input)).toThrow();
    expect(service.getHarnessInsights).not.toHaveBeenCalled();
  });

  it("requires an existing currently selected workspace", () => {
    const handlers = new Map<string, CapturedIpcHandler>();
    const service = { getHarnessInsights: vi.fn() };
    const ipcMain: Pick<IpcMain, "handle"> = {
      handle: (channel, listener) => {
        handlers.set(channel, (event, input) => listener(event, input));
      },
    };
    registerHarnessInsightsIpcHandlers(
      ipcMain,
      vi.fn(),
      service,
      () => false,
      () => "workspace-missing",
    );
    const handler = handlers.get(IPC_CHANNELS.harnessInsights);

    expect(() =>
      handler?.({ sender: {} } as unknown as IpcMainInvokeEvent, {
        since: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/workspace/i);
    expect(service.getHarnessInsights).not.toHaveBeenCalled();
  });
});
