import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeTab, createTab, getTab, resolveTab } from "./tab-store";

const mocks = vi.hoisted(() => ({
  webContents: undefined as unknown as Record<string, unknown>,
  visualDispose: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  WebContentsView: class {
    webContents = mocks.webContents;
    setBackgroundColor() {}
  },
}));
vi.mock("./security", () => ({
  DEFAULT_URL: "about:blank",
  isNavigableUrl: () => true,
  normalizeBrowserUrl: (url: string) => url,
  workspacePartition: () => "persist:test",
  applySessionSecurity: vi.fn(),
}));
vi.mock("./cdp/session", () => ({
  CdpSession: class {
    attach = vi.fn(async () => {});
    detach = vi.fn();
  },
}));
vi.mock("./cdp/network", () => ({
  NetworkRecorder: class {
    bind = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock("./cdp/lifecycle", () => ({
  DialogController: class {
    bind = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock("./cdp/snapshot", () => ({
  SnapshotStore: class {
    invalidate = vi.fn();
  },
}));
vi.mock("./agent-visualizer", () => ({
  AgentVisualizer: class {
    engage = vi.fn();
    release = vi.fn();
    dispose = mocks.visualDispose;
    hideDuring = vi.fn();
  },
}));
vi.mock("./design-mode", () => ({
  DesignModeController: class {
    isEnabled = false;
    dispose = vi.fn();
    setEnabled = vi.fn();
  },
}));
vi.mock("./browser-recents-store", () => ({ upsertBrowserRecent: vi.fn() }));
vi.mock("./view-capture", () => ({
  captureViewRect: vi.fn(),
  clampViewportRect: vi.fn(),
  growViewportRect: vi.fn(),
}));
vi.mock("./view-host", () => ({ detachView: vi.fn() }));

describe("tab-store close lifecycle", () => {
  beforeEach(() => {
    mocks.webContents = {
      getURL: vi.fn(() => "about:blank"),
      getTitle: vi.fn(() => ""),
      isLoading: vi.fn(() => false),
      navigationHistory: {
        canGoBack: vi.fn(() => false),
        canGoForward: vi.fn(() => false),
      },
      isDevToolsOpened: vi.fn(() => false),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      close: vi.fn(),
      session: {},
    };
    mocks.visualDispose.mockClear();
  });

  it("does not resolve a tab outside the requested workspace", () => {
    const workspaceOne = createTab(undefined, { workspaceId: "workspace-1" });
    const workspaceTwo = createTab(undefined, { workspaceId: "workspace-2" });

    expect(resolveTab({ tabId: workspaceOne.id, workspaceId: "workspace-1" }).info.id).toBe(
      workspaceOne.id,
    );
    expect(() => resolveTab({ tabId: workspaceTwo.id, workspaceId: "workspace-1" })).toThrow(
      "does not belong to workspace workspace-1",
    );

    closeTab(workspaceOne.id);
    closeTab(workspaceTwo.id);
  });

  it("clears agent owners and disposes/removes the tab during real close", () => {
    const info = createTab(undefined, { workspaceId: "workspace-close" });
    const tab = getTab(info.id);
    expect(tab).toBeDefined();
    tab?.agentControlOwners.add("session-a");
    tab?.agentControlOwners.add("session-b");

    closeTab(info.id);

    expect(tab?.agentControlOwners.size).toBe(0);
    expect(getTab(info.id)).toBeUndefined();
    expect(mocks.visualDispose).toHaveBeenCalledTimes(1);
    expect(mocks.webContents.close).toHaveBeenCalledTimes(1);
  });
});
