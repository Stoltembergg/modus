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
  it("renders trailing collab statuses under the member reply", () => {
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
    expect(screen.getByTestId("group-collab-status").textContent).toContain("Handoff");
    expect(screen.getByTestId("group-collab-status").textContent).toContain("Builder");
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
