import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeBrowserTab,
  engageAgentBrowser,
  navigateBrowser,
  releaseAgentBrowserControl,
  selectBrowserTab,
} from "./browser-service";

const { closeTab, emitBrowserEvent, resolveTab, tabsForWorkspace, selectTab, loadUrlBounded } =
  vi.hoisted(() => ({
    closeTab: vi.fn(),
    emitBrowserEvent: vi.fn(),
    resolveTab: vi.fn(),
    tabsForWorkspace: vi.fn(),
    selectTab: vi.fn(),
    loadUrlBounded: vi.fn(),
  }));

vi.mock("./tab-store", () => ({
  closeTab,
  emitBrowserEvent,
  resolveTab,
  tabsForWorkspace,
  selectTab,
}));

vi.mock("./cdp/lifecycle", () => ({ loadUrlBounded }));

function makeTab(id: string, workspaceId = "workspace-1") {
  return {
    workspaceId,
    info: { id },
    agentControlOwners: new Set<string>(),
    visual: { engage: vi.fn(), release: vi.fn() },
  };
}

describe("browser agent-control ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectTab.mockImplementation((_window: unknown, tabId: string) => ({ id: tabId }));
  });

  it("keeps a tab engaged until its last session owner releases", () => {
    const tab = makeTab("tab-1");
    resolveTab.mockReturnValue(tab);
    tabsForWorkspace.mockReturnValue([tab]);

    engageAgentBrowser({ tabId: "tab-1" }, "session-a");
    engageAgentBrowser({ tabId: "tab-1" }, "session-b");
    releaseAgentBrowserControl("workspace-1", "session-a");

    expect(tab.visual.engage).toHaveBeenCalledTimes(2);
    expect(tab.visual.release).not.toHaveBeenCalled();

    releaseAgentBrowserControl("workspace-1", "session-b");
    expect(tab.visual.release).toHaveBeenCalledTimes(1);
  });

  it("releases owners on separate tabs independently", () => {
    const first = makeTab("tab-1");
    const second = makeTab("tab-2");
    resolveTab.mockReturnValueOnce(first).mockReturnValueOnce(second);
    tabsForWorkspace.mockReturnValue([first, second]);

    engageAgentBrowser({ tabId: "tab-1" }, "session-a");
    engageAgentBrowser({ tabId: "tab-2" }, "session-b");
    releaseAgentBrowserControl("workspace-1", "session-a");

    expect(first.visual.release).toHaveBeenCalledTimes(1);
    expect(second.visual.release).not.toHaveBeenCalled();
  });

  it("handles releasing two owners of one tab in either order", () => {
    const tab = makeTab("tab-1");
    resolveTab.mockReturnValue(tab);
    tabsForWorkspace.mockReturnValue([tab]);

    engageAgentBrowser({ tabId: "tab-1" }, "session-a");
    engageAgentBrowser({ tabId: "tab-1" }, "session-b");
    releaseAgentBrowserControl("workspace-1", "session-b");
    expect(tab.visual.release).not.toHaveBeenCalled();
    releaseAgentBrowserControl("workspace-1", "session-a");

    expect(tab.visual.release).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate the same session owner", () => {
    const tab = makeTab("tab-1");
    resolveTab.mockReturnValue(tab);
    tabsForWorkspace.mockReturnValue([tab]);

    engageAgentBrowser({ tabId: "tab-1" }, "session-a");
    engageAgentBrowser({ tabId: "tab-1" }, "session-a");
    releaseAgentBrowserControl("workspace-1", "session-a");

    expect(tab.visual.engage).toHaveBeenCalledTimes(1);
    expect(tab.visual.release).toHaveBeenCalledTimes(1);
  });

  it("ignores ownership after a tab is closed", () => {
    const tab = makeTab("tab-1");
    resolveTab.mockReturnValue(tab);
    engageAgentBrowser({ tabId: "tab-1" }, "session-a");
    // Closing removes the tab from the workspace's live tab collection.
    tabsForWorkspace.mockReturnValue([]);

    releaseAgentBrowserControl("workspace-1", "session-a");

    expect(tab.visual.release).not.toHaveBeenCalled();
  });

  it("rejects an agent-initiated navigation without its session owner", async () => {
    await expect(
      navigateBrowser({
        workspaceId: "workspace-1",
        url: "https://example.test",
        agentInitiated: true,
      }),
    ).rejects.toThrow("agentSessionId is required");
  });

  it("rejects cross-workspace engagement and navigation before selecting or leasing the tab", async () => {
    const tab = makeTab("tab-b", "workspace-2");
    resolveTab.mockImplementation(({ tabId, workspaceId }) => {
      if (tabId !== tab.info.id) throw new Error("Browser tab not found");
      if (workspaceId && workspaceId !== tab.workspaceId) {
        throw new Error("Browser tab does not belong to this workspace.");
      }
      return tab;
    });

    engageAgentBrowser({ tabId: "tab-b", workspaceId: "workspace-1" }, "session-a");
    await expect(
      navigateBrowser({
        workspaceId: "workspace-1",
        tabId: "tab-b",
        url: "https://example.test",
        agentInitiated: true,
        agentSessionId: "session-a",
      }),
    ).rejects.toThrow("does not belong to this workspace");
    await expect(
      navigateBrowser({
        workspaceId: "workspace-1",
        tabId: "tab-b",
        newTab: true,
        url: "https://example.test",
      }),
    ).rejects.toThrow("does not belong to this workspace");

    expect(selectTab).not.toHaveBeenCalled();
    expect(loadUrlBounded).not.toHaveBeenCalled();
    expect(tab.agentControlOwners).toEqual(new Set());
    expect(tab.visual.engage).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace close before closing the tab", () => {
    resolveTab.mockImplementation(({ workspaceId }) => {
      if (workspaceId === "workspace-1") {
        throw new Error("Browser tab does not belong to this workspace.");
      }
    });

    expect(() => closeBrowserTab("tab-2", "workspace-1")).toThrow(
      "does not belong to this workspace",
    );

    expect(resolveTab).toHaveBeenCalledWith({ tabId: "tab-2", workspaceId: "workspace-1" });
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace select before selecting the tab", () => {
    resolveTab.mockImplementation(({ workspaceId }) => {
      if (workspaceId === "workspace-1") {
        throw new Error("Browser tab does not belong to this workspace.");
      }
    });

    expect(() => selectBrowserTab(undefined, "tab-2", "workspace-1")).toThrow(
      "does not belong to this workspace",
    );

    expect(resolveTab).toHaveBeenCalledWith({ tabId: "tab-2", workspaceId: "workspace-1" });
    expect(selectTab).not.toHaveBeenCalled();
  });
});
