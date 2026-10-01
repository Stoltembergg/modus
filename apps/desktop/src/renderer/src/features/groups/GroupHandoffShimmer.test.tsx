// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { GroupMessageRow } from "./GroupMessageList";
import { GroupWorkingShimmer } from "./GroupWorkingShimmer";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";

afterEach(() => cleanup());

const labels = new Map([
  ["s-lead", { title: "Planner" }],
  ["s-build", { title: "Builder" }],
]);

const members = [
  { sessionId: "s-lead", title: "Planner" },
  { sessionId: "s-build", title: "Builder" },
];

describe("GroupMessageRow hides orchestration handoffs", () => {
  it("hides status-kind Planner→@Builder handoffs from the transcript", () => {
    const message: GroupMessage = {
      id: "m-h1",
      groupId: "g-1",
      authorKind: "agent",
      authorSessionId: "s-lead",
      kind: "status",
      body: "Handoff → @Builder · Implement the open task 'Block workspace symlink escapes'",
      mentions: ["s-build"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const { container } = render(
      <GroupMessageRow labels={labels} members={members} message={message} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("group-message")).toBeNull();
  });

  it("hides message-kind bodies that are only a structured handoff", () => {
    const message: GroupMessage = {
      id: "m-h2",
      groupId: "g-1",
      authorKind: "agent",
      authorSessionId: "s-lead",
      kind: "message",
      body: "Handoff → @Builder · Please continue and complete the assigned fix",
      mentions: ["s-build"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const { container } = render(
      <GroupMessageRow labels={labels} members={members} message={message} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("keeps user-facing prose and strips trailing handoff lines", () => {
    const message: GroupMessage = {
      id: "m-h3",
      groupId: "g-1",
      authorKind: "agent",
      authorSessionId: "s-lead",
      kind: "message",
      body: "I'll have Builder take the symlink fix next.\nHandoff → @Builder · fix symlink escapes",
      mentions: ["s-build"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    render(<GroupMessageRow labels={labels} members={members} message={message} />);
    const row = screen.getByTestId("group-message");
    expect(row.textContent).toContain("I'll have Builder take the symlink fix next.");
    expect(screen.queryByTestId("group-collab-status")).toBeNull();
    expect(row.textContent).not.toContain("Handoff →");
  });

  it("still shows Blocked / Agreed user-facing loop states", () => {
    const blocked: GroupMessage = {
      id: "m-b",
      groupId: "g-1",
      authorKind: "agent",
      authorSessionId: "s-build",
      kind: "status",
      body: "Blocked · missing design",
      mentions: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    render(<GroupMessageRow labels={labels} members={members} message={blocked} />);
    expect(screen.getByTestId("group-message").textContent).toContain("Blocked");
  });
});

describe("GroupWorkingShimmer", () => {
  it("renders named shimmer while an agent works without streamed text", () => {
    const rows: GroupMemberWorkingRow[] = [
      {
        sessionId: "s-build",
        mode: "running",
        live: {
          phase: "Thinking",
          thoughtPreview: "",
          tools: [],
          streamText: "",
          writingPreview: "",
          lastEventAt: Date.now(),
          collapsed: false,
          presence: {
            state: "thinking",
            label: "Thinking",
            startedAt: Date.now(),
            lastProgressAt: Date.now(),
          },
        },
      },
    ];
    render(<GroupWorkingShimmer labels={labels} locale="pt-BR" rows={rows} />);
    expect(screen.getByTestId("group-text-shimmer").textContent).toBe("Builder está a trabalhar…");
    expect(screen.getByTestId("group-working-shimmer")).toBeTruthy();
  });

  it("renders nothing when idle or when streaming is already visible", () => {
    const { rerender, container } = render(<GroupWorkingShimmer labels={labels} rows={[]} />);
    expect(container.firstChild).toBeNull();
    rerender(
      <GroupWorkingShimmer
        labels={labels}
        rows={[
          {
            sessionId: "s-build",
            mode: "running",
            live: {
              phase: "Writing",
              thoughtPreview: "",
              tools: [],
              streamText: "Applying the patch",
              writingPreview: "Applying the patch",
              lastEventAt: Date.now(),
              collapsed: false,
              presence: {
                state: "writing",
                label: "Writing",
                startedAt: Date.now(),
                lastProgressAt: Date.now(),
              },
            },
          },
        ]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
