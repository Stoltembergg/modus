// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupSuggestion } from "../../../../shared/group-work-state";
import { GroupProactivityControls } from "./GroupProactivityControls";

const suggestion: GroupSuggestion = {
  actionId: "action-1",
  version: 2,
  state: "suggested",
  task: { id: "task-1", title: "Add parser tests", stateVersion: 5 },
  source: {
    eventId: "event-1",
    executionId: "execution-old",
    kind: "task_assigned",
    sequence: 21,
  },
  reasonCode: "actionable-task-event",
  reason: "The assigned task is ready for its next step.",
  proposedTargetSessionId: "session-owner",
  candidateSessionIds: ["session-owner", "session-reviewer"],
  startNewExecution: false,
};

const subscribers = new Set<(event: unknown) => void>();
const api = {
  getProactivityMode: vi.fn(async () => "suggest" as const),
  setProactivityMode: vi.fn(async (_groupId: string, mode: "suggest" | "opt_in_auto") => mode),
  listSuggestions: vi.fn(async () => [suggestion]),
  resolveSuggestion: vi.fn(
    async (
      _actionId: string,
      _decision: "accept" | "discard",
      _expectedVersion: number,
      _targetSessionId?: string,
    ) => undefined,
  ),
  onEvent: vi.fn((listener: (event: unknown) => void) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  subscribers.clear();
  Object.assign(window, { modus: { group: api } });
});

afterEach(() => cleanup());

describe("GroupProactivityControls", () => {
  it("shows the next step, destination, reason, origin, and explicit suggestion actions", async () => {
    render(
      <GroupProactivityControls
        groupId="group-1"
        memberOptions={[
          { sessionId: "session-owner", label: "Builder" },
          { sessionId: "session-reviewer", label: "Reviewer" },
        ]}
      />,
    );

    expect(await screen.findByText("Add parser tests")).toBeTruthy();
    expect(screen.getByText(/assigned task is ready for its next step/).textContent).toContain(
      "assigned task is ready",
    );
    expect(
      within(screen.getByTestId("group-suggestion-destination")).getByText(/Builder/),
    ).toBeTruthy();
    expect(screen.getByText(/execution-old/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept suggestion" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard suggestion" })).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("Delegate to"), "session-reviewer");
    await userEvent.click(screen.getByRole("button", { name: "Accept suggestion" }));
    await waitFor(() =>
      expect(api.resolveSuggestion).toHaveBeenCalledWith(
        "action-1",
        "accept",
        2,
        "session-reviewer",
      ),
    );
    expect(api.resolveSuggestion.mock.calls[0]?.[0]).toBe("action-1");
  });

  it("restores the persisted mode after an IPC error and reloads suggestions on versioned events", async () => {
    api.getProactivityMode.mockResolvedValue("suggest");
    api.listSuggestions.mockResolvedValue([suggestion]);
    api.setProactivityMode.mockRejectedValueOnce(new Error("IPC failed"));
    render(<GroupProactivityControls groupId="group-1" memberOptions={[]} />);

    const toggle = await screen.findByRole("checkbox", { name: /automatic suggestions/i });
    await userEvent.click(toggle);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
    expect(api.setProactivityMode).toHaveBeenCalledWith("group-1", "opt_in_auto");

    const before = api.listSuggestions.mock.calls.length;
    for (const listener of subscribers) {
      listener({
        type: "group.suggestion-changed",
        groupId: "group-1",
        actionId: "action-1",
        version: 3,
      });
    }
    await waitFor(() => expect(api.listSuggestions.mock.calls.length).toBeGreaterThan(before));
  });

  it("labels an accepted suggestion as a new execution when its source chain ended", async () => {
    api.listSuggestions.mockResolvedValue([{ ...suggestion, startNewExecution: true }]);
    render(<GroupProactivityControls groupId="group-1" memberOptions={[]} />);
    expect(await screen.findByRole("button", { name: "Start new execution" })).toBeTruthy();
  });
});
