// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GroupWorkingStatus, type WorkingMemberAvatar } from "./GroupWorkingStatus";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";

afterEach(() => cleanup());

const labels = new Map([
  ["s-lead", { title: "Planner" }],
  ["s-build", { title: "Builder" }],
]);

const avatars = new Map<string, WorkingMemberAvatar>([
  ["s-lead", { agentId: "a-lead", face: "happy", color: "violet", archived: false }],
  ["s-build", { agentId: "a-build", face: "wink", color: "sky", archived: false }],
]);

describe("GroupWorkingStatus", () => {
  it("renders nothing when no members are working", () => {
    const { container } = render(
      <GroupWorkingStatus avatars={avatars} labels={labels} rows={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows per-member Thinking / Queued rows while the group run is active", () => {
    const rows: GroupMemberWorkingRow[] = [
      { sessionId: "s-lead", mode: "running", phase: "Thinking" },
      { sessionId: "s-build", mode: "queued", phase: "Queued" },
    ];
    render(<GroupWorkingStatus avatars={avatars} labels={labels} rows={rows} />);
    const strip = screen.getByTestId("group-working-status");
    expect(strip).toBeTruthy();
    const items = screen.getAllByTestId("group-member-working");
    expect(items).toHaveLength(2);
    expect(items[0]?.dataset.mode).toBe("running");
    expect(items[0]?.dataset.phase).toBe("Thinking");
    expect(items[0]?.textContent).toContain("Planner");
    expect(items[0]?.textContent).toContain("Thinking");
    expect(items[1]?.dataset.mode).toBe("queued");
    expect(items[1]?.dataset.phase).toBe("Queued");
    expect(items[1]?.textContent).toContain("Builder");
  });
});
