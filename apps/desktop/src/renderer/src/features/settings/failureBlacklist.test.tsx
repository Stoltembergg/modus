// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FailureBlacklistEntry } from "../../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../../shared/contracts";
import { SettingsSidebar } from "./SettingsPanel";
import {
  buildClearStrategyConfirmMessage,
  countEntriesForStrategy,
  FailureBlacklistSettingsPanel,
  FailureBlacklistView,
  failureBlacklistAvailable,
  formatBlacklistExpiryDate,
  formatBlacklistTtlRemaining,
  formatClearStrategyLabel,
} from "./sections/failure-blacklist";

const now = new Date("2026-09-29T12:00:00.000Z");

const entries: FailureBlacklistEntry[] = [
  {
    id: "entry-1",
    workspaceId: "workspace-1",
    signature: "sig-blind-retry",
    strategyCode: "blind_retry",
    hypothesisCode: "same_check_failed",
    hitCount: 3,
    firstSeenAt: "2026-09-20T12:00:00.000Z",
    lastSeenAt: "2026-09-28T12:00:00.000Z",
    expiresAt: "2026-10-12T12:00:00.000Z",
    status: "active",
    sourceRunId: "run-42",
  },
  {
    id: "entry-2",
    workspaceId: "workspace-1",
    signature: "sig-blind-retry-2",
    strategyCode: "blind_retry",
    hitCount: 1,
    firstSeenAt: "2026-09-29T09:00:00.000Z",
    lastSeenAt: "2026-09-29T09:00:00.000Z",
    expiresAt: "2026-10-01T12:00:00.000Z",
    status: "active",
  },
  {
    id: "entry-3",
    workspaceId: "workspace-1",
    signature: "sig-skip-verify",
    strategyCode: "skip_verify",
    hitCount: 1,
    firstSeenAt: "2026-09-29T10:00:00.000Z",
    lastSeenAt: "2026-09-29T10:00:00.000Z",
    expiresAt: "2026-09-29T14:30:00.000Z",
    status: "active",
  },
];

function renderView(
  state: Parameters<typeof FailureBlacklistView>[0]["state"],
  extras: Partial<Parameters<typeof FailureBlacklistView>[0]> = {},
): string {
  return renderToStaticMarkup(
    <FailureBlacklistView onRefresh={() => {}} state={state} {...extras} />,
  );
}

describe("failure blacklist helpers", () => {
  it("is available only for real project workspaces", () => {
    expect(failureBlacklistAvailable("workspace-1")).toBe(true);
    expect(failureBlacklistAvailable(CHATS_WORKSPACE_ID)).toBe(false);
    expect(failureBlacklistAvailable(undefined)).toBe(false);
    expect(failureBlacklistAvailable("")).toBe(false);
  });

  it("formats remaining TTL for days, hours, and minutes", () => {
    expect(formatBlacklistTtlRemaining("2026-10-12T12:00:00.000Z", now)).toBe("13d remaining");
    expect(formatBlacklistTtlRemaining("2026-09-29T14:30:00.000Z", now)).toBe("2h 30m remaining");
    expect(formatBlacklistTtlRemaining("2026-09-29T12:20:00.000Z", now)).toBe("20m remaining");
    expect(formatBlacklistTtlRemaining("2026-09-29T11:00:00.000Z", now)).toBe("Expired");
  });

  it("formats an absolute expiry date", () => {
    expect(formatBlacklistExpiryDate("2026-10-12T12:00:00.000Z")).toContain("2026");
    expect(formatBlacklistExpiryDate("not-a-date")).toBe("Date unavailable");
  });

  it("counts entries sharing a strategy_code and labels clear scope", () => {
    expect(countEntriesForStrategy(entries, "blind_retry")).toBe(2);
    expect(countEntriesForStrategy(entries, "skip_verify")).toBe(1);
    expect(formatClearStrategyLabel(2)).toBe("Clear strategy (2 entries)");
    expect(formatClearStrategyLabel(1)).toBe("Clear strategy (1 entry)");
    expect(buildClearStrategyConfirmMessage("blind_retry", 2)).toContain("blind_retry");
    expect(buildClearStrategyConfirmMessage("blind_retry", 2)).toContain("2 active entries");
  });
});

describe("FailureBlacklistView", () => {
  it("shows loading and an error with a retry action", () => {
    expect(renderView({ status: "loading" })).toContain("Loading failure blacklist…");
    const error = renderView({ status: "error" });
    expect(error).toContain("Failure blacklist could not be loaded.");
    expect(error).toContain("Try again");
  });

  it("asks for a workspace when unavailable", () => {
    const markup = renderView({ status: "unavailable" });
    expect(markup).toContain("Choose a workspace to manage the failure blacklist.");
    expect(markup).not.toContain("Try again");
  });

  it("renders soft-blacklist entries with TTL, expiry, and scoped clear labels", () => {
    const markup = renderToStaticMarkup(
      <FailureBlacklistView
        onClearAll={() => {}}
        onClearStrategy={() => {}}
        onRefresh={() => {}}
        state={{ status: "loaded", entries }}
      />,
    );

    expect(markup).toContain("Soft discourage only");
    expect(markup).toContain("never permanently block");
    expect(markup).toContain("3 active entries");
    expect(markup).toContain("blind_retry");
    expect(markup).toContain("Hypothesis · same_check_failed");
    expect(markup).toContain("3 hits");
    expect(markup).toContain("TTL ·");
    expect(markup).toContain("Expires ·");
    expect(markup).toContain("Source run · run-42");
    expect(markup).toContain("Clear strategy (2 entries)");
    expect(markup).toContain("Clear strategy (1 entry)");
    expect(markup).toContain("Clear all");
    expect(markup).toContain("not a hard permanent block");
  });

  it("shows clear error and disables clear controls while clearing", () => {
    const markup = renderToStaticMarkup(
      <FailureBlacklistView
        clearError='Could not clear strategy "blind_retry". Try again.'
        clearing
        onClearAll={() => {}}
        onClearStrategy={() => {}}
        onRefresh={() => {}}
        state={{ status: "loaded", entries }}
      />,
    );

    expect(markup).toContain("Could not clear strategy &quot;blind_retry&quot;. Try again.");
    expect(markup).toMatch(/Clear all[\s\S]*?disabled/);
    expect(markup).toMatch(
      /Clear strategy \(2 entries\)[\s\S]*?disabled|disabled[\s\S]*?Clear strategy \(2 entries\)/,
    );
  });

  it("shows an empty state without clear-all when there are no entries", () => {
    const markup = renderToStaticMarkup(
      <FailureBlacklistView
        onClearAll={() => {}}
        onClearStrategy={() => {}}
        onRefresh={() => {}}
        state={{ status: "loaded", entries: [] }}
      />,
    );

    expect(markup).toContain("No active soft-blacklist entries");
    expect(markup).toContain("0 active entries");
    expect(markup).not.toContain("Clear all");
    expect(markup).not.toContain("Clear strategy");
  });

  it("keeps Failure blacklist out of the Settings navigation", () => {
    const markup = renderToStaticMarkup(
      <SettingsSidebar
        activeSection="failure-blacklist"
        onBack={() => {}}
        onQueryChange={() => {}}
        onSectionChange={() => {}}
        query=""
      />,
    );

    expect(markup).not.toContain("Failure blacklist");
  });
});

describe("FailureBlacklistSettingsPanel clear flows", () => {
  let container: HTMLDivElement;
  let root: Root;
  let listMock: ReturnType<typeof vi.fn>;
  let clearMock: ReturnType<typeof vi.fn>;
  let confirmMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listMock = vi.fn(async () => entries);
    clearMock = vi.fn(async () => ({ ok: true }));
    confirmMock = vi.fn(() => true);
    vi.stubGlobal("modus", {
      harnessInsights: {
        listFailureBlacklist: listMock,
        clearFailureBlacklist: clearMock,
      },
    });
    Object.defineProperty(window, "confirm", {
      configurable: true,
      writable: true,
      value: confirmMock,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reloads the list after a successful clear-all", async () => {
    await act(async () => {
      root.render(<FailureBlacklistSettingsPanel workspaceId="workspace-1" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(listMock).toHaveBeenCalledTimes(1);
    const clearAll = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Clear all",
    );
    expect(clearAll).toBeTruthy();

    await act(async () => {
      clearAll?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(clearMock).toHaveBeenCalledWith({ workspaceId: "workspace-1", clearAll: true });
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Could not clear");
  });

  it("shows an error and re-enables buttons when clear fails", async () => {
    clearMock.mockRejectedValueOnce(new Error("boom"));

    await act(async () => {
      root.render(<FailureBlacklistSettingsPanel workspaceId="workspace-1" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const clearAll = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Clear all",
    );
    expect(clearAll).toBeTruthy();

    await act(async () => {
      clearAll?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Could not clear the failure blacklist. Try again.");
    const clearAllAfter = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Clear all",
    );
    expect(clearAllAfter?.disabled).toBe(false);
  });

  it("reloads the list after a successful clear-strategy and confirms scoped count", async () => {
    await act(async () => {
      root.render(<FailureBlacklistSettingsPanel workspaceId="workspace-1" />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(countEntriesForStrategy(entries, "blind_retry")).toBe(2);
    const clearStrategy = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Clear strategy (2 entries)",
    );
    expect(clearStrategy).toBeTruthy();

    await act(async () => {
      clearStrategy?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(confirmMock).toHaveBeenCalledWith(buildClearStrategyConfirmMessage("blind_retry", 2));
    expect(clearMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      strategyCode: "blind_retry",
    });
    expect(listMock).toHaveBeenCalledTimes(2);
  });
});
