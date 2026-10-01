// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { GroupMessageRow, splitTrailingCollabStatuses } from "./GroupMessageList";
import { GroupStageChip } from "./GroupRoomHeader";

afterEach(() => cleanup());

describe("splitTrailingCollabStatuses", () => {
  it("peels trailing Handoff / Agreed lines from prose", () => {
    expect(
      splitTrailingCollabStatuses("Plan ready.\nHandoff → @Builder · toggle\nAgreed · ship it"),
    ).toEqual({
      prose: "Plan ready.",
      statuses: [
        { kind: "handoff", targetName: "Builder", objective: "toggle" },
        { kind: "agreed", note: "ship it" },
      ],
    });
  });
});

describe("GroupMessageRow collab lines", () => {
  it("keeps user-facing prose and hides trailing orchestration handoffs", () => {
    const message: GroupMessage = {
      id: "m1",
      groupId: "g-1",
      authorKind: "agent",
      authorSessionId: "s-lead",
      kind: "message",
      body: "Breaking it down.\nHandoff → @Builder · toggle + tests",
      mentions: ["s-build"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    render(
      <GroupMessageRow
        labels={new Map([["s-lead", { title: "Planner" }]])}
        members={[
          { sessionId: "s-lead", title: "Planner" },
          { sessionId: "s-build", title: "Builder" },
        ]}
        message={message}
      />,
    );
    expect(screen.getByTestId("group-message").textContent).toContain("Breaking it down.");
    expect(screen.queryByTestId("group-collab-status")).toBeNull();
    expect(screen.getByTestId("group-message").textContent).not.toContain("Handoff →");
  });

  it("hides Owner/Objective packet fields from the main timeline", () => {
    const message: GroupMessage = {
      id: "m-ops",
      groupId: "g-1",
      authorKind: "agent",
      authorSessionId: "s-lead",
      kind: "message",
      body: [
        "Plan ready.",
        "Owner: @Builder",
        "Objective: wire the toggle",
        "Inputs: design.md",
        "Deliverable: PR",
        "Constraints: none",
        "Approval: human",
        "Handoff → @Builder · wire the toggle",
      ].join("\n"),
      mentions: ["s-build"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    render(
      <GroupMessageRow
        labels={new Map([["s-lead", { title: "Planner" }]])}
        members={[
          { sessionId: "s-lead", title: "Planner" },
          { sessionId: "s-build", title: "Builder" },
        ]}
        message={message}
      />,
    );
    const row = screen.getByTestId("group-message");
    expect(row.textContent).toContain("Plan ready.");
    expect(row.textContent).not.toContain("@Builder, wire the toggle");
    expect(row.textContent).not.toContain("Owner:");
    expect(row.textContent).not.toContain("Objective:");
    expect(row.textContent).not.toContain("Deliverable:");
    expect(row.textContent).not.toContain("Constraints:");
    expect(row.textContent).not.toContain("Approval:");
    expect(row.textContent).not.toContain("Inputs:");
  });

  it("hides orchestration-only handoff messages entirely", () => {
    const message: GroupMessage = {
      id: "m2",
      groupId: "g-1",
      authorKind: "agent",
      authorSessionId: "s-lead",
      kind: "message",
      body: "Handoff → @Builder · toggle",
      mentions: ["s-build"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const { container } = render(
      <GroupMessageRow
        labels={new Map([["s-lead", { title: "Planner" }]])}
        members={[
          { sessionId: "s-lead", title: "Planner" },
          { sessionId: "s-build", title: "Builder" },
        ]}
        message={message}
        onHandoffClick={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("group-collab-status")).toBeNull();
  });
});

describe("GroupStageChip", () => {
  it("shows Owner and stage", () => {
    render(
      <GroupStageChip
        labels={new Map([["s-build", { title: "Builder" }]])}
        stage={{ stage: "Handoff", ownerSessionId: "s-build", ownerName: "Builder" }}
      />,
    );
    const chip = screen.getByTestId("group-stage-chip");
    expect(chip.dataset.stage).toBe("Handoff");
    expect(chip.textContent).toContain("Owner:");
    expect(chip.textContent).toContain("Builder");
    expect(chip.textContent).toContain("Handoff");
  });
});
