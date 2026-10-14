import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentEventHub } from "../agent/agentEventHub";
import { Inspector } from "./Inspector";

describe("Inspector tab layout", () => {
  it("gives the tab panel a bounded flex viewport and keeps the toolbar transparent", () => {
    const markup = renderToStaticMarkup(
      <Inspector
        activeWorkspace={null}
        contextUsageBySession={{}}
        defaultModel=""
        hub={{} as AgentEventHub}
        maxWidth={900}
        models={[]}
        onModelChange={() => undefined}
        onModelConfigChange={() => undefined}
        onOpenChange={() => undefined}
        onOpenReview={() => undefined}
        onOpenSubagent={() => undefined}
        onPlanUpdated={() => undefined}
        onSelectSubagent={() => undefined}
        onSessionsChanged={() => undefined}
        onWidthChange={() => undefined}
        open
        securityState={null}
        sessions={[]}
        tab="subagents"
        width={360}
      />,
    );

    const panelClass =
      markup.match(/class="([^"]*inspector-tab-panel[^"]*)"/)?.[1]?.split(" ") ?? [];
    expect(panelClass).toContain("flex");
    expect(panelClass).toContain("flex-col");
    expect(panelClass).toContain("min-h-0");
    expect(markup).toMatch(/class="[^"]*toolbar-row[^"]*bg-transparent/);
    expect(markup).not.toMatch(/class="[^"]*toolbar-row[^"]*bg-canvas/);
  });
});
