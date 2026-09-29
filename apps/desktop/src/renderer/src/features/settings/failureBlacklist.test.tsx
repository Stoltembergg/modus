import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FailureBlacklistEntry } from "../../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../../shared/contracts";
import { SettingsSidebar } from "./SettingsPanel";
import {
  FailureBlacklistView,
  failureBlacklistAvailable,
  formatBlacklistExpiryDate,
  formatBlacklistTtlRemaining,
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
    signature: "sig-skip-verify",
    strategyCode: "skip_verify",
    hitCount: 1,
    firstSeenAt: "2026-09-29T10:00:00.000Z",
    lastSeenAt: "2026-09-29T10:00:00.000Z",
    expiresAt: "2026-09-29T14:30:00.000Z",
    status: "active",
  },
];

function renderView(state: Parameters<typeof FailureBlacklistView>[0]["state"]): string {
  return renderToStaticMarkup(<FailureBlacklistView onRefresh={() => {}} state={state} />);
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

  it("renders soft-blacklist entries with TTL, expiry, and per-strategy clear", () => {
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
    expect(markup).toContain("2 active entries");
    expect(markup).toContain("blind_retry");
    expect(markup).toContain("Hypothesis · same_check_failed");
    expect(markup).toContain("3 hits");
    expect(markup).toContain("TTL ·");
    expect(markup).toContain("Expires ·");
    expect(markup).toContain("Source run · run-42");
    expect(markup).toContain("Clear strategy");
    expect(markup).toContain("Clear all");
    expect(markup).toContain('aria-label="Clear strategy blind_retry"');
    expect(markup).toContain("not a hard permanent block");
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

  it("shows one Failure blacklist entry in the Settings navigation", () => {
    const markup = renderToStaticMarkup(
      <SettingsSidebar
        activeSection="failure-blacklist"
        onBack={() => {}}
        onQueryChange={() => {}}
        onSectionChange={() => {}}
        query=""
      />,
    );

    expect(markup.match(/Failure blacklist/g)).toHaveLength(1);
  });
});
