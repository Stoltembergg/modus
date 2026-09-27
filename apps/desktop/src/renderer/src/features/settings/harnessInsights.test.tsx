import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHATS_WORKSPACE_ID, type HarnessInsightsResult } from "../../../../shared/contracts";
import {
  HarnessInsightsView,
  harnessInsightConfidenceLabel,
  harnessInsightsQueryForWorkspace,
  SettingsSidebar,
} from "./SettingsPanel";

const now = new Date("2026-09-27T12:00:00.000Z");
const result: HarnessInsightsResult = {
  workspaceId: "workspace-1",
  period: { since: "2026-08-28T12:00:00.000Z", until: "2026-09-27T12:00:00.000Z" },
  evidenceState: "known",
  sampleCount: 7,
  limitations: ["Only completed local runs are included."],
  insights: [
    {
      id: "insight-1",
      kind: "repeated_failures",
      claim: "Several runs repeated the same failing check.",
      recommendation: "Consider adding a focused check before the next edit.",
      hypothesis: true,
      period: { since: "2026-08-28T12:00:00.000Z", until: "2026-09-27T12:00:00.000Z" },
      sampleCount: 4,
      confidence: "medium",
      limitations: ["The sample covers only this workspace."],
      sourceRefs: [{ runId: "run-17", eventId: "event-52" }],
    },
  ],
};

function renderView(state: Parameters<typeof HarnessInsightsView>[0]["state"]): string {
  return renderToStaticMarkup(
    <HarnessInsightsView
      onPeriodChange={() => {}}
      onRefresh={() => {}}
      periodDays={30}
      state={state}
    />,
  );
}

describe("Harness Insights query", () => {
  it("builds a bounded local query for the selected workspace", () => {
    expect(harnessInsightsQueryForWorkspace("workspace-1", now)).toEqual({
      workspaceId: "workspace-1",
      since: "2026-08-28T12:00:00.000Z",
      limit: 50,
    });
  });

  it.each([
    [7, "2026-09-20T12:00:00.000Z"],
    [30, "2026-08-28T12:00:00.000Z"],
    [90, "2026-06-29T12:00:00.000Z"],
  ] as const)("uses the selected %i-day period in the since query", (days, since) => {
    expect(harnessInsightsQueryForWorkspace("workspace-1", now, days)).toEqual({
      workspaceId: "workspace-1",
      since,
      limit: 50,
    });
  });

  it("does not build a query for Chats, Inbox, or a missing workspace", () => {
    expect(harnessInsightsQueryForWorkspace(CHATS_WORKSPACE_ID, now)).toBeUndefined();
    expect(harnessInsightsQueryForWorkspace(undefined, now)).toBeUndefined();
    expect(harnessInsightsQueryForWorkspace("", now)).toBeUndefined();
  });

  it.each([
    ["low", "Low confidence"],
    ["medium", "Medium confidence"],
    ["high", "High confidence"],
  ] as const)("labels %s confidence", (confidence, expected) => {
    expect(harnessInsightConfidenceLabel(confidence)).toBe(expected);
  });
});

describe("HarnessInsightsView", () => {
  it("shows loading and an error with a retry action", () => {
    expect(renderView({ status: "loading" })).toContain("Loading local insights…");
    const error = renderView({ status: "error" });
    expect(error).toContain("Insights could not be loaded.");
    expect(error).toContain("Try again");
  });

  it("renders known findings as hypotheses with bounded context and source IDs", () => {
    const markup = renderView({ status: "loaded", result });

    expect(markup).toContain("Hypothesis");
    expect(markup).toContain("Several runs repeated the same failing check.");
    expect(markup).toContain("Consider adding a focused check before the next edit.");
    expect(markup).toContain("7 episodes sampled");
    expect(markup).toContain("Medium confidence");
    expect(markup).toContain("Period");
    expect(markup).toContain("Only completed local runs are included.");
    expect(markup).toContain("Run run-17");
    expect(markup).toContain("Event event-52");
    expect(markup).not.toContain("raw transcript");
    expect(markup).not.toContain("Apply");
  });

  it("shows unknown evidence as insufficient without rendering findings", () => {
    const firstInsight = result.insights.at(0);
    const markup = renderView({
      status: "loaded",
      result: {
        ...result,
        evidenceState: "unknown",
        sampleCount: 2,
        insights: firstInsight ? [firstInsight] : [],
      },
    });

    expect(markup).toContain("Not enough comparable activity yet");
    expect(markup).toContain("2 episodes sampled");
    expect(markup).not.toContain("Several runs repeated the same failing check.");
  });

  it("shows a known empty report without suggesting zero activity", () => {
    const markup = renderView({ status: "loaded", result: { ...result, insights: [] } });

    expect(markup).toContain("No findings for this period.");
    expect(markup).toContain("7 episodes sampled");
    expect(markup).not.toContain("0 runs");
  });

  it("asks the user to choose a workspace instead of displaying Chats insights", () => {
    const markup = renderView({ status: "unavailable" });

    expect(markup).toContain("Choose a workspace to view local insights.");
    expect(markup).not.toContain("Try again");
  });

  it("exposes an accessible period selector with the selected range", () => {
    const markup = renderToStaticMarkup(
      <HarnessInsightsView
        onPeriodChange={() => {}}
        onRefresh={() => {}}
        periodDays={7}
        state={{ status: "loaded", result }}
      />,
    );

    expect(markup).toContain('aria-label="Insights time window"');
    expect(markup).toContain("7 days");
    expect(markup).toContain("30 days");
    expect(markup).toContain("90 days");
  });

  it("shows one Harness Insights entry in the Settings navigation", () => {
    const markup = renderToStaticMarkup(
      <SettingsSidebar
        activeSection="harness-insights"
        onBack={() => {}}
        onQueryChange={() => {}}
        onSectionChange={() => {}}
        query=""
      />,
    );

    expect(markup.match(/Harness Insights/g)).toHaveLength(1);
  });
});
