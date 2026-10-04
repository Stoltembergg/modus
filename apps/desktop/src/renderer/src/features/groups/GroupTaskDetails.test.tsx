// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeGroupErrorMessage } from "../../../../shared/group-errors";
import { GroupTaskDetails } from "./GroupTaskDetails";

const owner = { title: "Builder" };
const reviewer = { title: "Reviewer" };

function detail(overrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: "task-1",
      groupId: "group-1",
      title: "Finish parser",
      description: "Keep compatibility.",
      status: "blocked",
      stateVersion: 3,
      kind: "code",
      priority: "high",
      stage: "verify",
      blockedReason: "Waiting on parser fixtures",
      dependencyIds: ["task-dependency"],
      ownerSessionId: "session-owner",
      reviewerSessionId: "session-reviewer",
      criteria: [{ id: "unit", description: "Unit tests pass", requiredCheckKinds: ["tests"] }],
      verificationPolicy: { mode: "required", requireReview: true },
      evidenceRefs: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    dependencies: [{ id: "task-dependency", title: "Parser fixtures", status: "in_progress" }],
    dependencyOptions: [
      { id: "task-dependency", title: "Parser fixtures", status: "in_progress" },
      { id: "task-design", title: "Design assets", status: "open" },
    ],
    omittedDependencyOptionCount: 0,
    blocker: { kind: "dependency", reason: "Parser fixtures must finish first." },
    source: { availability: "available" },
    criteria: [
      {
        criterionId: "unit",
        description: "Unit tests pass",
        requiredCheckKinds: ["tests"],
        status: "passed",
        evidence: [
          {
            status: "passed",
            checkName: "tests",
            sessionId: "session-owner",
            runId: "run-qa-1",
            executionId: "execution-qa-1",
          },
        ],
      },
    ],
    review: { status: "pending" },
    ...overrides,
  };
}

let listeners: Array<(event: unknown) => void>;
let unsubscriptions: ReturnType<typeof vi.fn>[];
let getDetails: ReturnType<typeof vi.fn>;
let listTransitions: ReturnType<typeof vi.fn>;
let updateTask: ReturnType<typeof vi.fn>;

function installGroupApi() {
  getDetails = vi.fn(async () => detail());
  listTransitions = vi.fn(async () => []);
  updateTask = vi.fn(async () => ({ ...detail().task, stateVersion: 4 }));
  unsubscriptions = [];
  Object.assign(window, {
    modus: {
      group: {
        getTaskDetails: getDetails,
        listTaskTransitions: listTransitions,
        updateTask,
        onEvent: vi.fn((listener: (event: unknown) => void) => {
          listeners.push(listener);
          const unsubscribe = vi.fn(() => {
            listeners = listeners.filter((item) => item !== listener);
          });
          unsubscriptions.push(unsubscribe);
          return unsubscribe;
        }),
      },
    },
  });
}

beforeEach(() => {
  listeners = [];
  installGroupApi();
});

afterEach(() => cleanup());

describe("GroupTaskDetails", () => {
  it("shows_blocker_dependencies_and_qa", async () => {
    const onOpenSession = vi.fn();
    render(
      <GroupTaskDetails
        groupId="group-1"
        taskId="task-1"
        labels={
          new Map([
            ["session-owner", owner],
            ["session-reviewer", reviewer],
          ])
        }
        onOpenSession={onOpenSession}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("Finish parser")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText("High priority")).toBeTruthy();
    expect(screen.getByText("Verification")).toBeTruthy();
    expect(screen.getByText("Builder")).toBeTruthy();
    expect(screen.getAllByText("Reviewer").length).toBeGreaterThan(0);
    expect(screen.getByText("Parser fixtures must finish first.")).toBeTruthy();
    expect(screen.getByText("Unit tests pass")).toBeTruthy();
    expect(screen.getByText("Passed")).toBeTruthy();
    const openQA = screen.getByRole("button", { name: "Open QA session" });
    await userEvent.click(openQA);
    expect(onOpenSession).toHaveBeenCalledWith("session-owner", "run-qa-1");
    expect(screen.queryByText("run-qa-1")).toBeNull();
  });

  it("stale_response_does_not_replace_newer_task", async () => {
    let resolveInitial!: (value: ReturnType<typeof detail>) => void;
    let resolveNewer!: (value: ReturnType<typeof detail>) => void;
    getDetails
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }) as never,
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNewer = resolve;
          }) as never,
      );
    render(
      <GroupTaskDetails groupId="group-1" taskId="task-1" labels={new Map()} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(listeners).toHaveLength(1));
    act(() =>
      listeners[0]?.({
        type: "group.task-changed",
        groupId: "group-1",
        taskId: "task-1",
        stateVersion: 5,
      }),
    );
    await waitFor(() => expect(getDetails).toHaveBeenCalledTimes(2));
    resolveNewer(detail({ task: { ...detail().task, title: "Updated task", stateVersion: 5 } }));
    expect(await screen.findByText("Updated task")).toBeTruthy();
    resolveInitial(detail({ task: { ...detail().task, title: "Old task", stateVersion: 4 } }));
    await act(async () => Promise.resolve());
    expect(screen.queryByText("Old task")).toBeNull();
    expect(screen.getByText("Updated task")).toBeTruthy();
  });

  it("removed_evidence_source_is_visible", async () => {
    getDetails.mockResolvedValue(
      detail({
        source: { availability: "missing", reason: "The task source folder was removed." },
        criteria: [
          {
            criterionId: "unit",
            description: "Unit tests pass",
            requiredCheckKinds: ["tests"],
            status: "unavailable",
            evidence: [{ status: "unavailable", reason: "The QA event was removed." }],
          },
        ],
        review: { status: "unavailable" },
      }),
    );
    render(
      <GroupTaskDetails groupId="group-1" taskId="task-1" labels={new Map()} onClose={vi.fn()} />,
    );
    expect(await screen.findByText("The task source folder was removed.")).toBeTruthy();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText("Passed")).toBeNull();
  });

  it("shows user confirmation separately from a passing QA criterion", async () => {
    getDetails.mockResolvedValue(
      detail({
        criteria: [
          {
            criterionId: "unit",
            description: "Unit tests pass",
            requiredCheckKinds: ["tests"],
            status: "missing",
            evidence: [
              {
                status: "user_confirmed",
                checkName: "tests",
                sessionId: "session-owner",
                runId: "run-confirmation",
              },
            ],
          },
        ],
        gate: { satisfied: false, reasonCodes: ["criterion-unverified"] },
      }),
    );
    render(
      <GroupTaskDetails groupId="group-1" taskId="task-1" labels={new Map()} onClose={vi.fn()} />,
    );
    expect(await screen.findByText("User confirmed (not QA)", { exact: false })).toBeTruthy();
    expect(screen.getByText("Missing")).toBeTruthy();
    expect(screen.queryByText("Passed")).toBeNull();
  });

  it("edits criteria, dependencies, and verification policy with the loaded version", async () => {
    render(
      <GroupTaskDetails
        groupId="group-1"
        taskId="task-1"
        labels={
          new Map([
            ["session-owner", owner],
            ["session-reviewer", reviewer],
          ])
        }
        onClose={vi.fn()}
      />,
    );
    await screen.findByText("Finish parser");
    await userEvent.click(screen.getByRole("button", { name: "Edit task" }));
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Parser implementation");
    await userEvent.click(screen.getByRole("checkbox", { name: /Design assets/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: "tests" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "build" }));
    await userEvent.selectOptions(screen.getByLabelText("Mode"), "required");
    await userEvent.click(screen.getByRole("button", { name: "Save task" }));

    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce());
    expect(updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        title: "Parser implementation",
        dependencyIds: ["task-dependency", "task-design"],
        criteria: [{ id: "unit", description: "Unit tests pass", requiredCheckKinds: ["build"] }],
        verificationPolicy: { mode: "required", requireReview: true },
      }),
      3,
    );
    const submittedDraft = updateTask.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(submittedDraft).not.toHaveProperty("ownerSessionId");
    expect(submittedDraft).not.toHaveProperty("evidenceRefs");
    expect(submittedDraft).not.toHaveProperty("review");
  });

  it("preserves an in-progress edit and submits its original version after an external update", async () => {
    render(
      <GroupTaskDetails groupId="group-1" taskId="task-1" labels={new Map()} onClose={vi.fn()} />,
    );
    await screen.findByText("Finish parser");
    await userEvent.click(screen.getByRole("button", { name: "Edit task" }));
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    await userEvent.clear(title);
    await userEvent.type(title, "My local edit");

    getDetails.mockResolvedValueOnce(
      detail({
        task: { ...detail().task, title: "External update", stateVersion: 4 },
      }),
    );
    act(() =>
      listeners[0]?.({
        type: "group.task-changed",
        groupId: "group-1",
        taskId: "task-1",
        stateVersion: 4,
      }),
    );
    await waitFor(() => expect(getDetails).toHaveBeenCalledTimes(2));
    expect(title.value).toBe("My local edit");

    updateTask.mockRejectedValueOnce(
      new Error(
        `Error invoking remote method 'group:update-task': Error: ${encodeGroupErrorMessage("stale-task", "version changed")}`,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce());
    expect(updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        title: "My local edit",
      }),
      3,
    );
    expect(await screen.findByText("The task changed. Refresh it and try again.")).toBeTruthy();
    expect(title.value).toBe("My local edit");
  });

  it("clears detail and unsubscribes when the group changes", async () => {
    const view = render(
      <GroupTaskDetails groupId="group-1" taskId="task-1" labels={new Map()} onClose={vi.fn()} />,
    );
    expect(await screen.findByText("Finish parser")).toBeTruthy();
    const previousListener = listeners[0];
    getDetails.mockResolvedValueOnce(
      detail({
        task: { ...detail().task, id: "task-2", groupId: "group-2", title: "Second group task" },
      }),
    );
    view.rerender(
      <GroupTaskDetails groupId="group-2" taskId="task-2" labels={new Map()} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(unsubscriptions[0]).toHaveBeenCalledOnce());
    expect(await screen.findByText("Second group task")).toBeTruthy();
    expect(screen.queryByText("Finish parser")).toBeNull();
    act(() =>
      previousListener?.({
        type: "group.task-changed",
        groupId: "group-1",
        taskId: "task-1",
        stateVersion: 9,
      }),
    );
    expect(getDetails).toHaveBeenCalledWith("group-2", "task-2");
  });
});
