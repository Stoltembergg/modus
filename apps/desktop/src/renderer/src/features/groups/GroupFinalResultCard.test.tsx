// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { formatGroupFinalResultCard } from "../../../../shared/group-result-card";
import { GroupMessageRow } from "./GroupMessageList";

afterEach(() => cleanup());

const labels = new Map([["s-lead", { title: "Planner" }]]);
const members = [{ sessionId: "s-lead", title: "Planner" }];

describe("GroupFinalResultCard in transcript", () => {
  it("renders Coordinator consolidation sections from a Lead message", () => {
    const body = formatGroupFinalResultCard({
      outcome: "Ship progress labels + final card",
      validations: ["unit tests green", "typecheck passed"],
      changedFiles: ["apps/desktop/src/shared/group-result-card.ts"],
      openItems: ["Live provider soak"],
    });
    const message: GroupMessage = {
      id: "m-final",
      groupId: "g-1",
      authorKind: "agent",
      authorSessionId: "s-lead",
      kind: "message",
      body: `All set.\n\n${body}`,
      mentions: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    render(<GroupMessageRow labels={labels} members={members} message={message} />);
    expect(screen.getByTestId("group-final-result-card")).toBeTruthy();
    expect(screen.getByTestId("group-final-result-outcome").textContent).toContain(
      "Ship progress labels + final card",
    );
    expect(screen.getByTestId("group-final-result-validations").textContent).toContain(
      "unit tests green",
    );
    expect(screen.getByTestId("group-final-result-changed-files").textContent).toContain(
      "group-result-card.ts",
    );
    expect(screen.getByTestId("group-final-result-open-items").textContent).toContain(
      "Live provider soak",
    );
    expect(screen.getByTestId("group-message").textContent).toContain("All set.");
  });
});
