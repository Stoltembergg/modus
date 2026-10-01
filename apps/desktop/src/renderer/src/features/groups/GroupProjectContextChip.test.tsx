// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupActivityPanel } from "./GroupActivityPanel";
import { GroupProjectContextChip } from "./GroupProjectContextChip";

afterEach(() => cleanup());

describe("GroupProjectContextChip", () => {
  it("renders Mapping project… while mapping", () => {
    render(<GroupProjectContextChip status="mapping" />);
    expect(screen.getByTestId("group-project-context-chip").textContent).toContain(
      "Mapping project…",
    );
  });

  it("renders compact Ready / Updating / Needs refresh", () => {
    const { rerender, container } = render(<GroupProjectContextChip status="ready" />);
    expect(within(container).getByTestId("group-project-context-chip").textContent).toContain(
      "Project context · Ready",
    );
    rerender(<GroupProjectContextChip status="updating" />);
    expect(within(container).getByTestId("group-project-context-chip").textContent).toContain(
      "Project context · Updating",
    );
    rerender(<GroupProjectContextChip status="needs_refresh" />);
    expect(within(container).getByTestId("group-project-context-chip").textContent).toContain(
      "Project context · Needs refresh",
    );
  });
});

describe("GroupActivityPanel project context", () => {
  beforeEach(() => {
    Object.assign(window, {
      modus: {
        group: {
          listDecisions: vi.fn(async () => []),
          deleteDecision: vi.fn(async () => undefined),
          onEvent: vi.fn(() => () => undefined),
        },
      },
    });
  });

  it("shows Setup diagnostics under Activity", () => {
    render(
      <GroupActivityPanel
        coordinating={false}
        groupId="g1"
        hasLead={false}
        labels={new Map()}
        onCancelled={() => undefined}
        projectContext={{
          workspaceId: "ws1",
          status: "ready",
          fingerprint: "abcdef0123456789ffff",
          edgeCount: 4,
          codegraphState: "ready",
          updatedAt: "2026-10-01T00:00:00.000Z",
        }}
        stage={undefined}
        tasks={[]}
        workingRows={[]}
      />,
    );
    const section = screen.getByTestId("group-activity-project-context");
    expect(section.textContent).toContain("Fingerprint: abcdef012345");
    expect(section.textContent).toContain("CodeGraph: ready");
  });
});
